import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, extname, join, parse, resolve } from "path";

export const CACHE_DIR = process.env.CACHE_DIR || join(process.cwd(), ".cache");
export const MEDIA_CACHE_DIR = join(CACHE_DIR, "media");

// HLS output is ephemeral (regenerated on demand, deleted shortly after playback)
// so it lives on a RAM-backed filesystem and never touches persistent disk.
// Defaults to tmpfs (/dev/shm on Linux); override with HLS_CACHE_DIR.
export const HLS_CACHE_DIR =
  process.env.HLS_CACHE_DIR ||
  join(existsSync("/dev/shm") ? "/dev/shm" : tmpdir(), "photrix-hls");

export const initializeCacheDirectories = async () =>
  Promise.all([CACHE_DIR, MEDIA_CACHE_DIR, HLS_CACHE_DIR]
    .map(dir => mkdir(dir, { recursive: true })));

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
): string => {
  const { rootKey, relativeDirectory, sourceName } = getMirroredSourceParts(filePath);
  return join(
    HLS_CACHE_DIR,
    rootKey,
    relativeDirectory,
    sourceName,
    "hls",
    ...subdirectories,
  );
};
