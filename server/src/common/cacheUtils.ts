import { createHash, randomBytes } from "crypto";
import { existsSync } from "fs";
import { mkdir, rm, stat, writeFile } from "fs/promises";
import { tmpdir, userInfo } from "os";
import { basename, dirname, extname, join, parse, resolve } from "path";
import { closeHlsWatchersUnder } from "../videoProcessing/hlsSegmentWatcher.ts";

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

/**
 * Removes every cached derivative (thumbnails, image variants, HLS segments) for
 * a source file. The mirrored media cache is keyed by path only — unlike
 * {@link getHash} it does not fold in the modified time — so when a file's bytes
 * change in place the old derivatives must be deleted explicitly or they would
 * be served stale.
 */
export const clearMirroredCacheForFile = async (filePath: string): Promise<void> => {
  // Close any live HLS watcher inside the tree first. A recursive fs.watch whose
  // directories are deleted underneath it throws ENOENT from its internal
  // re-scan, which Node raises as a watcher "error" — fatal if unhandled.
  closeHlsWatchersUnder(getMirroredHLSDirectory(filePath));
  await Promise.all([
    rm(getMirroredCacheBaseDirectory(filePath), { recursive: true, force: true }),
    rm(getMirroredHLSDirectory(filePath), { recursive: true, force: true }),
  ]);
};
