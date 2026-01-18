import { createHash } from "crypto";
import { mkdir } from "fs/promises";
import { join } from "path";

export const CACHE_DIR = process.env.CACHE_DIR || join(process.cwd(), ".cache");

let initialized = false;

export const initializeCacheDirectories = async () => {
  if (initialized) return;
  await mkdir(CACHE_DIR, { recursive: true });
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
) => join(CACHE_DIR, `${hash}.${suffix}.${extension}`);
