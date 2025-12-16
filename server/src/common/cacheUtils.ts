import { createHash } from "crypto";
import { mkdir, readFile, stat } from "fs/promises";
import { createReadStream } from "fs";
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

export const getHash = async (opts: { filePath: string, fileBuffer?: Buffer, useStream?: boolean }): Promise<string> => {
  const { filePath, fileBuffer: fileBufferIn, useStream = false } = opts;
  
  // If buffer is provided, use it directly
  if (fileBufferIn) {
    return createHash("md5").update(fileBufferIn).digest("hex");
  }

  // For large files (or when requested), use streaming to avoid memory issues
  if (useStream) {
    const stats = await stat(filePath);
    // Hash based on file path, size, and modification time (fast and deterministic)
    const hashInput = `${filePath}:${stats.size}:${stats.mtimeMs}`;
    return createHash("md5").update(hashInput).digest("hex");
  }

  // For small files, read into memory
  const fileBuffer = await readFile(filePath);
  return createHash("md5").update(fileBuffer).digest("hex");
};

export const getCachedFilePath = (
  hash: string,
  suffix: string | number,
  extension: string,
) => join(getThumbnailsDir(), `${hash}.${suffix}.${extension}`);
