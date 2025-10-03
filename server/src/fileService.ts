import { promises as fs } from "node:fs";
import path from "node:path";
import { lookup as lookupMimeType } from "mime-types";
import sharp from "sharp";
import type { Representation, AllMetadata } from "../apiSpecification.js";
import { FolderIndexer } from "./folderIndexer.js";
import type { IndexedFileRecord } from "./models.js";
import heicConvert from "heic-convert";

export type MediaType = "photo" | "video";

export interface FileRetrievalOptions<T extends MediaType = "photo"> {
  representation?: Representation<T>;
  mediaType?: T;
}

export interface FileRetrievalResult {
  data: ArrayBuffer;
  contentType: string;
  metadata?: Partial<AllMetadata>;
}

export class FileService {
  constructor(private readonly indexer: FolderIndexer) {}

  async getFileByFilename(
    filename: string,
    options?: FileRetrievalOptions
  ): Promise<FileRetrievalResult> {
    const query = await this.indexer.queryFiles(
      { filename: [filename] },
      { pageSize: 1 }
    );
    const match = query.items[0];
    if (!match) {
      throw new Error(`File with name ${filename} not found in index`);
    }
    return this.getFile(match.path, options);
  }

  async getFile(
    relativePath: string,
    options?: FileRetrievalOptions
  ): Promise<FileRetrievalResult> {
    const record = this.indexer.getIndexedFile(relativePath);
    if (!record) {
      throw new Error(`File ${relativePath} is not currently indexed`);
    }

    const absolutePath = this.resolveAbsolutePath(relativePath);
    const mediaType = options?.mediaType ?? "photo";
    const representation = (options?.representation ?? {
      type: "original",
    }) as Representation<typeof mediaType>;

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
        const buffer = await convertToWebSafe(record, absolutePath);
        return {
          data: bufferToArrayBuffer(buffer),
          contentType: "image/jpeg",
        };
      }
      case "resize": {
        const buffer = await resizeImage(
          record,
          absolutePath,
          representation.maxWidth,
          representation.maxHeight
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
}

const inferContentType = (record: IndexedFileRecord): string | null => {
  const guessed = lookupMimeType(record.name);
  return (
    record.metadata.mimeType ??
    record.mimeType ??
    (typeof guessed === "string" ? guessed : null)
  ) ?? null;
};

const selectMetadata = (
  record: IndexedFileRecord,
  keys: Array<keyof AllMetadata>
): Partial<AllMetadata> => {
  const full: Partial<AllMetadata> = {
    name: record.metadata.name ?? record.name,
    size: record.metadata.size ?? record.size,
    mimeType: record.metadata.mimeType ?? record.mimeType ?? undefined,
    dateCreated: record.metadata.dateCreated ?? record.dateCreated,
    ...record.metadata,
  };
  const result: Partial<AllMetadata> = {};
  for (const key of keys) {
    (result as Record<string, unknown>)[key as string] = full[key];
  }
  return result;
};

const convertToWebSafe = async (
  record: IndexedFileRecord,
  absolutePath: string
): Promise<Buffer> => {
  const source = await fs.readFile(absolutePath);
  const baseBuffer = await ensureJpegBuffer(record, source);
  return sharp(baseBuffer).rotate().jpeg({ quality: 85 }).toBuffer();
};

const resizeImage = async (
  record: IndexedFileRecord,
  absolutePath: string,
  maxWidth?: number,
  maxHeight?: number
): Promise<Buffer> => {
  const source = await fs.readFile(absolutePath);
  const baseBuffer = await ensureJpegBuffer(record, source);
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
  record: IndexedFileRecord,
  source: Buffer
): Promise<Buffer> => {
  if (isHeic(record)) {
    const converted = await heicConvert({
      buffer: source as any, // heic-convert types are wrong; it really wants a Buffer
      format: "JPEG",
      quality: 0.85,
    });
    return Buffer.from(converted);
  }
  return source;
};

const isHeic = (record: IndexedFileRecord): boolean => {
  const mime = (record.metadata.mimeType ?? record.mimeType ?? "").toLowerCase();
  if (mime === "image/heic" || mime === "image/heif") {
    return true;
  }
  return record.name.toLowerCase().endsWith(".heic");
};
