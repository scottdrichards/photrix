import { createHash, randomBytes } from "crypto";
import { existsSync } from "fs";
import { mkdir, rm, stat, writeFile } from "fs/promises";
import { tmpdir, userInfo } from "os";
import { basename, dirname, extname, join, parse, resolve } from "path";
import { assertStrictlyInside, resolveInside } from "./pathContainment.ts";

export const CACHE_DIR = process.env.CACHE_DIR || join(process.cwd(), ".cache");
export const MEDIA_CACHE_DIR = join(CACHE_DIR, "media");

// HLS output is ephemeral (regenerated on demand, deleted shortly after playback)
// so it lives on a RAM-backed filesystem and never touches persistent disk.
// Defaults to tmpfs (/dev/shm on Linux); override with HLS_CACHE_DIR.
export const HLS_CACHE_DIR =
  process.env.HLS_CACHE_DIR ||
  join(existsSync("/dev/shm") ? "/dev/shm" : tmpdir(), "photrix-hls");

// mkdir(recursive) succeeds silently when the directory already exists, even if
// it's owned by another user and unwritable to us — so a cache dir left behind by
// a prior root-run instance passes creation but then EACCES-es on the first
// per-file mkdir, surfacing as an opaque 500 at request time. Probe writability
// explicitly here so a misowned cache dir fails loudly at boot instead.
const assertWritableDirectory = async (dir: string): Promise<void> => {
  const probe = join(dir, `.write-probe-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(probe, "");
  } catch (error) {
    const owner = await stat(dir)
      .then(({ uid }) => `uid ${uid}`)
      .catch(() => "unknown owner");
    const { username, uid } = userInfo();
    throw new Error(
      `Cache directory ${dir} is not writable (owned by ${owner}; ` +
        `server runs as ${username}/uid ${uid}). This usually means the ` +
        `directory was created by a different user (e.g. a prior root-run ` +
        `instance). Fix ownership (chown -R ${username} ${dir}) or remove it, ` +
        `then restart. Original error: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  } finally {
    await rm(probe, { force: true });
  }
};

export const initializeCacheDirectories = async () =>
  Promise.all(
    [CACHE_DIR, MEDIA_CACHE_DIR, HLS_CACHE_DIR].map(async (dir) => {
      await mkdir(dir, { recursive: true });
      await assertWritableDirectory(dir);
    }),
  );

export const getHash = (filePath: string, modifiedTimeMs: number): string => {
  const hashInput = `${filePath}:${modifiedTimeMs}`;
  return createHash("md5").update(hashInput).digest("hex");
};

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
    sourceName: toCacheDirectoryName(basename(absolutePath, extname(absolutePath))),
  };
};

/**
 * A file named `..jpg` or `...jpg` has the stem `.` or `..`, which `join` would
 * read as "this folder" or "the parent", landing its derivatives in another
 * file's cache directory (and serving that file's thumbnails for it). Only
 * those stems change; every ordinary name maps to itself, so existing caches
 * stay valid.
 */
const toCacheDirectoryName = (stem: string): string =>
  stem === "" || stem === "." || stem === ".." ? `${stem}%stem` : stem;

export const getMirroredCacheBaseDirectory = (filePath: string): string => {
  const { rootKey, relativeDirectory, sourceName } = getMirroredSourceParts(filePath);
  return assertStrictlyInside(
    MEDIA_CACHE_DIR,
    join(MEDIA_CACHE_DIR, rootKey, relativeDirectory, sourceName),
  );
};

export const getMirroredCachedFilePath = (
  filePath: string,
  suffix: string | number,
  extension: string,
): string => resolveInside(getMirroredCacheBaseDirectory(filePath), `${suffix}.${extension}`);

export const getMirroredHLSDirectory = (
  filePath: string,
  ...subdirectories: string[]
): string => {
  const { rootKey, relativeDirectory, sourceName } = getMirroredSourceParts(filePath);
  return resolveInside(
    assertStrictlyInside(HLS_CACHE_DIR, join(HLS_CACHE_DIR, rootKey, relativeDirectory, sourceName)),
    "hls",
    ...subdirectories,
  );
};
