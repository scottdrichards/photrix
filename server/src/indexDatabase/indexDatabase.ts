import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroups, type FileRecord } from "./fileRecord.type.ts";
import { filterToSQL } from "./filterToSQL.ts";
import {
  ConversionTaskPriority,
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

export class IndexDatabase {
  public readonly storagePath: string;
  private db!: AsyncSqlite;
  private dbFilePath!: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  static async create(storagePath: string): Promise<IndexDatabase> {
    const instance = new IndexDatabase(storagePath);
    await instance.init();
    return instance;
  }

  async init(): Promise<void> {
    const envDbLocation = process.env.INDEX_DB_LOCATION?.trim();
    const databaseDirectory = envDbLocation || CACHE_DIR;
    this.dbFilePath = path.join(path.resolve(databaseDirectory), "index.db");

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

    await this.migrateConversionTasksToOwnTable();
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

  private async migrateConversionTasksToOwnTable(): Promise<void> {
    const tables = await this.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='files'",
    );
    if (!tables.length) return;

    // Deduplicate files rows (keep the one with the highest rowid, which was inserted last).
    // This is needed so that CREATE UNIQUE INDEX on (folder, fileName) can succeed.
    await this.db.exec(`
      DELETE FROM files
      WHERE rowid NOT IN (
        SELECT MAX(rowid)
        FROM files
        GROUP BY folder, fileName
      )
    `);

    const columns = await this.db.all<{ name: string }>("PRAGMA table_info(files)");
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("thumbnailConversionPriority")) return;

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversion_tasks (
        folder TEXT,
        fileName TEXT,
        taskType TEXT,
        priority INTEGER,
        prioritySetAt TEXT,
        PRIMARY KEY (folder, fileName, taskType)
      )
    `);

    await this.db.exec(`
      INSERT OR IGNORE INTO conversion_tasks (folder, fileName, taskType, priority, prioritySetAt)
      SELECT folder, fileName, 'thumbnail', thumbnailConversionPriority, thumbnailConversionPrioritySetAt
      FROM files
      WHERE thumbnailConversionPriority IS NOT NULL
    `);

    if (columnNames.has("hlsConversionPriority")) {
      await this.db.exec(`
        INSERT OR IGNORE INTO conversion_tasks (folder, fileName, taskType, priority, prioritySetAt)
        SELECT folder, fileName, 'hls', hlsConversionPriority, hlsConversionPrioritySetAt
        FROM files
        WHERE hlsConversionPriority IS NOT NULL
      `);
    }

    console.log("[IndexDatabase] Migrated conversion tasks to own table");
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
      {
        sql: "UPDATE conversion_tasks SET folder = ?, fileName = ? WHERE folder = ? AND fileName = ?",
        params: [newFolder, newFile, oldFolder, oldFile],
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

  async countPendingConversions(): Promise<{ thumbnail: number; hls: number }> {
    const t = await this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM conversion_tasks WHERE taskType = 'thumbnail' AND priority >= ${ConversionTaskPriority.UserBlocked}`,
    );
    const h = await this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM conversion_tasks WHERE taskType = 'hls' AND priority >= ${ConversionTaskPriority.UserBlocked}`,
    );
    return { thumbnail: t?.c ?? 0, hls: h?.c ?? 0 };
  }

  async getConversionQueueSummary(): Promise<{
    completed: {
      image: { count: number; sizeBytes: number };
      video: { count: number; sizeBytes: number; durationMilliseconds: number };
    };
    active: {
      image: { count: number; sizeBytes: number };
      video: { count: number; sizeBytes: number; durationMilliseconds: number };
    };
    userBlocked: {
      image: { count: number; sizeBytes: number };
      video: { count: number; sizeBytes: number; durationMilliseconds: number };
    };
    userImplicit: {
      image: { count: number; sizeBytes: number };
      video: { count: number; sizeBytes: number; durationMilliseconds: number };
    };
    background: {
      image: { count: number; sizeBytes: number };
      video: { count: number; sizeBytes: number; durationMilliseconds: number };
    };
  }> {
    const makeBucket = () => ({
      image: { count: 0, sizeBytes: 0 },
      video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
    });
    const summary = {
      completed: makeBucket(),
      active: makeBucket(),
      userBlocked: makeBucket(),
      userImplicit: makeBucket(),
      background: makeBucket(),
    };
    const bucketForPriority: Record<ConversionTaskPriority, typeof summary.background> = {
      [ConversionTaskPriority.InProgress]: summary.active,
      [ConversionTaskPriority.UserBlocked]: summary.userBlocked,
      [ConversionTaskPriority.UserImplicit]: summary.userImplicit,
      [ConversionTaskPriority.Background]: summary.background,
    };

    const rows = await this.db.all<{
      mediaType: string;
      priority: ConversionTaskPriority;
      cnt: number;
      sizeBytes: number;
      durationMs: number;
    }>(
      `SELECT
         CASE WHEN f.mimeType LIKE 'video/%' THEN 'video' ELSE 'image' END AS mediaType,
         ct.priority,
         COUNT(*) AS cnt,
         COALESCE(SUM(MAX(0, COALESCE(f.sizeInBytes, 0))), 0) AS sizeBytes,
         COALESCE(SUM(CASE WHEN f.mimeType LIKE 'video/%' THEN MAX(0, ROUND(COALESCE(f.duration, 0) * 1000)) ELSE 0 END), 0) AS durationMs
       FROM conversion_tasks ct
       JOIN files f ON f.folder = ct.folder AND f.fileName = ct.fileName
       WHERE ct.taskType = 'thumbnail'
       GROUP BY mediaType, ct.priority
       UNION ALL
       SELECT
         'video' AS mediaType,
         ct.priority,
         COUNT(*) AS cnt,
         COALESCE(SUM(MAX(0, COALESCE(f.sizeInBytes, 0))), 0) AS sizeBytes,
         COALESCE(SUM(MAX(0, ROUND(COALESCE(f.duration, 0) * 1000))), 0) AS durationMs
       FROM conversion_tasks ct
       JOIN files f ON f.folder = ct.folder AND f.fileName = ct.fileName
       WHERE ct.taskType = 'hls' AND f.mimeType LIKE 'video/%'
       GROUP BY ct.priority`,
    );

    for (const row of rows) {
      const bucket = bucketForPriority[row.priority] ?? summary.background;
      const mediaType = row.mediaType as "image" | "video";
      bucket[mediaType].count += row.cnt;
      bucket[mediaType].sizeBytes += row.sizeBytes;
      if (mediaType === "video") {
        bucket.video.durationMilliseconds += row.durationMs;
      }
    }

    return summary;
  }

  /**
   * null = done (row deleted), enum value = queued or in-progress
   */
  async setConversionPriority(
    relativePath: string,
    taskType: "thumbnail" | "hls",
    priority: ConversionTaskPriority | null,
  ): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    if (priority === null) {
      await this.db.run(
        "DELETE FROM conversion_tasks WHERE folder = ? AND fileName = ? AND taskType = ?",
        folder,
        fileName,
        taskType,
      );
      return;
    }
    await this.db.run(
      `INSERT OR REPLACE INTO conversion_tasks (folder, fileName, taskType, priority, prioritySetAt)
       VALUES (?, ?, ?, ?, ?)`,
      folder,
      fileName,
      taskType,
      priority,
      new Date().toISOString(),
    );
  }

  /**
   * Raises the conversion priority for a batch of files, but never lowers it.
   * Files with a higher-priority (lower numeric value) are left unchanged.
   * Files without a pending conversion task are left unchanged.
   */
  async raiseConversionPriority(
    relativePaths: string[],
    taskType: "thumbnail" | "hls",
    priority: ConversionTaskPriority,
  ): Promise<void> {
    if (!relativePaths.length) return;
    const now = new Date().toISOString();
    const statements = relativePaths.map((relativePath) => {
      const { folder, fileName } = splitPath(relativePath);
      return {
        sql: `UPDATE conversion_tasks SET priority = ?, prioritySetAt = ?
              WHERE folder = ? AND fileName = ? AND taskType = ? AND priority > ?`,
        params: [priority, now, folder, fileName, taskType, priority] as unknown[],
      };
    });
    await this.db.transaction(statements);
  }

  async resetInProgressConversions(taskType: "thumbnail" | "hls"): Promise<void> {
    await this.db.run(
      `UPDATE conversion_tasks SET priority = ?, prioritySetAt = ?
       WHERE taskType = ? AND priority = ?`,
      ConversionTaskPriority.Background,
      new Date().toISOString(),
      taskType,
      ConversionTaskPriority.InProgress,
    );
  }

  /**
   * Returns the next pending conversion task ordered by priority (ASC), then by when the
   * priority was set (FIFO for most priorities, LIFO for userImplicit), then thumbnails
   * before HLS for equal priority and time. Excludes in-progress tasks.
   *
   * Uses two separate queries (thumbnail and HLS) merged in TypeScript.
   */
  async getNextConversionTasks(count = 1): Promise<
    Array<{
      relativePath: string;
      taskType: "thumbnail" | "hls";
    }>
  > {
    type CandidateRow = {
      folder: string;
      fileName: string;
      priority: number;
      prioritySetAt: string;
    };
    const lifo = ConversionTaskPriority.UserImplicit;

    const thumbnailRows = await this.db.all<CandidateRow>(
      `SELECT folder, fileName, priority, prioritySetAt
       FROM conversion_tasks
       WHERE taskType = 'thumbnail' AND priority >= ${ConversionTaskPriority.UserBlocked}
       ORDER BY priority ASC,
         CASE WHEN priority = ${lifo} THEN -strftime('%s', prioritySetAt)
              ELSE strftime('%s', prioritySetAt) END ASC
       LIMIT ?`,
      count,
    );

    const hlsRows = await this.db.all<CandidateRow>(
      `SELECT folder, fileName, priority, prioritySetAt
       FROM conversion_tasks
       WHERE taskType = 'hls' AND priority >= ${ConversionTaskPriority.UserBlocked}
       ORDER BY priority ASC,
         CASE WHEN priority = ${lifo} THEN -strftime('%s', prioritySetAt)
              ELSE strftime('%s', prioritySetAt) END ASC
       LIMIT ?`,
      count,
    );

    const tagged = [
      ...thumbnailRows.map((r) => ({
        ...r,
        taskType: "thumbnail" as const,
        taskOrder: 0,
      })),
      ...hlsRows.map((r) => ({ ...r, taskType: "hls" as const, taskOrder: 1 })),
    ];

    tagged.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.prioritySetAt !== b.prioritySetAt) {
        const chronological = a.prioritySetAt < b.prioritySetAt ? -1 : 1;
        return a.priority === lifo ? -chronological : chronological;
      }
      return a.taskOrder - b.taskOrder;
    });

    return tagged.slice(0, count).map((row) => ({
      relativePath: joinPath(row.folder, row.fileName),
      taskType: row.taskType,
    }));
  }

  async getConversionTaskInfo(
    relativePath: string,
    taskType: "thumbnail" | "hls",
  ): Promise<{
    mimeType: string | null;
    duration: number | null;
    priority: ConversionTaskPriority | null;
  } | null> {
    const { folder, fileName } = splitPath(relativePath);
    const row = await this.db.get<{
      mimeType: string | null;
      duration: number | null;
      priority: ConversionTaskPriority | null;
    }>(
      `SELECT f.mimeType, f.duration, ct.priority
       FROM files f
       LEFT JOIN conversion_tasks ct ON ct.folder = f.folder AND ct.fileName = f.fileName AND ct.taskType = ?
       WHERE f.folder = ? AND f.fileName = ?`,
      taskType,
      folder,
      fileName,
    );
    return row ?? null;
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
      const needsThumbnail =
        mimeType?.startsWith("image/") || mimeType?.startsWith("video/");
      return {
        fileStatement: {
          sql: "INSERT OR IGNORE INTO files (folder, fileName, mimeType) VALUES (?, ?, ?)",
          params: [folder, fileName, mimeType] as unknown[],
        },
        taskStatement: needsThumbnail
          ? {
              sql: `INSERT OR IGNORE INTO conversion_tasks (folder, fileName, taskType, priority, prioritySetAt)
                    VALUES (?, ?, 'thumbnail', ?, ?)`,
              params: [
                folder,
                fileName,
                ConversionTaskPriority.Background,
                new Date().toISOString(),
              ] as unknown[],
            }
          : null,
      };
    });
    const allStatements = pathStatements.flatMap(({ fileStatement, taskStatement }) =>
      taskStatement ? [fileStatement, taskStatement] : [fileStatement],
    );
    await this.db.transaction(allStatements);
  }

  async countFilesNeedingMetadataUpdate(
    metadataGroupName: keyof typeof MetadataGroups,
  ): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM files WHERE ${metadataGroupName}ProcessedAt IS NULL`,
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
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT folder, fileName, mimeType, sizeInBytes, ${metadataGroupName}ProcessedAt FROM files
       WHERE ${metadataGroupName}ProcessedAt IS NULL
       ORDER BY created DESC, folder DESC, fileName DESC
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
    console.log(
      `[query] Starting query: filter=${JSON.stringify(filter)}, metadata=${JSON.stringify(metadata)}, page=${page}, pageSize=${pageSize}`,
    );
    const startTime = Date.now();

    // Convert filter to SQL
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    console.log(
      `[query] Generated SQL WHERE: "${whereClause}" with params: ${JSON.stringify(whereParams)}`,
    );

    // Build the count query
    const countSQL = `SELECT COUNT(*) as count FROM files ${whereClause ? `WHERE ${whereClause}` : ""}`;
    const countResult = await measureOperation(
      "queryFiles.count",
      () => this.db.get<{ count: number }>(countSQL, ...whereParams),
      { category: "db" },
    );
    const total = countResult?.count ?? 0;

    // Build the main query with sorting and pagination
    const offset = (page - 1) * pageSize;
    const mainSQL = `
      SELECT * FROM files 
      ${whereClause ? `WHERE ${whereClause}` : ""}
      ORDER BY COALESCE(CAST(dateTaken AS INTEGER), CAST(created AS INTEGER), CAST(modified AS INTEGER), 0) DESC, folder ASC, fileName ASC
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

    const result = {
      items: matchedFiles as Array<
        { folder: string; fileName: string } & Pick<FileRecord, TMetadata[number]>
      >,
      page,
      pageSize,
      total,
    } as QueryResult<TMetadata>;
    const elapsed = Date.now() - startTime;
    console.log(
      `[query] Completed in ${elapsed}ms: ${result.total} total items, ${result.items.length} items on page`,
    );
    return result;
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
