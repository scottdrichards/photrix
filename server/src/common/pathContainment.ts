import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Keeps every file the server reads on behalf of a request inside the
 * directory it belongs to: the media library for originals, a cache directory
 * for derivatives and HLS output.
 *
 * Two layers, because each catches what the other can't:
 *
 * - **Lexical** (`parseLibraryPath`, `resolveInside`): refuses `..` segments,
 *   NUL bytes, backslashes and platform-absolute paths before anything touches
 *   the filesystem. Runs on the *decoded* value, so `%2e%2e%2f` and a
 *   double-encoded `%252e` that a handler decodes twice are both caught.
 * - **Physical** (`verifyRealPathInside`): `realpath`s both the root and the
 *   target and compares those, so a symlink inside the library that points
 *   outside it (a directory or a single file) can't be followed out.
 *
 * Library paths are root-relative: a leading `/` names the library root (the
 * index stores `/2023/trip/img.jpg`), never the filesystem root.
 */

export type PathRejection = {
  ok: false;
  status: 400 | 403 | 404;
  error: string;
};

export type ParsedLibraryPath = {
  ok: true;
  /** Canonical index form: one leading `/`, no empty or `.` segments. */
  relativePath: string;
};

const reject = (status: PathRejection["status"], error: string): PathRejection => ({
  ok: false,
  status,
  error,
});

/**
 * True when `target` is `base` or lies below it. Unlike a bare
 * `relative.startsWith("..")`, a child literally named `..foo` counts as inside.
 */
export const isPathInside = (base: string, target: string): boolean => {
  const relative = path.relative(base, target);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
};

/**
 * Validates a decoded, library-relative path taken from a request and returns
 * its canonical form. Rejects rather than repairs anything that could name a
 * different file than it appears to: the share filter is checked against this
 * exact path, so it must be the path that is served.
 */
export const parseLibraryPath = (raw: string): ParsedLibraryPath | PathRejection => {
  if (raw.includes("\0")) return reject(400, "Invalid path");
  // A separator on Windows, and folded into `/` by the index's path helpers, so
  // the share check and the filesystem would disagree about which file it names.
  if (raw.includes("\\")) return reject(400, "Invalid path");
  // The index trims paths; a padded one would be share-checked as another file.
  if (raw !== raw.trim()) return reject(400, "Invalid path");
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return reject(403, "Access denied");
  const relativePath = `/${segments.join("/")}`;
  // A drive letter or UNC prefix (`C:`, `//server`) is absolute on Windows even
  // after the leading slashes are gone.
  if (path.isAbsolute(segments.join("/"))) return reject(400, "Invalid path");
  return { ok: true, relativePath };
};

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Confirms that `absolutePath`, with every symlink resolved, is still inside
 * `root` (also resolved). A missing target is a 404; a looping or escaping one
 * is a 403. `realRelativePath` is the file actually reached, in index form, so
 * a caller can hold a symlink's target to the same share as the link.
 */
export const verifyRealPathInside = async (
  root: string,
  absolutePath: string,
): Promise<{ ok: true; realPath: string; realRelativePath: string } | PathRejection> => {
  if (!isPathInside(root, absolutePath)) return reject(403, "Access denied");
  const realRoot = await realpath(root);
  let realTarget: string;
  try {
    realTarget = await realpath(absolutePath);
  } catch (error) {
    if (isMissing(error)) return reject(404, "File not found");
    if ((error as NodeJS.ErrnoException | null)?.code === "ELOOP") {
      return reject(403, "Access denied");
    }
    throw error;
  }
  if (!isPathInside(realRoot, realTarget)) return reject(403, "Access denied");
  const realRelativePath = `/${path.relative(realRoot, realTarget).split(path.sep).join("/")}`;
  return { ok: true, realPath: realTarget, realRelativePath };
};

export type ResolvedMediaPath = {
  ok: true;
  /** Canonical index form, e.g. `/2023/trip/img.jpg`. */
  relativePath: string;
  /**
   * `path.join(storageRoot, relativePath)`: the same string the cache keys
   * have always been derived from, so existing caches stay valid.
   */
  absolutePath: string;
};

/** The lexical half of `resolveMediaPath`, for callers that check a share in between. */
export const joinLibraryPath = (
  storageRoot: string,
  raw: string,
): ResolvedMediaPath | PathRejection => {
  const parsed = parseLibraryPath(raw);
  if (!parsed.ok) return parsed;
  const absolutePath = path.join(storageRoot, parsed.relativePath);
  if (!isPathInside(storageRoot, absolutePath)) return reject(403, "Access denied");
  return { ok: true, relativePath: parsed.relativePath, absolutePath };
};

/**
 * Resolves a request's library-relative path to a file or folder that really
 * is inside the library. The one entry point for turning request input into a
 * media path.
 */
export const resolveMediaPath = async (
  storageRoot: string,
  raw: string,
): Promise<ResolvedMediaPath | PathRejection> => {
  const joined = joinLibraryPath(storageRoot, raw);
  if (!joined.ok) return joined;
  const real = await verifyRealPathInside(storageRoot, joined.absolutePath);
  if (!real.ok) return real;
  return joined;
};

export class PathContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathContainmentError";
  }
}

const isPlainName = (name: string): boolean =>
  name !== "" &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\") &&
  !name.includes("\0");

/**
 * Joins single path components under a server-owned directory (a cache or HLS
 * folder), throwing if any component could step out of it. For children whose
 * names are built by the server, this is the backstop against one of those
 * names ever coming from a request.
 */
export const resolveInside = (baseDir: string, ...names: string[]): string => {
  for (const name of names) {
    if (!isPlainName(name)) {
      throw new PathContainmentError(`Refusing path component ${JSON.stringify(name)}`);
    }
  }
  const target = path.join(baseDir, ...names);
  if (names.length > 0 && (!isPathInside(baseDir, target) || path.relative(baseDir, target) === "")) {
    throw new PathContainmentError("Resolved path escapes its base directory");
  }
  return target;
};

/** Throws unless `target` lies strictly below `baseDir`. Returns `target`. */
export const assertStrictlyInside = (baseDir: string, target: string): string => {
  if (!isPathInside(baseDir, target) || path.relative(baseDir, target) === "") {
    throw new PathContainmentError("Resolved path escapes its base directory");
  }
  return target;
};
