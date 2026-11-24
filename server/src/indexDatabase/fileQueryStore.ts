import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { queryCacheKey, type WriteInvalidatedCache } from "../common/writeInvalidatedCache.ts";
import type { FileRecord } from "./fileRecord.type.ts";
import { tables } from "./tables.ts";
import { filterToSQL } from "./filterToSQL.ts";
import type { FilterElement, QueryOptions, QueryResult, SortOption } from "./indexDatabase.type.ts";
import { rowToFileRecord } from "./rowFileRecordConversionFunctions.ts";
import { splitPath } from "./utils/pathUtils.ts";

// Columns to read for file queries. This used to exclude the embedding BLOBs
// explicitly — each row carried a ~2 KB imageEmbedding (and audioEmbedding) that
// no read path consumes, so `SELECT *` dragged megabytes of vector data off disk
// per page. The vectors now live in `fileEmbeddings`, so there is nothing left on
// `files` to exclude; the list stays explicit so a future BLOB column added here
// has to be a deliberate choice rather than something `SELECT *` picks up.
const FILE_QUERY_COLUMNS = tables.files.columns
  .map((column) => column.name)
  .join(", ");

// Effective capture date used for date sorting: prefer the EXIF date, fall back
// to filesystem timestamps. Shared by the ORDER BY builder below.
export const SORT_DATE_EXPR = "COALESCE(dateTaken, created, modified)";

/**
 * Build the ORDER BY clause for `queryFiles`.
 *
 * The default (date, descending) is intentionally byte-for-byte identical to the
 * previous hard-coded ordering so it stays covered end-to-end by
 * idx_files_sort_date — SQLite walks the index for the top N instead of scanning
 * and temp-sorting the whole table. Other orderings fall back to a temp-sort,
 * which is acceptable for the less common cases.
 *
 * `relevance` is a semantic-search concept with no meaning for a plain library
 * query, so it degrades to the date ordering here.
 */
const buildQueryOrderBy = (sort?: SortOption): string => {
  const dir = sort?.direction === "asc" ? "ASC" : "DESC";
  const tiebreak = "folder ASC, fileName ASC";

  if (sort?.field === "rating") {
    // Unrated files (NULL) always sink to the bottom regardless of direction;
    // among rated files, order by the requested direction, then newest-first.
    return `rating IS NULL, rating ${dir}, ${SORT_DATE_EXPR} DESC, ${tiebreak}`;
  }

  if (sort?.field === "quality") {
    // Same NULL-always-last treatment as rating: a photo with no scored faces
    // has no quality signal at all, which is not the same as "bad quality", so
    // it must not win an ascending ("worst first") sort either.
    return `photoQualityScore IS NULL, photoQualityScore ${dir}, ${SORT_DATE_EXPR} DESC, ${tiebreak}`;
  }

  if (dir === "ASC") {
    // Ascending needs an explicit NULL guard: a plain ASC sorts NULL dates first,
    // but files with no known date belong at the end in either direction.
    return `${SORT_DATE_EXPR} IS NULL, ${SORT_DATE_EXPR} ASC, ${tiebreak}`;
  }

  // Newest first. A DESC ordering already sorts NULL effective-dates last, so no
  // separate IS NULL term is needed — and this exact shape is index-covered.
  return `${SORT_DATE_EXPR} DESC, ${tiebreak}`;
};

/** The paged, filtered, sorted file listing behind the grid, and single-file filter checks. */
export class FileQueryStore {
  constructor(
    private readonly db: AsyncSqlite,
    private readonly aggregateCache: WriteInvalidatedCache,
  ) {}

