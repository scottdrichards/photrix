import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

export const CACHE_DIR = join(process.cwd(), ".cache");

export const ensureCacheDirExists = () => {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
};

export const getHash = (filePath: string): string =>
  createHash("md5").update(filePath).digest("hex");

export const getCachedFilePath = (
  hash: string,
  suffix: string | number,
  extension: string,
) => join(CACHE_DIR, `${hash}.${suffix}.${extension}`);
