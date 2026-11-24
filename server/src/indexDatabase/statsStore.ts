import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { runWithoutRequestAbortSignal } from "../common/requestAbort.ts";
import { queryCacheKey, type WriteInvalidatedCache } from "../common/writeInvalidatedCache.ts";
import { filterToSQL } from "./filterToSQL.ts";
import type { DateHistogramGrouping, DateHistogramResult, FilterElement } from "./indexDatabase.type.ts";
import { normalizeFolderPath } from "./utils/pathUtils.ts";
import { folderSubtreeSQL } from "./utils/folderSubtreeSQL.ts";

export type StatusCounts = {
  allEntries: number;
  imageEntries: number;
  videoEntries: number;
  missingFileMetadata: number;
  missingMediaMetadata: number;
  missingThumbnails: number;
  missingFaceDetection: number;
};

/**
 * Read-only aggregates over the whole library: entry counts, the cached status
 * counts the progress displays poll, rating stats, folder lists and the date
 * range / histogram behind the timeline.
 */
export class StatsStore {
  // The status counts come from a full-table-scan aggregate. Every active
  // background task asks for them on each status poll, and the status SSE stream
  // polls a few times a second, so without coordination the same heavy scan runs
  // repeatedly while the DB is already busy indexing. De-duplicate concurrent
  // callers onto a single scan, and briefly cache the result. All callers are
  // progress-display getStatus() methods where sub-second staleness is invisible,
  // so a short TTL bounds the load without any user-visible effect.
  private statusCountsInflight?: Promise<StatusCounts>;
  private statusCountsCache?: { value: StatusCounts; at: number };
  private static readonly STATUS_COUNTS_TTL_MS = 1_000;

  constructor(
    private readonly db: AsyncSqlite,
    private readonly aggregateCache: WriteInvalidatedCache,
  ) {}

  private async countEntries(whereClause?: string): Promise<number> {
    const sql = whereClause
      ? `SELECT COUNT(*) as count FROM files WHERE ${whereClause}`
      : "SELECT COUNT(*) as count FROM files";
    const row = await this.db.get<{ count: number }>(sql);
    return row?.count ?? 0;
  }

  async countMissingInfo(): Promise<number> {
    return this.countEntries(
      "sizeInBytes IS NULL OR created IS NULL OR modified IS NULL",
    );
  }

  async countMissingDateTaken(): Promise<number> {
    return this.countEntries(
      "(mimeType LIKE 'image/%' OR mimeType LIKE 'video/%') AND dateTaken IS NULL AND exifProcessedAt IS NULL",
    );
  }

  async countMediaEntries(): Promise<number> {
    return this.countEntries("mimeType LIKE 'image/%' OR mimeType LIKE 'video/%'");
  }

  async countImageEntries(): Promise<number> {
    return this.countEntries("mimeType LIKE 'image/%'");
  }

  async countAllEntries(): Promise<number> {
    return this.countEntries();
  }

  async getStatusCounts(): Promise<StatusCounts> {
    const cached = this.statusCountsCache;
    if (cached && Date.now() - cached.at < StatsStore.STATUS_COUNTS_TTL_MS) {
      return cached.value;
    }
    if (this.statusCountsInflight) {
      return this.statusCountsInflight;
    }

    // Shared across concurrent callers: don't let the first caller's request
    // abort reject the promise everyone else is awaiting.
    this.statusCountsInflight = runWithoutRequestAbortSignal(() =>
      this.computeStatusCounts(),
    )
      .then((value) => {
        this.statusCountsCache = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        this.statusCountsInflight = undefined;
      });

    return this.statusCountsInflight;
  }

  /**
   * Drops the memoized status counts so the next read recomputes. Called from
   * writes that change a counted column (file add/remove, exif/variants/face
   * processing stamps); without it a save made inside the 1s TTL window returns
   * a stale count.
   */
  invalidateStatusCountsCache(): void {
    this.statusCountsCache = undefined;
  }

  private async computeStatusCounts(): Promise<StatusCounts> {
    const row = await this.db.get<{
      allEntries: number | null;
      imageEntries: number | null;
      videoEntries: number | null;
      missingFileMetadata: number | null;
      missingMediaMetadata: number | null;
      missingThumbnails: number | null;
      missingFaceDetection: number | null;
    }>(
      `SELECT
         COUNT(*) AS allEntries,
         SUM(CASE WHEN mimeType LIKE 'image/%' THEN 1 ELSE 0 END) AS imageEntries,
         SUM(CASE WHEN mimeType LIKE 'video/%' THEN 1 ELSE 0 END) AS videoEntries,
         SUM(CASE WHEN sizeInBytes IS NULL OR created IS NULL OR modified IS NULL THEN 1 ELSE 0 END) AS missingFileMetadata,
         SUM(CASE WHEN (mimeType LIKE 'image/%' OR mimeType LIKE 'video/%') AND exifProcessedAt IS NULL THEN 1 ELSE 0 END) AS missingMediaMetadata,
         SUM(CASE WHEN mimeType LIKE 'image/%' AND imageVariantsGeneratedAt IS NULL THEN 1 ELSE 0 END) AS missingThumbnails,
         SUM(CASE WHEN mimeType LIKE 'image/%' AND facesProcessedAt IS NULL THEN 1 ELSE 0 END) AS missingFaceDetection
       FROM files`,
    );

    return {
      allEntries: row?.allEntries ?? 0,
      imageEntries: row?.imageEntries ?? 0,
      videoEntries: row?.videoEntries ?? 0,
      missingFileMetadata: row?.missingFileMetadata ?? 0,
      missingMediaMetadata: row?.missingMediaMetadata ?? 0,
      missingThumbnails: row?.missingThumbnails ?? 0,
      missingFaceDetection: row?.missingFaceDetection ?? 0,
    };
  }

