import { createHash } from "crypto";
import { mkdir } from "fs/promises";
import { join } from "path";

const cacheDir = process.env.CACHE_DIR;
const indexDbPath = process.env.INDEX_DB_PATH;

const dirs = {cacheDir, indexDbPath} as const;

Object.entries(dirs).forEach(([key, value]) => {
  if (!value) {
    throw new Error(`${key} environment variable must be set`);
  }
  mkdir(value, { recursive: true })
});


if (!cacheDir) {
  throw new Error("CACHE_DIR environment variable must be set");
}
mkdir(cacheDir, { recursive: true });

if (!indexDbPath) {
  throw new Error("INDEX_DB_PATH environment variable must be set");
}

const folders = [cacheDir];

mkdir(cacheDir, { recursive: true }).catch((error) => {
  console.error(`Error creating cache directory at ${cacheDir}:`, error);
  throw error;
}

let initialized = false;

export const initializeCacheDirectories = async () => {
  if (initialized) return;
  const folderPromises = [dataDir, getThumbnailsDir()].map(async (dir) =>
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
