import { createHash } from "crypto";
import { mkdir } from "fs/promises";
import { basename, dirname, extname, join, parse, resolve } from "path";

export const CACHE_DIR = process.env.CACHE_DIR || join(process.cwd(), ".cache");
export const MEDIA_CACHE_DIR = join(CACHE_DIR, "media");

let initialized = false;

export const initializeCacheDirectories = async () => {
  if (initialized) return;
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(MEDIA_CACHE_DIR, { recursive: true });
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
) => join(MEDIA_CACHE_DIR, `${hash}.${suffix}.${extension}`);

const getRootKey = (rootPath: string): string => {
  const normalized = rootPath
    .replace(/[\\/:]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || "root";
};

const getMirroredSourceParts = (
  filePath: string,
): {
  rootKey: string;
  relativeDirectory: string;
  sourceName: string;
} => {
  const absolutePath = resolve(filePath);
  const { root } = parse(absolutePath);
  const pathAfterRoot = absolutePath.slice(root.length);
  const rawRelativeDirectory = dirname(pathAfterRoot);
  return {
    rootKey: getRootKey(root),
    relativeDirectory: rawRelativeDirectory === "." ? "" : rawRelativeDirectory,
    sourceName: basename(absolutePath, extname(absolutePath)),
  };
};

export const getMirroredCacheBaseDirectory = (filePath: string): string => {
  const { rootKey, relativeDirectory, sourceName } = getMirroredSourceParts(filePath);
  return join(MEDIA_CACHE_DIR, rootKey, relativeDirectory, sourceName);
};

export const getMirroredCachedFilePath = (
  filePath: string,
  suffix: string | number,
  extension: string,
): string => join(getMirroredCacheBaseDirectory(filePath), `${suffix}.${extension}`);

export const getMirroredHLSDirectory = (
  filePath: string,
  ...subdirectories: string[]
): string => join(getMirroredCacheBaseDirectory(filePath), "hls", ...subdirectories);
