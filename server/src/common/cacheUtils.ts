import { createHash } from "crypto";
import { mkdir } from "fs/promises";
import { join } from "path";

export const CACHE_DIR = join(process.cwd(), ".cache");

export const THUMBNAILS_DIR = process.env.ThumbnailCacheDirectory;
if (!THUMBNAILS_DIR) {
  throw new Error("ThumbnailCacheDirectory environment variable is not set.");
}

const folderPromises = [CACHE_DIR, THUMBNAILS_DIR].map(async (dir) => mkdir(dir, { recursive: true }));

await Promise.all(folderPromises);

export const getHash = (filePath: string): string =>
  createHash("md5").update(filePath).digest("hex");

export const getCachedFilePath = (
  hash: string,
  suffix: string | number,
  extension: string,
) => join(THUMBNAILS_DIR, `${hash}.${suffix}.${extension}`);