  async getMostRecentExifProcessedEntry(): Promise<{
    folder: string;
    fileName: string;
    completedAt: string;
  } | null> {
    const row = await this.db.get<{
      folder: string;
      fileName: string;
      exifProcessedAt: number | null;
    }>(
      `SELECT folder, fileName, exifProcessedAt
       FROM files
       WHERE exifProcessedAt IS NOT NULL
       ORDER BY exifProcessedAt DESC
       LIMIT 1`,
    );

    if (!row) {
      return null;
    }

    return {
      folder: row.folder,
      fileName: row.fileName,
      completedAt: new Date(row.exifProcessedAt as unknown as number).toISOString(),
    };
  }

  async getRatingStats(): Promise<{
    total: number;
    rated: number;
    unrated: number;
    distribution: Record<string, number>;
  }> {
    const rows = await this.db.all<{ rating: number | null; count: number }>(
      `SELECT rating, COUNT(*) as count
       FROM files
       WHERE mimeType LIKE 'image/%' OR mimeType LIKE 'video/%'
       GROUP BY rating`,
    );

    const distribution: Record<string, number> = {};
    let rated = 0;
    let total = 0;

    for (const row of rows) {
      const key = row.rating === null ? "null" : String(row.rating);
      distribution[key] = row.count;
      total += row.count;
      if (row.rating !== null) {
        rated += row.count;
      }
    }

    return {
      total,
      rated,
      unrated: total - rated,
      distribution,
    };
  }

