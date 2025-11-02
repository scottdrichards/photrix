import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import sharp from "sharp";
import type { Representation, AllMetadata } from "../apiSpecification.js";
import { FolderIndexer } from "./folderIndexer.js";
import type { FullFileRecord } from "./models.js";
import { isFullFileRecord } from "./models.js";
import heicConvert from "heic-convert";
import { mimeTypeForFilename } from "./mimeTypes.js";

export type MediaType = "photo" | "video";

export type VideoThumbnailExtractor = (absolutePath: string) => Promise<Buffer>;

export interface FileServiceOptions {
  videoThumbnailExtractor?: VideoThumbnailExtractor;
}

export interface FileRetrievalOptions<T extends MediaType = "photo"> {
  representation?: Representation<T>;
  mediaType?: T;
}

export interface FileRetrievalResult {
  data: ArrayBuffer;
  contentType: string;
  metadata?: Partial<AllMetadata>;
}

export interface OriginalFileInfo {
  absolutePath: string;
  contentType: string;
  size: number;
}

export class FileService {
  private readonly videoThumbnailExtractor: VideoThumbnailExtractor;

  constructor(
    private readonly indexer: FolderIndexer,
    options: FileServiceOptions = {},
  ) {
    this.videoThumbnailExtractor =
      options.videoThumbnailExtractor ?? defaultVideoThumbnailExtractor;
  }

  async getFileByFilename(
    filename: string,
    options?: FileRetrievalOptions,
  ): Promise<FileRetrievalResult> {
    const query = await this.indexer.queryFiles(
      { filename: [filename] },
      { pageSize: 1 },
    );
    const match = query.items[0];
    if (!match) {
      throw new Error(`File with name ${filename} not found in index`);
    }
    return this.getFile(match.path, options);
  }

  async getFile(
    relativePath: string,
    options?: FileRetrievalOptions,
  ): Promise<FileRetrievalResult> {
    const record = this.indexer.getIndexedFile(relativePath);
    if (!record) {
      throw new Error(`File ${relativePath} is not currently indexed`);
    }

    // Ensure we have a fully indexed record
    if (!isFullFileRecord(record)) {
      throw new Error(`File ${relativePath} is still being indexed`);
    }

    const absolutePath = this.resolveAbsolutePath(relativePath);
    const mediaType = getMediaType(record, options?.mediaType);
    const representation = (options?.representation ?? {
      type: "original",
    }) as Representation<MediaType>;

    switch (representation.type) {
      case "metadata": {
        const selected = selectMetadata(record, representation.metadataKeys);
        const buffer = Buffer.from(JSON.stringify(selected), "utf8");
        return {
          data: bufferToArrayBuffer(buffer),
          contentType: "application/json",
          metadata: selected,
        };
      }
      case "webSafe": {
        const preview = await this.loadPreviewBuffer(record, absolutePath, mediaType);
        const buffer = await convertToWebSafe(preview);
        return {
          data: bufferToArrayBuffer(buffer),
          contentType: "image/jpeg",
        };
      }
      case "resize": {
        const preview = await this.loadPreviewBuffer(record, absolutePath, mediaType);
        const buffer = await resizeImage(
          preview,
          representation.maxWidth,
          representation.maxHeight,
        );
        return {
          data: bufferToArrayBuffer(buffer),
          contentType: "image/webp",
        };
      }
      case "original":
      default: {
        const buffer = await fs.readFile(absolutePath);
        const contentType = inferContentType(record) ?? "application/octet-stream";
        return {
          data: bufferToArrayBuffer(buffer),
          contentType,
        };
      }
    }
  }

  private resolveAbsolutePath(relativePath: string): string {
    const root = this.indexer.getRootDirectory();
    const normalized = relativePath.split("/").join(path.sep);
    const absolute = path.resolve(root, normalized);
    if (!absolute.startsWith(root)) {
      throw new Error(`Resolved path ${absolute} is outside of index root ${root}`);
    }
    return absolute;
  }

  private async loadPreviewBuffer(
    record: FullFileRecord,
    absolutePath: string,
    mediaType: MediaType,
  ): Promise<Buffer> {
    if (mediaType === "video") {
      try {
        const frame = await this.videoThumbnailExtractor(absolutePath);
        if (!frame || frame.length === 0) {
          throw new Error("Video thumbnail extractor returned empty buffer");
        }
        return frame;
      } catch (error) {
        console.warn(
          `[fileService] Failed to generate video thumbnail for ${record.path}; using fallback`,
          error,
        );
        return await getFallbackVideoThumbnail();
      }
    }

    const source = await fs.readFile(absolutePath);
    return ensureJpegBuffer(record, source);
  }

