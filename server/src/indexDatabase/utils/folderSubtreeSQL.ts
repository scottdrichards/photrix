import { normalizeFolderPath } from "./pathUtils.ts";

/**
 * SQL matching `column` values in `folder` or below it, case-sensitively.
 *
 * Not `LIKE 'folder%'`: SQLite's LIKE ignores ASCII case, so a share of
 * `/Family/` would also grant `/FAMILY/`, and removing `/Family/` would delete
 * `/FAMILY/` too. A folder ends in `/`, and every string that starts with it
 * sorts between it and the same prefix ending in `0` (the next byte after `/`),
 * so a binary range is exactly a prefix test — and can use the index.
 */
export const folderSubtreeSQL = (column: string, folder: string) => {
  const base = normalizeFolderPath(folder);
  return {
    where: `${column} >= ? AND ${column} < ?`,
    params: [base, `${base.slice(0, -1)}0`],
  };
};
