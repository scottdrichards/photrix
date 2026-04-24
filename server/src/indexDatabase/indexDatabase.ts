import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroups, type FileRecord } from "./fileRecord.type.ts";
import { filterToSQL } from "./filterToSQL.ts";
import {
  type DateHistogramResult,
  type FilterElement,
  type GeoClusterResult,
  type QueryOptions,
  type QueryResult,
} from "./indexDatabase.type.ts";
import {
  fileRecordToColumnNamesAndValues,
  rowToFileRecord,
} from "./rowFileRecordConversionFunctions.ts";
import { joinPath, normalizeFolderPath, splitPath } from "./utils/pathUtils.ts";
import { escapeLikeLiteral } from "./utils/sqlUtils.ts";
import { measureOperation } from "../observability/requestTrace.ts";
import { prepareTables } from "./prepareTables.ts";

const filesNeedingMetadataUpdateFilter = (
  metadataGroupName: keyof typeof MetadataGroups,
) =>
  `${metadataGroupName}ProcessedAt IS NULL OR ${metadataGroupName}ProcessedAt < modified`;

export class IndexDatabase {
  public readonly storagePath: string;
  private db!: AsyncSqlite;
  private dbFilePath!: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  /** Can't be part of constructor because it's async */
  async init(): Promise<void> {
    const envDbLocation = process.env.INDEX_DB_LOCATION?.trim();
    const databaseDirectory = envDbLocation || CACHE_DIR;
    this.dbFilePath = path.join(path.resolve(databaseDirectory), "index.db");
    console.log(
      `[IndexDatabase] dbFilePath=${this.dbFilePath} (INDEX_DB_LOCATION env=${envDbLocation ?? "<unset>"})`,
    );

    const directoryPath = path.dirname(this.dbFilePath);
    const rootPath = path.parse(directoryPath).root;
    if (directoryPath !== rootPath) {
      await mkdir(directoryPath, { recursive: true });
    }

    this.db = await AsyncSqlite.open(this.dbFilePath, {
      pragmas: ["journal_mode = WAL"],
      customFunctions: [
        { name: "REGEXP", options: { deterministic: true }, type: "regexp" },
        {
          name: "cosine_similarity",
          options: { deterministic: true },
          type: "cosine_similarity",
        },
      ],
    });

    await prepareTables(this.db);
    console.log(`[IndexDatabase] Database opened at ${this.dbFilePath}`);

    const count = await this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM files",
    );
    console.log(`[IndexDatabase] Contains ${count?.count ?? 0} entries`);
  }

  private async runInsert(
    columns: { names: string[]; values: unknown[] },
    options: { mode: "insert" | "replace"; errorContext: string },
  ): Promise<void> {
    const { mode, errorContext } = options;
    if (columns.names.length !== columns.values.length) {
      throw new Error(
        `SQL parameter mismatch for ${errorContext}: ${columns.names.length} column names but ${columns.values.length} values. ` +
          `Columns: ${columns.names.join(", ")}. Values: ${JSON.stringify(columns.values)}`,
      );
    }

    const placeholders = columns.values.map(() => "?").join(", ");
    const verb = mode === "replace" ? "INSERT OR REPLACE" : "INSERT";
    const sql = `${verb} INTO files (${columns.names.join(", ")}) VALUES (${placeholders})`;
    await this.db.run(sql, ...columns.values);
  }

  private async countEntries(whereClause?: string): Promise<number> {
    const sql = whereClause
      ? `SELECT COUNT(*) as count FROM files WHERE ${whereClause}`
      : "SELECT COUNT(*) as count FROM files";
    const row = await this.db.get<{ count: number }>(sql);
    return row?.count ?? 0;
  }

  async addFile(fileData: FileRecord): Promise<void> {
    const columns = fileRecordToColumnNamesAndValues(fileData);
    await this.runInsert(columns, {
      mode: "replace",
      errorContext: `${fileData.folder}${fileData.fileName}`,
    });
  }

  async moveFile(oldRelativePath: string, newRelativePath: string): Promise<void> {
    const { folder: oldFolder, fileName: oldFile } = splitPath(oldRelativePath);
    const row = await this.db.get<FileRecord>(
      "SELECT * FROM files WHERE folder = ? AND fileName = ?",
      oldFolder,
      oldFile,
    );
    if (!row) {
      throw new Error(
        `moveFile: File at path "${oldRelativePath}" does not exist in the database.`,
      );
    }

    const { folder: newFolder, fileName: newFile } = splitPath(newRelativePath);
    const updated: FileRecord = {
      ...row,
      folder: newFolder,
      fileName: newFile,
    };

    const columns = fileRecordToColumnNamesAndValues(updated);
    const placeholders = columns.values.map(() => "?").join(", ");
    await this.db.transaction([
      {
        sql: "DELETE FROM files WHERE folder = ? AND fileName = ?",
        params: [oldFolder, oldFile],
      },
      {
        sql: `INSERT INTO files (${columns.names.join(", ")}) VALUES (${placeholders})`,
        params: columns.values,
      },
    ]);
  }

  async addOrUpdateFileData(
    relativePath: string,
    fileData: Partial<FileRecord>,
  ): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    const execute = async () => {
      const row = await this.db.get<FileRecord>(
        "SELECT * FROM files WHERE folder = ? AND fileName = ?",
        folder,
        fileName,
      );
      const updatedEntry = {
        ...(row ?? {
          folder,
          fileName,
          mimeType: mimeTypeForFilename(relativePath),
        }),
        ...fileData,
      };
      const columns = fileRecordToColumnNamesAndValues(updatedEntry);
      await this.runInsert(columns, {
        mode: "replace",
        errorContext: relativePath,
      });
    };

    await this.runWithRetry(execute);
  }

  async getFileRecord(
    relativePath: string,
    _fields?: string[],
  ): Promise<FileRecord | undefined> {
    const { folder, fileName } = splitPath(relativePath);
    const row = await this.db.get<Record<string, string | number>>(
      "SELECT * FROM files WHERE folder = ? AND fileName = ?",
      folder,
      fileName,
    );
    if (!row) {
      return undefined;
    }

    return rowToFileRecord(row);
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

  async getStatusCounts(): Promise<{
    allEntries: number;
    mediaEntries: number;
    missingInfo: number;
    missingDateTaken: number;
  }> {
    const row = await this.db.get<{
      allEntries: number | null;
      mediaEntries: number | null;
      missingInfo: number | null;
      missingDateTaken: number | null;
    }>(
      `SELECT
         COUNT(*) AS allEntries,
         SUM(CASE WHEN mimeType LIKE 'image/%' OR mimeType LIKE 'video/%' THEN 1 ELSE 0 END) AS mediaEntries,
         SUM(CASE WHEN sizeInBytes IS NULL OR created IS NULL OR modified IS NULL THEN 1 ELSE 0 END) AS missingInfo,
         SUM(CASE WHEN (mimeType LIKE 'image/%' OR mimeType LIKE 'video/%')
                    AND dateTaken IS NULL
                    AND exifProcessedAt IS NULL
                  THEN 1 ELSE 0 END) AS missingDateTaken
       FROM files`,
    );

    return {
      allEntries: row?.allEntries ?? 0,
      mediaEntries: row?.mediaEntries ?? 0,
      missingInfo: row?.missingInfo ?? 0,
      missingDateTaken: row?.missingDateTaken ?? 0,
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
      exifProcessedAt: string;
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
      completedAt: row.exifProcessedAt,
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

  async addPaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const pathStatements = paths.map((relativePath) => {
      const { folder, fileName } = splitPath(relativePath);
      const mimeType = mimeTypeForFilename(relativePath);
      return {
        sql: "INSERT OR IGNORE INTO files (folder, fileName, mimeType) VALUES (?, ?, ?)",
        params: [folder, fileName, mimeType] as unknown[],
      };
    });
    await this.db.transaction(pathStatements);
  }

  /** Removes a file and returns success status. */
  async removeFile(relativePath: string): Promise<boolean> {
    const { folder, fileName } = splitPath(relativePath);
    const result = await this.db.run(
      "DELETE FROM files WHERE folder = ? AND fileName = ?",
      [folder, fileName],
    );
    return result.changes === 1;
  }

  async removePaths(paths: string[]): Promise<void> {
    if (!paths.length) return;

    const statements = paths.map((relativePath) => {
      const { folder, fileName } = splitPath(relativePath);
      return {
        sql: "DELETE FROM files WHERE folder = ? AND fileName = ?",
        params: [folder, fileName] as unknown[],
      };
    });

    await this.db.transaction(statements);
  }

  async removeFolder(relativePath: string): Promise<void> {
    const base = normalizeFolderPath(relativePath);
    const statements = [
      {
        sql: "DELETE FROM files WHERE folder LIKE ? ESCAPE '\\'",
        params: [`${escapeLikeLiteral(base)}%`],
      },
    ];
    await this.db.transaction(statements);
  }

  async countFilesNeedingMetadataUpdate(
    metadataGroupName: keyof typeof MetadataGroups,
  ): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM files WHERE ${filesNeedingMetadataUpdateFilter(metadataGroupName)}`,
    );
    return row?.count ?? 0;
  }

  async getFilesNeedingMetadataUpdate(
    metadataGroupName: keyof typeof MetadataGroups,
    limit = 200,
  ): Promise<
    Array<
      {
        relativePath: string;
        mimeType: string | null;
        sizeInBytes?: number;
      } & { [key in `${keyof typeof MetadataGroups}ProcessedAt`]?: string | null }
    >
  > {
    // Only the NULL-first branch is index-friendly. Cross-column comparison
    // (`exifProcessedAt < modified`) requires a full table scan that freezes the
    // synchronous read worker for many seconds on large libraries. Stale-mtime
    // detection is handled by the rescan path instead of this hot polling loop.
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT folder, fileName, mimeType, sizeInBytes, ${metadataGroupName}ProcessedAt FROM files
       WHERE ${metadataGroupName}ProcessedAt IS NULL
       LIMIT ?`,
      limit,
    );

    return rows.map((row) => {
      const relativePath = joinPath(row.folder as string, row.fileName as string);
      const mimeType =
        (row.mimeType as string | null) ?? mimeTypeForFilename(relativePath) ?? null;
      const processedAt = row[metadataGroupName + "ProcessedAt"];

      return {
        relativePath,
        mimeType,
        sizeInBytes: typeof row.sizeInBytes === "number" ? row.sizeInBytes : undefined,
        [metadataGroupName + "ProcessedAt"]:
          typeof processedAt === "string" || processedAt === null
            ? processedAt
            : undefined,
      };
    });
  }

  async allFiles(): Promise<FileRecord[]> {
    const rows =
      await this.db.all<Record<string, string | number>>("SELECT * FROM files");
    return rows.map((row) => rowToFileRecord(row));
  }

  async getFolders(relativePath: string): Promise<Array<string>> {
    const base = normalizeFolderPath(relativePath);

    if (base === "/") {
      const rows = await this.db.all<{ folderName: string | null }>(
        `SELECT DISTINCT 
         CASE 
         WHEN instr(substr(folder, 2), '/') > 0 
         THEN substr(folder, 2, instr(substr(folder, 2), '/') - 1)
         ELSE substr(folder, 2)
         END AS folderName
       FROM files
       WHERE folder LIKE '/%' AND length(folder) > 1
       ORDER BY folderName`,
      );
      return rows
        .map((row) => row.folderName)
        .filter((v): v is string => Boolean(v))
        .sort((a, b) => a.localeCompare(b));
    }

    const escapedPrefix = escapeLikeLiteral(base);
    const prefixLen = base.length;
    const rows = await this.db.all<{ folderName: string | null }>(
      `SELECT DISTINCT 
         substr(folder, ?, instr(substr(folder, ?), '/') - 1) AS folderName
       FROM files
       WHERE folder LIKE ? ESCAPE '\\'
         AND length(folder) > ?
         AND instr(substr(folder, ?), '/') > 0
       ORDER BY folderName`,
      prefixLen + 1,
      prefixLen + 1,
      `${escapedPrefix}%`,
      prefixLen,
      prefixLen + 1,
    );
    return rows
      .map((row) => row.folderName)
      .filter((v): v is string => Boolean(v))
      .sort((a, b) => a.localeCompare(b));
  }

  async queryFieldSuggestions(options: {
    field:
      | "personInImage"
      | "tags"
      | "aiTags"
      | "cameraMake"
      | "cameraModel"
      | "lens"
      | "rating";
    search: string;
    filter: FilterElement;
    limit?: number;
  }): Promise<string[]> {
    const { field, search, filter } = options;
    const limit = Math.max(1, Math.min(100, options.limit ?? 8));
    const normalizedSearch = search.trim();

    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const likeQuery =
      normalizedSearch.length === 0 ? "%" : `%${escapeLikeLiteral(normalizedSearch)}%`;
    const whereFragment = whereClause ? `AND (${whereClause})` : "";

    if (field === "personInImage" || field === "tags" || field === "aiTags") {
      const rows = await this.db.all<{ suggestion: string }>(
        `SELECT DISTINCT json_each.value AS suggestion
         FROM files, json_each(${field})
         WHERE files.${field} IS NOT NULL
           AND json_each.value IS NOT NULL
           AND json_each.value != ''
           AND json_each.value LIKE ? ESCAPE '\\'
           ${whereFragment}
         ORDER BY suggestion COLLATE NOCASE ASC
         LIMIT ?`,
        likeQuery,
        ...whereParams,
        limit,
      );

      return rows
        .map((row) => row.suggestion)
        .filter((value) => typeof value === "string" && value.length > 0);
    }

    if (field === "rating") {
      const rows = await this.db.all<{ suggestion: string }>(
        `SELECT DISTINCT CAST(rating AS TEXT) AS suggestion
         FROM files
         WHERE rating IS NOT NULL
           AND CAST(rating AS TEXT) LIKE ? ESCAPE '\\'
           ${whereFragment}
         ORDER BY CAST(suggestion AS INTEGER) DESC
         LIMIT ?`,
        likeQuery,
        ...whereParams,
        limit,
      );

      return rows
        .map((row) => row.suggestion)
        .filter((value) => typeof value === "string" && value.length > 0);
    }

    const rows = await this.db.all<{ suggestion: string }>(
      `SELECT DISTINCT ${field} AS suggestion
       FROM files
       WHERE ${field} IS NOT NULL
         AND ${field} != ''
         AND ${field} LIKE ? ESCAPE '\\'
         ${whereFragment}
       ORDER BY suggestion COLLATE NOCASE ASC
       LIMIT ?`,
      likeQuery,
      ...whereParams,
      limit,
    );

    return rows
      .map((row) => row.suggestion)
      .filter((value) => typeof value === "string" && value.length > 0);
  }

  async queryFieldSuggestionsWithCounts(options: {
    field:
      | "personInImage"
      | "tags"
      | "aiTags"
      | "cameraMake"
      | "cameraModel"
      | "lens"
      | "rating";
    search: string;
    filter: FilterElement;
    limit?: number;
  }): Promise<Array<{ value: string; count: number }>> {
    const { field, search, filter } = options;
    const limit = Math.max(1, Math.min(100, options.limit ?? 8));
    const normalizedSearch = search.trim();

    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const likeQuery =
      normalizedSearch.length === 0 ? "%" : `%${escapeLikeLiteral(normalizedSearch)}%`;
    const whereFragment = whereClause ? `AND (${whereClause})` : "";

    if (field === "personInImage" || field === "tags" || field === "aiTags") {
      const rows = await this.db.all<{
        suggestion: string;
        count: number;
      }>(
        `SELECT
             json_each.value AS suggestion,
             COUNT(DISTINCT files.folder || files.fileName) AS count
           FROM files, json_each(${field})
           WHERE files.${field} IS NOT NULL
             AND json_each.value IS NOT NULL
             AND json_each.value != ''
             AND json_each.value LIKE ? ESCAPE '\\'
             ${whereFragment}
           GROUP BY json_each.value
           ORDER BY count DESC, suggestion COLLATE NOCASE ASC
           LIMIT ?`,
        likeQuery,
        ...whereParams,
        limit,
      );

      return rows
        .filter(
          (row) =>
            typeof row.suggestion === "string" &&
            row.suggestion.length > 0 &&
            Number.isFinite(row.count),
        )
        .map((row) => ({ value: row.suggestion, count: row.count }));
    }

    if (field === "rating") {
      const rows = await this.db.all<{ suggestion: string; count: number }>(
        `SELECT
             CAST(rating AS TEXT) AS suggestion,
             COUNT(*) AS count
           FROM files
           WHERE rating IS NOT NULL
             AND CAST(rating AS TEXT) LIKE ? ESCAPE '\\'
             ${whereFragment}
           GROUP BY rating
           ORDER BY CAST(suggestion AS INTEGER) DESC
           LIMIT ?`,
        likeQuery,
        ...whereParams,
        limit,
      );

      return rows
        .filter(
          (row) =>
            typeof row.suggestion === "string" &&
            row.suggestion.length > 0 &&
            Number.isFinite(row.count),
        )
        .map((row) => ({ value: row.suggestion, count: row.count }));
    }

    const rows = await this.db.all<{ suggestion: string; count: number }>(
      `SELECT
           ${field} AS suggestion,
           COUNT(*) AS count
         FROM files
         WHERE ${field} IS NOT NULL
           AND ${field} != ''
           AND ${field} LIKE ? ESCAPE '\\'
           ${whereFragment}
         GROUP BY ${field}
         ORDER BY count DESC, suggestion COLLATE NOCASE ASC
         LIMIT ?`,
      likeQuery,
      ...whereParams,
      limit,
    );

    return rows
      .filter(
        (row) =>
          typeof row.suggestion === "string" &&
          row.suggestion.length > 0 &&
          Number.isFinite(row.count),
      )
      .map((row) => ({ value: row.suggestion, count: row.count }));
  }

  async queryGeoClusters(options: {
    filter: QueryOptions["filter"];
    clusterSize: number;
    bounds?: { west: number; east: number; north: number; south: number } | null;
  }): Promise<GeoClusterResult> {
    const { filter, clusterSize, bounds } = options;
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const bucket = Math.max(clusterSize, 0.00000001);
    const latOrigin = Math.floor((bounds?.south ?? 0) / bucket) * bucket;
    const lonOrigin = Math.floor((bounds?.west ?? 0) / bucket) * bucket;

    const rows = await this.db.all<{
      latitude: number;
      longitude: number;
      count: number;
      samplePath: string | null;
      sampleName: string | null;
    }>(
      `WITH buckets AS (
         SELECT
           CAST(FLOOR((locationLatitude - ?) / ?) AS INTEGER) AS latBucket,
           CAST(FLOOR((locationLongitude - ?) / ?) AS INTEGER) AS lonBucket,
           locationLatitude,
           locationLongitude,
           folder,
           fileName
         FROM files
         WHERE locationLatitude IS NOT NULL
           AND locationLongitude IS NOT NULL
           ${whereClause ? `AND ${whereClause}` : ""}
       ),
       agg AS (
         SELECT
           latBucket,
           lonBucket,
           COUNT(*) AS count
         FROM buckets
         GROUP BY latBucket, lonBucket
       ),
       ranked AS (
         SELECT
           b.latBucket,
           b.lonBucket,
           b.locationLatitude,
           b.locationLongitude,
           b.folder,
           b.fileName,
           ROW_NUMBER() OVER (PARTITION BY b.latBucket, b.lonBucket ORDER BY b.folder, b.fileName) AS rn
         FROM buckets b
       )
       SELECT
         (a.latBucket + 0.5) * ? + ? AS latitude,
         (a.lonBucket + 0.5) * ? + ? AS longitude,
         a.count AS count,
         MIN(CASE WHEN r.rn = 1 THEN r.folder || r.fileName END) AS samplePath,
         MIN(CASE WHEN r.rn = 1 THEN r.fileName END) AS sampleName
       FROM agg a
       JOIN ranked r ON r.latBucket = a.latBucket AND r.lonBucket = a.lonBucket
       GROUP BY a.latBucket, a.lonBucket
       ORDER BY count DESC`,
      latOrigin,
      bucket,
      lonOrigin,
      bucket,
      ...whereParams,
      bucket,
      latOrigin,
      bucket,
      lonOrigin,
    );

    const total = rows.reduce((sum, row) => sum + (row.count ?? 0), 0);

    return {
      clusters: rows,
      total,
    };
  }

  async queryFiles<TMetadata extends Array<keyof FileRecord>>(
    options: QueryOptions,
  ): Promise<QueryResult<TMetadata>> {
    const { filter, metadata, pageSize = 1_000, page: rawPage = 1 } = options;
    const page = Math.max(1, rawPage);

    const { where: whereClause, params: whereParams } = filterToSQL(filter);

    const countSQL = `SELECT COUNT(*) as count FROM files ${whereClause ? `WHERE ${whereClause}` : ""}`;
    const countResult = await measureOperation(
      "queryFiles.count",
      () => this.db.get<{ count: number }>(countSQL, ...whereParams),
      { category: "db" },
    );
    const total = countResult?.count ?? 0;

    // The `idx_files_sort_date` expression index covers this ORDER BY exactly
    // (verified via EXPLAIN: "SCAN files USING INDEX idx_files_sort_date").
    const offset = (page - 1) * pageSize;
    const mainSQL = `
      SELECT * FROM files
      ${whereClause ? `WHERE ${whereClause}` : ""}
      ORDER BY COALESCE(dateTaken, created, modified) DESC
      LIMIT ? OFFSET ?
    `;

    const rows = await measureOperation(
      "queryFiles.rows",
      () =>
        this.db.all<Record<string, unknown>>(mainSQL, ...whereParams, pageSize, offset),
      { category: "db", detail: `limit=${pageSize} offset=${offset}` },
    );

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

  async getDateRange(
    filter: FilterElement,
  ): Promise<{ minDate: Date | null; maxDate: Date | null }> {
    const { where: whereClause, params } = filterToSQL(filter);
    const sql = `
      SELECT
        MIN(dateTaken) AS minDate,
        MAX(dateTaken) AS maxDate
      FROM files
      WHERE dateTaken IS NOT NULL
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

  async getDateHistogram(filter: FilterElement): Promise<DateHistogramResult> {
    const range = await this.getDateRange(filter);
    const minDate = range.minDate?.getTime() ?? null;
    const maxDate = range.maxDate?.getTime() ?? null;

    if (minDate === null || maxDate === null || minDate === maxDate) {
      return { buckets: [], bucketSizeMs: 0, minDate, maxDate, grouping: "day" };
    }

    const spanMs = maxDate - minDate;
    const dayMs = 24 * 60 * 60 * 1000;
    const spanDays = spanMs / dayMs;
    const monthDiff = (dateA: number, dateB: number) => {
      const a = new Date(dateA);
      const b = new Date(dateB);
      return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    };

    // If the range is tight (within ~2 months) keep daily granularity; otherwise month buckets.
    const grouping: "day" | "month" =
      monthDiff(minDate, maxDate) <= 2 || spanDays <= 120 ? "day" : "month";
    const bucketFormat = grouping === "day" ? "%Y-%m-%d" : "%Y-%m-01";

    const { where: whereClause, params } = filterToSQL(filter);
    const rows = await this.db.all<{ bucket: string; count: number }>(
      `SELECT
            strftime('${bucketFormat}', datetime(dateTaken / 1000, 'unixepoch')) AS bucket,
            COUNT(*) AS count
          FROM files
          WHERE dateTaken IS NOT NULL
          ${whereClause ? `AND ${whereClause}` : ""}
          GROUP BY bucket
          ORDER BY bucket`,
      ...params,
    );

    const buckets = rows.map(({ bucket, count }) => {
      const start =
        grouping === "day"
          ? Date.UTC(
              Number(bucket.slice(0, 4)),
              Number(bucket.slice(5, 7)) - 1,
              Number(bucket.slice(8, 10)),
            )
          : Date.UTC(Number(bucket.slice(0, 4)), Number(bucket.slice(5, 7)) - 1, 1);

      const end =
        grouping === "day"
          ? start + dayMs
          : Date.UTC(Number(bucket.slice(0, 4)), Number(bucket.slice(5, 7)), 1);

      return { start, end, count };
    });

    const bucketSizeMs =
      grouping === "day" ? dayMs : buckets[0] ? buckets[0].end - buckets[0].start : 0;

    return { buckets, bucketSizeMs, minDate, maxDate, grouping };
  }

  async getSize(): Promise<number> {
    const result = await this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM files",
    );
    return result?.count ?? 0;
  }

  /**
   * Returns the next background task (image variants or HLS) that needs to be generated.
   * Prioritizes images, then videos. Returns null if nothing needs conversion.
   */
  async getNextBackgroundTask(): Promise<{
    type: "imageVariants" | "hls";
    relativePath: string;
    mimeType: string;
    duration?: number;
  } | null> {
    // Try to find an image that needs variants generated
    const imageTask = await this.db.get<{
      folder: string;
      fileName: string;
      mimeType: string;
    }>(
      `SELECT folder, fileName, mimeType
       FROM files
       WHERE mimeType LIKE 'image/%'
         AND imageVariantsGeneratedAt IS NULL
         AND infoProcessedAt IS NOT NULL
       LIMIT 1`,
    );

    if (imageTask) {
      return {
        type: "imageVariants",
        relativePath: joinPath(imageTask.folder, imageTask.fileName),
        mimeType: imageTask.mimeType,
      };
    }

    // Try to find a video that needs HLS generated
    const hlsTask = await this.db.get<{
      folder: string;
      fileName: string;
      mimeType: string;
      duration: number | null;
    }>(
      `SELECT folder, fileName, mimeType, duration
       FROM files
       WHERE mimeType LIKE 'video/%'
         AND hlsGeneratedAt IS NULL
         AND exifProcessedAt IS NOT NULL
       LIMIT 1`,
    );

    if (hlsTask) {
      return {
        type: "hls",
        relativePath: joinPath(hlsTask.folder, hlsTask.fileName),
        mimeType: hlsTask.mimeType,
        duration: hlsTask.duration ?? undefined,
      };
    }

    return null;
  }

  /**
   * Marks that image variants have been generated for a file.
   */
  async markImageVariantsGenerated(relativePath: string): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    await this.db.run(
      `UPDATE files
       SET imageVariantsGeneratedAt = datetime('now')
       WHERE folder = ? AND fileName = ?`,
      folder,
      fileName,
    );
  }

  /**
   * Marks that HLS has been generated for a file.
   */
  async markHLSGenerated(relativePath: string): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    await this.db.run(
      `UPDATE files
       SET hlsGeneratedAt = datetime('now')
       WHERE folder = ? AND fileName = ?`,
      folder,
      fileName,
    );
  }

  private async runWithRetry<T>(fn: () => T | Promise<T>, attempts = 5): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("busy")) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10 * (i + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