  async fileMatchesFilter(subPath: string, filter: FilterElement): Promise<boolean> {
    const { folder, fileName } = splitPath(subPath);
    const combined: FilterElement = {
      operation: "and",
      conditions: [filter, { folder, fileName }],
    };
    const { where, params } = filterToSQL(combined);
    const result = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM files${where ? ` WHERE ${where}` : ""}`,
      ...params,
    );
    return (result?.count ?? 0) > 0;
  }

  async queryFiles<TMetadata extends Array<keyof FileRecord>>(
    options: QueryOptions,
  ): Promise<QueryResult<TMetadata>> {
    const {
      filter,
      metadata,
      pageSize = 1_000,
      page: rawPage = 1,
      expandToFolder,
      scope,
      sort,
      collapseMomentClusters = true,
    } = options;
    const page = Math.max(1, rawPage);

    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const { where: scopeWhere, params: scopeParams } = filterToSQL(scope ?? {});

    // When expandToFolder is enabled, wrap the filter in a folder-IN-subquery so
    // all files in a matched folder are returned, not just the matched files.
    // The scope is ANDed outside it, so expansion never reaches past a share.
    const folderExpandedWhere =
      expandToFolder && whereClause
        ? `folder IN (SELECT DISTINCT folder FROM files WHERE ${whereClause})`
        : whereClause;
    const scopedWhere = [folderExpandedWhere, scopeWhere]
      .filter(Boolean)
      .map((part) => `(${part})`)
      .join(" AND ");

    // Moment cluster members are read from `members`: the whole table, or with a
    // scope only the members inside it, so a stack's size, preview paths and
    // standing representative never reveal a file outside a share. Inlined (NOT
    // MATERIALIZED) so each correlated lookup stays a momentClusterId index probe.
    const members = scopeWhere ? "scopedMembers" : "files";
    const withMembers = scopeWhere
      ? `WITH scopedMembers AS NOT MATERIALIZED (SELECT * FROM files WHERE ${scopeWhere}) `
      : "";
    const withParams = scopeWhere ? scopeParams : [];

    // Default gallery behavior: a moment cluster (burst/near-duplicate group)
    // collapses to just its representative row. Files with no cluster
    // (momentClusterId IS NULL) are unaffected. Callers expanding a stack (or
    // fetching a specific cluster's members) pass collapseMomentClusters: false.
    // With a scope that excludes the representative, the stack stands on its
    // best member inside the scope instead of vanishing.
    const collapseWhere = scopeWhere
      ? `(momentClusterId IS NULL OR momentClusterRepresentative = 1 OR (folder, fileName) = (
           SELECT best.folder, best.fileName FROM scopedMembers AS best
           WHERE best.momentClusterId = files.momentClusterId
           ORDER BY best.momentClusterRepresentative DESC, COALESCE(best.photoQualityScore, 0) DESC,
                    COALESCE(best.sharpnessScore, 0) DESC, best.folder, best.fileName
           LIMIT 1))`
      : "(momentClusterId IS NULL OR momentClusterRepresentative = 1)";
    const effectiveWhere = [scopedWhere, collapseMomentClusters ? collapseWhere : ""]
      .filter(Boolean)
      .join(" AND ");
    const effectiveParams = [...withParams, ...whereParams, ...scopeParams];

    const countSQL = `${withMembers}SELECT COUNT(*) as count FROM files ${effectiveWhere ? `WHERE ${effectiveWhere}` : ""}`;
    // Not awaited here: it runs beside the page query below, on another read
    // connection, instead of in front of it.
    const counting = this.aggregateCache.get(
      queryCacheKey(countSQL, effectiveParams),
      async () =>
        (await this.db.get<{ count: number }>(countSQL, ...effectiveParams))?.count ?? 0,
    );

    // The stack badge needs a member count alongside the representative row;
    // only joined in when asked for, so the common case (no metadata request
    // for it) pays nothing extra.
    const extraColumns: string[] = [];
    if (metadata?.includes("momentClusterSize")) {
      extraColumns.push(`(CASE WHEN files.momentClusterId IS NULL THEN NULL ELSE
             (SELECT COUNT(*) FROM ${members} momentMember WHERE momentMember.momentClusterId = files.momentClusterId)
           END) AS momentClusterSize`);
    }
    // A handful of the *other* members' paths (the shown row excluded), so
    // the collapsed tile can render a couple of real thumbnails peeking out
    // behind the representative — a genuine "stack of photos" look — instead
    // of an abstract count badge alone. Same opt-in shape as
    // momentClusterSize (a correlated subquery, not a per-tile extra round
    // trip, since a gallery page can show many stacks at once), and same
    // "no signal for a non-clustered row" NULL convention. Capped at 2 and
    // ranked by the same quality signal the representative pick itself uses
    // (see momentClusterEngine.pickRepresentative) — the peeking photos are
    // realistically the ones a user would pick, not arbitrary members.
    // json_group_array over a LIMIT'd derived table (rather than a bare
    // GROUP_CONCAT) sidesteps any need to worry about a folder/fileName
    // containing whatever separator character a naive string join would pick.
    if (metadata?.includes("momentClusterPreviewPaths")) {
      extraColumns.push(`(CASE WHEN files.momentClusterId IS NULL THEN NULL ELSE
             (SELECT json_group_array(preview.path) FROM (
               SELECT (other.folder || other.fileName) AS path
               FROM ${members} AS other
               WHERE other.momentClusterId = files.momentClusterId
                 AND NOT (other.folder = files.folder AND other.fileName = files.fileName)
               ORDER BY COALESCE(other.photoQualityScore, 0) DESC, COALESCE(other.sharpnessScore, 0) DESC
               LIMIT 2
             ) AS preview)
           END) AS momentClusterPreviewPaths`);
    }
    const columns =
      extraColumns.length > 0 ? `${FILE_QUERY_COLUMNS}, ${extraColumns.join(", ")}` : FILE_QUERY_COLUMNS;

    const offset = (page - 1) * pageSize;
    const mainSQL = `
      ${withMembers}SELECT ${columns} FROM files
      ${effectiveWhere ? `WHERE ${effectiveWhere}` : ""}
      ORDER BY ${buildQueryOrderBy(sort)}
      LIMIT ? OFFSET ?
    `;

    const [counted, rows] = await Promise.all([
      counting,
      this.db.all<Record<string, unknown>>(mainSQL, ...effectiveParams, pageSize, offset),
    ]);
    // A page that comes back short is the last one, so where it ends is the
    // total. The two queries read separate snapshots; taking the total from the
    // rows keeps them agreeing at the end of the list, where a total that ran
    // ahead of the rows would have the grid asking for a page that isn't there.
    const isLastPage = rows.length < pageSize && (rows.length > 0 || offset === 0);
    const total = isLastPage ? offset + rows.length : counted;

    const matchedFiles = rows.map((v) =>
      rowToFileRecord(v as Record<string, string | number>, metadata),
    );

    return {
      items: matchedFiles as Array<
        { folder: string; fileName: string } & Pick<FileRecord, TMetadata[number]>
      >,
      page,
      pageSize,
      total,
    } as QueryResult<TMetadata>;
  }
}