  async getSize(): Promise<number> {
    const result = await this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM files",
    );
    return result?.count ?? 0;
  }

  async getFolders(
    relativePath: string,
    filter: FilterElement = {},
  ): Promise<Array<{ name: string; count: number }>> {
    const base = normalizeFolderPath(relativePath);
    const { where, params } = filterToSQL(filter);
    return this.aggregateCache.get(queryCacheKey(`folders\u0000${base}\u0000${where}`, params), () =>
      this.computeFolders(base, where, params),
    );
  }

  private async computeFolders(
    base: string,
    whereClause: string,
    whereParams: ReturnType<typeof filterToSQL>["params"],
  ): Promise<Array<{ name: string; count: number }>> {
    const whereFragment = whereClause ? `AND (${whereClause})` : "";

    if (base === "/") {
      const rows = await this.db.all<{ folderName: string | null; count: number }>(
        `SELECT
          CASE 
          WHEN instr(substr(folder, 2), '/') > 0 
          THEN substr(folder, 2, instr(substr(folder, 2), '/') - 1)
          ELSE substr(folder, 2)
          END AS folderName,
          COUNT(*) AS count
        FROM files
        WHERE folder LIKE '/%' AND length(folder) > 1
          ${whereFragment}
        GROUP BY folderName
        ORDER BY folderName COLLATE NOCASE ASC`,
        ...whereParams,
      );
      return rows
        .filter(
          (row): row is { folderName: string; count: number } =>
            Boolean(row.folderName) && Number.isFinite(row.count),
        )
        .map((row) => ({ name: row.folderName, count: row.count }));
    }

    const subtree = folderSubtreeSQL("folder", base);
    const prefixLen = base.length;
    const rows = await this.db.all<{ folderName: string | null; count: number }>(
      `SELECT
         substr(folder, ?, instr(substr(folder, ?), '/') - 1) AS folderName,
         COUNT(*) AS count
       FROM files
       WHERE ${subtree.where}
          AND length(folder) > ?
          AND instr(substr(folder, ?), '/') > 0
          ${whereFragment}
       GROUP BY folderName
       ORDER BY folderName COLLATE NOCASE ASC`,
      prefixLen + 1,
      prefixLen + 1,
      ...subtree.params,
      prefixLen,
      prefixLen + 1,
      ...whereParams,
    );
    return rows
      .filter(
        (row): row is { folderName: string; count: number } =>
          Boolean(row.folderName) && Number.isFinite(row.count),
      )
      .map((row) => ({ name: row.folderName, count: row.count }));
  }

  async getDateRange(
    filter: FilterElement,
  ): Promise<{ minDate: Date | null; maxDate: Date | null }> {
    const { where, params } = filterToSQL(filter);
    return this.aggregateCache.get(queryCacheKey(`dateRange\u0000${where}`, params), () =>
      this.computeDateRange(where, params),
    );
  }

  private async computeDateRange(
    whereClause: string,
    params: ReturnType<typeof filterToSQL>["params"],
  ): Promise<{ minDate: Date | null; maxDate: Date | null }> {
    // typeof(dateTaken) = 'integer' guards against rows where dateTaken was
    // written as a TEXT/ISO string. SQLite sorts TEXT above every INTEGER, so a
    // single stray string poisons MAX(dateTaken) with garbage.
    const sql = `
      SELECT
        MIN(dateTaken) AS minDate,
        MAX(dateTaken) AS maxDate
      FROM files
      WHERE dateTaken IS NOT NULL
      AND typeof(dateTaken) = 'integer'
      ${whereClause ? `AND ${whereClause}` : ""}
    `;

    const result = await this.db.get<{
      minDate: number | null;
      maxDate: number | null;
    }>(sql, ...params);

    return {
      minDate:
        result?.minDate !== null && result?.minDate !== undefined
          ? new Date(result.minDate)
          : null,
      maxDate:
        result?.maxDate !== null && result?.maxDate !== undefined
          ? new Date(result.maxDate)
          : null,
    };
  }

  async getDateHistogram(
    filter: FilterElement,
    bucketCount = 40,
  ): Promise<DateHistogramResult> {
    const { where, params } = filterToSQL(filter);
    return this.aggregateCache.get(
      queryCacheKey(`dateHistogram\u0000${bucketCount}\u0000${where}`, params),
      () => this.computeDateHistogram(where, params, bucketCount),
    );
  }

  private async computeDateHistogram(
    whereClause: string,
    params: ReturnType<typeof filterToSQL>["params"],
    bucketCount: number,
  ): Promise<DateHistogramResult> {
    // Only integer timestamps take part: guards against TEXT dateTaken values
    // that would poison MIN/MAX and the bucket math (see getDateRange).
    const baseWhere = `dateTaken IS NOT NULL AND typeof(dateTaken) = 'integer'${
      whereClause ? ` AND ${whereClause}` : ""
    }`;

    const stats = await this.db.get<{
      total: number;
      minDate: number | null;
      maxDate: number | null;
    }>(
      `SELECT COUNT(*) AS total, MIN(dateTaken) AS minDate, MAX(dateTaken) AS maxDate
         FROM files WHERE ${baseWhere}`,
      ...params,
    );

    const total = stats?.total ?? 0;
    const trueMin = stats?.minDate ?? null;
    const trueMax = stats?.maxDate ?? null;

    if (total === 0 || trueMin === null || trueMax === null || trueMin === trueMax) {
      return {
        buckets: [],
        bucketSizeMs: 0,
        minDate: trueMin,
        maxDate: trueMax,
        grouping: "day",
      };
    }

    // Trim sparse early outliers (e.g. one photo stamped 1899) that would
    // otherwise stretch the axis and squash the meaningful range. We drop the
    // lowest ~1% by clamping the domain start to that percentile, but keep the
    // true max so recent photos are never hidden.
    const nthValue = async (offset: number): Promise<number | null> => {
      const clamped = Math.min(Math.max(offset, 0), total - 1);
      const row = await this.db.get<{ dateTaken: number }>(
        `SELECT dateTaken FROM files WHERE ${baseWhere}
           ORDER BY dateTaken LIMIT 1 OFFSET ?`,
        ...params,
        clamped,
      );
      return row?.dateTaken ?? null;
    };

    const trimmedMin =
      total >= 50 ? ((await nthValue(Math.floor(total * 0.01))) ?? trueMin) : trueMin;

    const minDate = trimmedMin;
    const maxDate = trueMax;
    const spanMs = maxDate - minDate;

    if (spanMs <= 0) {
      return { buckets: [], bucketSizeMs: 0, minDate, maxDate, grouping: "day" };
    }

    // Equal-width buckets across the (trimmed) domain give a stable number of
    // readable bars regardless of how many years the library spans.
    const count = Math.min(Math.max(Math.round(bucketCount), 12), 80);
    const bucketSizeMs = spanMs / count;

    const rows = await this.db.all<{ idx: number; count: number }>(
      `SELECT
            MIN(CAST((dateTaken - ?) / ? AS INTEGER), ?) AS idx,
            COUNT(*) AS count
          FROM files
          WHERE ${baseWhere}
            AND dateTaken >= ?
          GROUP BY idx
          ORDER BY idx`,
      minDate,
      bucketSizeMs,
      count - 1,
      ...params,
      minDate,
    );

    const counts = new Array<number>(count).fill(0);
    for (const { idx, count: c } of rows) {
      if (idx >= 0 && idx < count) counts[idx] += c;
    }

    const buckets = counts.map((c, idx) => ({
      start: Math.round(minDate + idx * bucketSizeMs),
      end: Math.round(minDate + (idx + 1) * bucketSizeMs),
      count: c,
    }));

    const dayMs = 24 * 60 * 60 * 1000;
    const spanDays = spanMs / dayMs;
    const grouping: DateHistogramGrouping =
      spanDays <= 90 ? "day" : spanDays <= 3 * 365 ? "month" : "year";

    return { buckets, bucketSizeMs, minDate, maxDate, grouping };
  }
}
