import { createHash } from "crypto";
import { mkdir } from "fs/promises";
import { join } from "path";

export const CACHE_DIR = join(process.cwd(), ".cache");

const getThumbnailsDir = (): string => {
  const dir = process.env.ThumbnailCacheDirectory;
  if (!dir) {
    throw new Error("ThumbnailCacheDirectory environment variable must be set");
  }
  return dir;
};

let initialized = false;

export const initializeCacheDirectories = async () => {
  if (initialized) return;
  const folderPromises = [CACHE_DIR, getThumbnailsDir()].map(async (dir) =>
    mkdir(dir, { recursive: true }),
  );
  const timeOutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout while creating cache directories")), 1000));
  await Promise.race([timeOutPromise, Promise.all(folderPromises)]);
  initialized = true;
};

export const getHash = (filePath: string, modifiedTimeMs: number): string => {
  const hashInput = `${filePath}:${modifiedTimeMs}`;
  return createHash("md5").update(hashInput).digest("hex");
};

export const getCachedFilePath = (
  hash: string,
  suffix: string | number,
  extension: string,
) => join(getThumbnailsDir(), `${hash}.${suffix}.${extension}`);
