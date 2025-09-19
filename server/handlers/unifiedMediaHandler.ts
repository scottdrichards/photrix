import path, { relative } from "node:path";
import fs from "node:fs/promises";
import { NOT_HANDLED, type MediaRequestHandler } from "./types.ts";
import { mediaCacheDir, rootDir } from "../config.ts";
import { webpCachePath } from "../fileGenerators/webpCachePath.ts";
import { standardImageToThumbnails } from "../fileGenerators/standardImageToThumbnails.ts";
import { heicToThumbnails } from "../fileGenerators/heicToThumbnails.ts";
import { videoToThumbnails } from "../fileGenerators/videoToThumbnails.ts";
import { createReadStream } from "node:fs";
import { videoToDash } from "fileGenerators/videoToDash.ts";
import {SharedConstants} from "../../shared/constants.ts";

const fileTypeConfig = [
  {
    extensions: [".heic", ".heif"],
    filePath: (relativePath, dimensions) => {
        if (!dimensions){
            throw new Error("Dimensions required for thumbnail generation of non-websafe images");
        }
        return webpCachePath(relativePath, dimensions);
    },
    generator: heicToThumbnails,
  },
  {
    extensions: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"],
    // Grab source file if web-safe format and no resizing requested
    filePath: (relativePath, dimensions) => dimensions && webpCachePath(relativePath, dimensions),
    generator: standardImageToThumbnails,
  },
  {
    extensions: [".mp4", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".webm"],
    generator: videoToThumbnails,
  },
  {
    extensions: [".mpd"],
    generator: videoToDash,
  },
] satisfies Array<{
  extensions: Array<string>;
  filePath?: (relativePath: string, dimensions?: { width?: number; height?: number }) => string | undefined;
  generator: Function;
}>;

const contentTypes = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".webm": "video/webm",
  ".mpd": "application/dash+xml",
  ".m4s": "video/iso.segment",
  ".m4v": "video/mp4",
  ".m4a": "audio/mp4",
} as const satisfies Record<string, string>;

export const unifiedMediaHandler: MediaRequestHandler = async (ctx) => {
  const { relativePath, width } = ctx;

  const conformedWidth = width && SharedConstants.thumbnailWidths.find(w => w <= width);

  const config = fileTypeConfig.find((cfg) =>
    (cfg.extensions as string[]).includes(path.extname(relativePath).toLowerCase())
  );

  const filePath = config?.filePath?.(relativePath, { width: conformedWidth }) ?? path.join(mediaCacheDir, relativePath);

  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    contentTypes[ext as keyof typeof contentTypes] || "application/octet-stream";

  try {
    await fs.access(filePath);
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      throw e;
    }
    
    if (!path.relative(rootDir, filePath).startsWith('..')) {
        // File should be in root dir but isn't, not sure how to handle
        ctx.res.writeHead(404);
        ctx.res.end("File not found");
        return;
    }

    if (!config) {
        ctx.res.writeHead(404);
        ctx.res.end("File type not supported for thumbnails");
        return;
    }

    const result = await config.generator({inputPathRelative:relativePath, widths: conformedWidth?[conformedWidth]:undefined });

    // Did the generator helpfully provide the file?
    if (result){
        ctx.res.writeHead(200, { 'Content-Type': contentType });
        ctx.res.end(result);
        return;
    }
  }

    ctx.res.setHeader("Content-Type", contentType);
    await new Promise((res,rej)=>
        createReadStream(filePath).pipe(ctx.res)
            .on("finish", res)
            .on("error", rej)
    )
    return;
  
};