  async getOriginalFileInfo(relativePath: string): Promise<OriginalFileInfo> {
    const record = this.indexer.getIndexedFile(relativePath);
    if (!record) {
      throw new Error(`File ${relativePath} is not currently indexed`);
    }
    if (!isFullFileRecord(record)) {
      throw new Error(`File ${relativePath} is still being indexed`);
    }

    const absolutePath = this.resolveAbsolutePath(relativePath);
    const stats = await fs.stat(absolutePath);
    const contentType = inferContentType(record) ?? "application/octet-stream";

    return {
      absolutePath,
      contentType,
      size: stats.size,
    };
  }
}

const inferContentType = (record: FullFileRecord): string | null => {
  const guessed = mimeTypeForFilename(record.name);
  return record.metadata.mimeType ?? record.mimeType ?? guessed ?? null;
};

const selectMetadata = (
  record: FullFileRecord,
  keys: Array<keyof AllMetadata>,
): Partial<AllMetadata> => {
  const base: Partial<AllMetadata> = {
    size: record.metadata.size ?? record.size,
    mimeType: record.metadata.mimeType ?? record.mimeType ?? undefined,
    dateCreated: record.metadata.dateCreated ?? record.dateCreated,
  };
  const full: Partial<AllMetadata> = {
    ...base,
    ...record.metadata,
  };
  const result: Partial<AllMetadata> = {};
  for (const key of keys) {
    (result as Record<string, unknown>)[key as string] = full[key];
  }
  return result;
};

const convertToWebSafe = async (baseBuffer: Buffer): Promise<Buffer> => {
  return sharp(baseBuffer).rotate().jpeg({ quality: 85 }).toBuffer();
};

const resizeImage = async (
  baseBuffer: Buffer,
  maxWidth?: number,
  maxHeight?: number,
): Promise<Buffer> => {
  const transformer = sharp(baseBuffer).rotate();
  if (maxWidth || maxHeight) {
    transformer.resize({
      width: maxWidth,
      height: maxHeight,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  return transformer.webp({ quality: 85 }).toBuffer();
};

const bufferToArrayBuffer = (buffer: Buffer): ArrayBuffer => {
  const arrayBuffer = new ArrayBuffer(buffer.length);
  const view = new Uint8Array(arrayBuffer);
  view.set(buffer);
  return arrayBuffer;
};

const ensureJpegBuffer = async (
  record: FullFileRecord,
  source: Buffer,
): Promise<Buffer> => {
  if (isHeic(record)) {
    const converted = await heicConvert({
      buffer: source as unknown as ArrayBuffer,
      format: "JPEG",
      quality: 0.85,
    });
    return Buffer.from(converted);
  }
  return source;
};

const isHeic = (record: FullFileRecord): boolean => {
  const mime = (record.metadata.mimeType ?? record.mimeType ?? "").toLowerCase();
  if (mime === "image/heic" || mime === "image/heif") {
    return true;
  }
  return record.name.toLowerCase().endsWith(".heic");
};

const getMediaType = (record: FullFileRecord, override?: MediaType): MediaType => {
  if (override) {
    return override;
  }

  const mime = (record.metadata.mimeType ?? record.mimeType ?? "").toLowerCase();
  if (mime.startsWith("video/")) {
    return "video";
  }

  const name = record.name.toLowerCase();
  if (VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return "video";
  }

  return "photo";
};

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".wmv"];

const getFallbackVideoThumbnail = (() => {
  let cached: Promise<Buffer> | null = null;
  return async () => {
    if (!cached) {
      cached = sharp({
        create: {
          width: 640,
          height: 360,
          channels: 3,
          background: { r: 32, g: 32, b: 36 },
        },
      })
        .jpeg({ quality: 80 })
        .toBuffer();
    }
    const buffer = await cached;
    return Buffer.from(buffer);
  };
})();

const defaultVideoThumbnailExtractor: VideoThumbnailExtractor = (absolutePath) => {
  return new Promise<Buffer>((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "0.5",
      "-i",
      absolutePath,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-",
    ];

    const ffmpeg = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let stderr = "";

    ffmpeg.stdout.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("error", (error) => {
      reject(error);
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(stderr.trim() || `ffmpeg exited with code ${code ?? "unknown"}`),
        );
        return;
      }
      if (chunks.length === 0) {
        reject(new Error("ffmpeg did not produce any output"));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
};
