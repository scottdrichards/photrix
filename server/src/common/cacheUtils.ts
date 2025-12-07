import { createHash } from "crypto";
import { mkdir, readFile } from "fs/promises";
import { join } from "path";

export const CACHE_DIR = join(process.cwd(), ".cache");

if (!process.env.ThumbnailCacheDirectory) {
  throw new Error("ThumbnailCacheDirectory environment variable must be set");
}

export const thumbnailsDir = process.env.ThumbnailCacheDirectory;

let initialized = false;

export const initializeCacheDirectories = async () => {
  if (initialized) return;
  const folderPromises = [CACHE_DIR, thumbnailsDir].map(async (dir) =>
    mkdir(dir, { recursive: true }),
  );
  const timeOutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout while creating cache directories")), 1000));
  await Promise.race([timeOutPromise, Promise.all(folderPromises)]);
  initialized = true;
};

export const getHash = async (opts: { filePath: string, fileBuffer?: Buffer }): Promise<string> => {
  const { filePath, fileBuffer: fileBufferIn } = opts;
  const fileBuffer = fileBufferIn ?? await readFile(filePath);
  return createHash("md5").update(fileBuffer).digest("hex");
};

export const getCachedFilePath = (
  hash: string,
  suffix: string | number,
  extension: string,
) => join(thumbnailsDir, `${hash}.${suffix}.${extension}`);
