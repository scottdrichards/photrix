import posix from "node:path/posix";
import { normalizeFolderPath } from "../indexDatabase/utils/pathUtils.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";

/**
 * Normalized folder path with `.`/`..` segments resolved away.
 *
 * The WHATWG URL parser already collapses literal `../` in a request path, but
 * *percent-encoded* dot segments (`%2E%2E%2F`) survive parsing and only become
 * `../` after decoding — so a prefix check on the decoded path alone would accept
 * `/Shared/2009/../../Private/` as "inside /Shared/2009/". Resolving first makes
 * the containment test mean what it says.
 */
export const canonicalFolderPath = (value: string): string =>
  normalizeFolderPath(posix.normalize(normalizeFolderPath(value)));

/**
 * A folder a share link grants access to. `recursive` mirrors the folder filter
 * the link was minted with: `true` includes descendants, `false` is that one
 * folder only.
 */
export type ShareFolderRoot = { folder: string; recursive: boolean };

/** True when `outer` covers everything `inner` covers. */
const contains = (outer: ShareFolderRoot, inner: ShareFolderRoot): boolean => {
  if (!outer.recursive) return !inner.recursive && inner.folder === outer.folder;
  return inner.folder.startsWith(outer.folder);
};

/**
 * Roots that satisfy both sides of an `and`. Two roots can only both hold if one
 * contains the other, in which case the narrower wins; anything else is
 * unsatisfiable and yields no browsable root at all.
 */
const intersectRoots = (
  a: ShareFolderRoot[],
  b: ShareFolderRoot[],
): ShareFolderRoot[] => {
  const result: ShareFolderRoot[] = [];
  for (const x of a) {
    for (const y of b) {
      if (contains(x, y)) result.push(y);
      else if (contains(y, x)) result.push(x);
    }
  }
  return result;
};

const folderRootFromCondition = (
  condition: Record<string, unknown>,
): ShareFolderRoot | null => {
  const folder = condition["folder"];
  if (!folder || typeof folder !== "object") return null;
  if (!("folder" in folder)) return null; // a StringSearch on folder, not a FolderFilter
  const { folder: value, recursive } = folder as { folder: unknown; recursive?: unknown };
  if (typeof value !== "string") return null;
  return { folder: normalizeFolderPath(value), recursive: recursive === true };
};

/**
 * Derives the folder boundary of a share link from the filter it was minted with.
 *
 * Returns `null` when the share is not folder-bounded — e.g. a semantic-query or
 * person share, which legitimately spans the whole library. That is *not* a
 * licence to browse everything: the caller still applies the share filter itself
 * to every listing, so only folders that actually contain shared items are ever
 * visible. The roots returned here are the extra, explicit path clamp for shares
 * that *are* scoped to a folder.
 *
 * An empty array means "no folder can satisfy this share" (contradictory `and`),
 * and browsing must be refused outright.
 */
export const extractShareFolderRoots = (
  filter: FilterElement | null | undefined,
): ShareFolderRoot[] | null => {
  if (!filter || typeof filter !== "object") return null;

  if ("operation" in filter) {
    const children = filter.conditions.map((condition) =>
      extractShareFolderRoots(condition as FilterElement),
    );

    if (filter.operation === "or") {
      // A single unbounded branch makes the whole union unbounded.
      if (children.some((child) => child === null)) return null;
      return children.flatMap((child) => child ?? []);
    }

    // `and`: every bounded branch narrows the result.
    const bounded = children.filter((child): child is ShareFolderRoot[] => child !== null);
    if (bounded.length === 0) return null;
    return bounded.reduce(intersectRoots);
  }

  const root = folderRootFromCondition(filter as Record<string, unknown>);
  return root ? [root] : null;
};

/**
 * Whether a share link may list `requestedPath`.
 *
 * Allowed:
 *  - the shared root itself, and (for a recursive share) anything below it —
 *    this is the "browse into subfolders" case;
 *  - an *ancestor* of a shared root, so a viewer can navigate down to it. An
 *    ancestor listing is still filtered by the share filter, so it shows only
 *    the folders leading to the shared content and never a sibling.
 *
 * Refused: anything else — the "browse up and out" case. This is enforced here,
 * server-side, and not merely hidden in the client.
 */
export const isFolderWithinShareScope = (
  requestedPath: string,
  roots: ShareFolderRoot[] | null,
): boolean => {
  if (roots === null) return true; // not folder-bounded; the share filter is the boundary
  if (roots.length === 0) return false; // unsatisfiable share scope
  const path = canonicalFolderPath(requestedPath);
  return roots.some((root) => {
    if (path === root.folder) return true;
    if (root.recursive && path.startsWith(root.folder)) return true; // into subfolders
    return root.folder.startsWith(path); // ancestor: navigating down toward the share
  });
};
