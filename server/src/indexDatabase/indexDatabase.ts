import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroups, type FaceTag, type FileRecord } from "./fileRecord.type.ts";
import { filterToSQL } from "./filterToSQL.ts";
import {
  ConversionTaskPriority,
  type DateHistogramResult,
  type FaceMatchItem,
  type FacePeopleItem,
  type FaceQueueResult,
  type FaceQueueStatus,
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

const embeddingToBlob = (embedding: number[]): Buffer => {
  const arr = new Float64Array(embedding);
  return Buffer.from(arr.buffer);
};

const blobToEmbedding = (blob: Buffer | Uint8Array): number[] => {
  const arr = new Float64Array(blob.buffer, blob.byteOffset, blob.byteLength / 8);
  return Array.from(arr);
};

const getFaceId = (folder: string, fileName: string, tag: FaceTag, index: number): string =>
  typeof tag.faceId === "string" && tag.faceId.trim().length > 0
    ? tag.faceId
    : `${folder}${fileName}#${index}`;

const parseFaceTags = (faceTags: string | null): FaceTag[] => {
  if (!faceTags) {
    return [];
  }
  try {
    const parsed = JSON.parse(faceTags);
    return Array.isArray(parsed) ? (parsed as FaceTag[]) : [];
  } catch {
    return [];
  }
};

const getFaceEmbedding = (tag: FaceTag): number[] | null => {
  if (!tag.featureDescription || typeof tag.featureDescription !== "object") {
    return null;
  }
  const candidate = (tag.featureDescription as { embedding?: unknown }).embedding;
  if (!Array.isArray(candidate) || candidate.length === 0) {
    return null;
  }
  const values = candidate.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return values.length > 0 ? values : null;
};

const embeddingWeight = (quality?: { overall?: number; effectiveResolution?: number }): number => {
  const overall = quality?.overall ?? 0.2;
  const effectiveResolution = quality?.effectiveResolution ?? 64;
  const normalizedResolution = Math.max(0.1, Math.min(effectiveResolution / 256, 2));
  return Math.max(0.1, overall * normalizedResolution);
};

const buildWeightedCentroid = (
  entries: Array<{ embedding: number[]; weight: number }>,
): number[] | null => {
  if (entries.length === 0) {
    return null;
  }
  const dimensions = Math.min(...entries.map((entry) => entry.embedding.length));
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    return null;
  }
  const sum = new Array(dimensions).fill(0) as number[];
  let totalWeight = 0;
  for (const entry of entries) {
    const weight = Math.max(0.1, entry.weight);
    totalWeight += weight;
    for (let index = 0; index < dimensions; index += 1) {
      sum[index] += (entry.embedding[index] ?? 0) * weight;
    }
  }
  if (totalWeight <= 0) {
    return null;
  }
  return sum.map((value) => value / totalWeight);
};

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
        { name: "cosine_similarity", options: { deterministic: true }, type: "cosine_similarity" },
      ],
    });

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        folder TEXT NOT NULL,
        fileName TEXT NOT NULL,
        mimeType TEXT,
        sizeInBytes INTEGER,
        created TEXT,
        modified TEXT,
        dateTaken TEXT,
        dimensionsWidth INTEGER,
        dimensionsHeight INTEGER,
        locationLatitude REAL,
        locationLongitude REAL,
        cameraMake TEXT,
        cameraModel TEXT,
        exposureTime TEXT,
        aperture TEXT,
        iso INTEGER,
        focalLength TEXT,
        lens TEXT,
        duration REAL,
        framerate REAL,
        videoCodec TEXT,
        audioCodec TEXT,
        rating INTEGER,
        tags TEXT,
        personInImage TEXT,
        regions TEXT,
        orientation INTEGER,
        aiDescription TEXT,
        aiTags TEXT,
        faceTags TEXT,
        thumbnailsReady INTEGER DEFAULT 0,
        fileHash TEXT,
        infoProcessedAt TEXT,
        exifProcessedAt TEXT,
        thumbnailsProcessedAt TEXT,
        PRIMARY KEY (folder, fileName)
      )
    `);
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS face_embeddings (
        faceId TEXT PRIMARY KEY,
        folder TEXT NOT NULL,
        fileName TEXT NOT NULL,
        tagIndex INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        personId TEXT,
        personName TEXT,
        status TEXT DEFAULT 'unverified',
        dimensionsX REAL,
        dimensionsY REAL,
        dimensionsWidth REAL,
        dimensionsHeight REAL,
        qualityOverall REAL,
        qualityEffectiveResolution REAL,
        thumbnailPreferredHeight INTEGER,
        thumbnailCropVersion TEXT
      )
    `);
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_face_embeddings_file ON face_embeddings(folder, fileName)`);
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_face_embeddings_person ON face_embeddings(personId)`);
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_face_embeddings_status ON face_embeddings(status)`);

    await this.ensureFilesColumns([
      { name: "personInImage", type: "TEXT" },
      { name: "regions", type: "TEXT" },
      { name: "faceMetadataProcessedAt", type: "TEXT" },
      { name: "thumbnailConversionPriority", type: "INTEGER" },
      { name: "hlsConversionPriority", type: "INTEGER" },
      { name: "thumbnailConversionPrioritySetAt", type: "TEXT" },
      { name: "hlsConversionPrioritySetAt", type: "TEXT" },
    ]);

    await this.ensureIndexes();
    console.log(`[IndexDatabase] Database opened at ${this.dbFilePath}`);
    await this.ensureRootPath();

    const count = await this.db.get<{ count: number }>("SELECT COUNT(*) as count FROM files");
    console.log(`[IndexDatabase] Contains ${count?.count ?? 0} entries`);
  }

  private async ensureFilesColumns(columns: Array<{ name: string; type: string }>): Promise<void> {
    const existingColumnsRaw = await this.db.all<{ name: string }>("PRAGMA table_info(files)");
    const existingColumns = new Set(existingColumnsRaw.map(({ name }) => name));

    for (const { name, type } of columns) {
      if (existingColumns.has(name)) {
        continue;
      }
      await this.db.exec(`ALTER TABLE files ADD COLUMN ${name} ${type}`);
    }
  }

  private async ensureIndexes(): Promise<void> {
    const indexDefinitions: Array<{
      name: string;
      expression: string;
      where?: string;
    }> = [
      { name: "idx_files_dateTaken", expression: "dateTaken DESC" },
      { name: "idx_files_mimeType", expression: "mimeType" },
      { name: "idx_files_rating", expression: "rating" },
      { name: "idx_files_folder", expression: "folder" },
      { name: "idx_files_infoProcessedAt", expression: "infoProcessedAt" },
      { name: "idx_files_exifProcessedAt", expression: "exifProcessedAt" },
      {
        name: "idx_files_thumbnailsProcessedAt",
        expression: "thumbnailsProcessedAt",
      },
      {
        name: "idx_files_thumbnailConversionQueue",
        expression: "thumbnailConversionPriority ASC, thumbnailConversionPrioritySetAt ASC, folder, fileName",
        where: `thumbnailConversionPriority >= ${ConversionTaskPriority.UserBlocked}`,
      },
      {
        name: "idx_files_hlsConversionQueue",
        expression: "hlsConversionPriority ASC, hlsConversionPrioritySetAt ASC, folder, fileName",
        where: `hlsConversionPriority >= ${ConversionTaskPriority.UserBlocked}`,
      },
    ];

    for (const { name, expression, where } of indexDefinitions) {
      const whereClause = where ? ` WHERE ${where}` : "";
      await this.db.exec(
        `CREATE INDEX IF NOT EXISTS ${name} ON files(${expression})${whereClause}`,
      );
    }

    for (const old of [
      "idx_files_thumbnailConversionPriority",
      "idx_files_hlsConversionPriority",
    ]) {
      await this.db.exec(`DROP INDEX IF EXISTS ${old}`);
    }
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

  private getConversionColumns(taskType: "thumbnail" | "hls") {
    if (taskType === "thumbnail") {
      return {
        priority: "thumbnailConversionPriority",
        setAt: "thumbnailConversionPrioritySetAt",
      } as const;
    }

    return {
      priority: "hlsConversionPriority",
      setAt: "hlsConversionPrioritySetAt",
    } as const;
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
      oldFolder, oldFile,
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
      { sql: "DELETE FROM files WHERE folder = ? AND fileName = ?", params: [oldFolder, oldFile] },
      { sql: `INSERT INTO files (${columns.names.join(", ")}) VALUES (${placeholders})`, params: columns.values },
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
        folder, fileName,
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

    if (fileData.faceTags !== undefined) {
      await this.syncFaceEmbeddings(folder, fileName, fileData.faceTags as FaceTag[]);
    }
  }

  async getFileRecord(
    relativePath: string,
    _fields?: string[],
  ): Promise<FileRecord | undefined> {
    const { folder, fileName } = splitPath(relativePath);
    const row = await this.db.get<Record<string, string | number>>(
      "SELECT * FROM files WHERE folder = ? AND fileName = ?",
      folder, fileName,
    );
    if (!row) {
      return undefined;
    }

    return rowToFileRecord(row);
  }

  async countMissingInfo(): Promise<number> {
    return this.countEntries("sizeInBytes IS NULL OR created IS NULL OR modified IS NULL");
  }

  async countMissingDateTaken(): Promise<number> {
    return this.countEntries(
      "(mimeType LIKE 'image/%' OR mimeType LIKE 'video/%') AND dateTaken IS NULL AND exifProcessedAt IS NULL",
    );
  }

  async countPendingConversions(): Promise<{ thumbnail: number; hls: number }> {
    const t = await this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM files WHERE thumbnailConversionPriority >= ${ConversionTaskPriority.UserBlocked}`,
    );
    const h = await this.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM files WHERE hlsConversionPriority >= ${ConversionTaskPriority.UserBlocked}`,
    );
    return { thumbnail: t?.c ?? 0, hls: h?.c ?? 0 };
  }

  async getConversionQueueCounts(): Promise<{ pending: number; processing: number }> {
    const row = await this.db.get<{ pending: number | null; processing: number | null }>(
      `SELECT
          SUM(CASE WHEN thumbnailConversionPriority >= ${ConversionTaskPriority.UserBlocked} THEN 1 ELSE 0 END)
          + SUM(CASE WHEN hlsConversionPriority >= ${ConversionTaskPriority.UserBlocked} THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN thumbnailConversionPriority = ${ConversionTaskPriority.InProgress} THEN 1 ELSE 0 END)
          + SUM(CASE WHEN hlsConversionPriority = ${ConversionTaskPriority.InProgress} THEN 1 ELSE 0 END) AS processing
       FROM files`,
    );
    return { pending: row?.pending ?? 0, processing: row?.processing ?? 0 };
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
      mimeType: string | null;
      sizeInBytes: number | null;
      duration: number | null;
      thumbnailConversionPriority: ConversionTaskPriority | null;
      hlsConversionPriority: ConversionTaskPriority | null;
    }>(
      `SELECT mimeType, sizeInBytes, duration, thumbnailConversionPriority, hlsConversionPriority
       FROM files
       WHERE thumbnailConversionPriority IS NOT NULL OR hlsConversionPriority IS NOT NULL`,
    );

    const addTask = (
      priority: ConversionTaskPriority | null,
      mediaType: "image" | "video",
      sizeBytes: number,
      durationMilliseconds: number,
    ) => {
      if (priority === null) return;
      const bucket = bucketForPriority[priority] ?? summary.background;
      bucket[mediaType].count += 1;
      bucket[mediaType].sizeBytes += sizeBytes;
      if (mediaType === "video") {
        bucket.video.durationMilliseconds += durationMilliseconds;
      }
    };

    for (const row of rows) {
      const mediaType = row.mimeType?.startsWith("video/") ? "video" : "image";
      const sizeBytes = Math.max(0, row.sizeInBytes ?? 0);
      const durationMilliseconds = Math.max(0, Math.round((row.duration ?? 0) * 1000));
      addTask(row.thumbnailConversionPriority, mediaType, sizeBytes, durationMilliseconds);
      if (row.mimeType?.startsWith("video/")) {
        addTask(row.hlsConversionPriority, "video", sizeBytes, durationMilliseconds);
      }
    }

    return summary;
  }

  /**
   * null = done, enum value = queued or in-progress
   */
  async setConversionPriority(
    relativePath: string,
    taskType: "thumbnail" | "hls",
    priority: ConversionTaskPriority | null,
  ): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    const { priority: priorityColumn, setAt: setAtColumn } =
      this.getConversionColumns(taskType);
    await this.db.run(
      `UPDATE files SET ${priorityColumn} = ?, ${setAtColumn} = ? WHERE folder = ? AND fileName = ?`,
      priority, priority !== null ? new Date().toISOString() : null, folder, fileName,
    );
  }

  async resetInProgressConversions(taskType: "thumbnail" | "hls"): Promise<void> {
    const { priority: priorityColumn, setAt: setAtColumn } =
      this.getConversionColumns(taskType);
    await this.db.run(
      `UPDATE files SET ${priorityColumn} = ?, ${setAtColumn} = ? WHERE ${priorityColumn} = ?`,
      ConversionTaskPriority.Background,
      new Date().toISOString(),
      ConversionTaskPriority.InProgress,
    );
  }

  /**
   * Returns the next pending conversion task ordered by priority (ASC), then by when the
   * priority was set (FIFO), then thumbnails before HLS for equal priority and time.
   * Excludes in-progress tasks.
   *
   * Uses two separate indexed queries instead of UNION ALL so SQLite can satisfy
   * the WHERE + ORDER BY + LIMIT 1 directly from the partial composite index.
   */
  async getNextConversionTasks(count = 1): Promise<Array<{
    relativePath: string;
    taskType: "thumbnail" | "hls";
  }>> {
    type CandidateRow = { folder: string; fileName: string; priority: number; prioritySetAt: string };

    const thumbnailRows = await this.db.all<CandidateRow>(
      `SELECT folder, fileName, thumbnailConversionPriority AS priority, thumbnailConversionPrioritySetAt AS prioritySetAt
       FROM files
       WHERE thumbnailConversionPriority >= ${ConversionTaskPriority.UserBlocked}
       ORDER BY thumbnailConversionPriority ASC, thumbnailConversionPrioritySetAt ASC
       LIMIT ?`,
      count,
    );

    const hlsRows = await this.db.all<CandidateRow>(
      `SELECT folder, fileName, hlsConversionPriority AS priority, hlsConversionPrioritySetAt AS prioritySetAt
       FROM files
       WHERE hlsConversionPriority >= ${ConversionTaskPriority.UserBlocked}
       ORDER BY hlsConversionPriority ASC, hlsConversionPrioritySetAt ASC
       LIMIT ?`,
      count,
    );

    const tagged = [
      ...thumbnailRows.map((r) => ({ ...r, taskType: "thumbnail" as const, taskOrder: 0 })),
      ...hlsRows.map((r) => ({ ...r, taskType: "hls" as const, taskOrder: 1 })),
    ];

    tagged.sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority
        : a.prioritySetAt !== b.prioritySetAt ? (a.prioritySetAt < b.prioritySetAt ? -1 : 1)
        : a.taskOrder - b.taskOrder,
    );

    return tagged.slice(0, count).map((row) => ({
      relativePath: joinPath(row.folder, row.fileName),
      taskType: row.taskType,
    }));
  }

  async getConversionTaskInfo(
    relativePath: string,
    taskType: "thumbnail" | "hls",
  ): Promise<{ mimeType: string | null; duration: number | null; priority: ConversionTaskPriority | null } | null> {
    const { folder, fileName } = splitPath(relativePath);
    const { priority: priorityColumn } = this.getConversionColumns(taskType);
    const row = await this.db.get<{ mimeType: string | null; duration: number | null; priority: ConversionTaskPriority | null }>(
      `SELECT mimeType, duration, ${priorityColumn} AS priority FROM files WHERE folder = ? AND fileName = ?`,
      folder, fileName,
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
    const row = await this.db.get<{ folder: string; fileName: string; exifProcessedAt: string }>(
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

  private async ensureRootPath(): Promise<void> {
    const existing = await this.db.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'rootPath'",
    );

    if (!existing) {
      await this.db.run(
        "INSERT INTO meta (key, value) VALUES ('rootPath', ?)",
        this.storagePath,
      );
      return;
    }

    if (existing.value !== this.storagePath) {
      console.warn(
        `[IndexDatabase] Media root changed from ${existing.value} to ${this.storagePath}. Resetting index.`,
      );
      await this.db.transaction([
        { sql: "DELETE FROM files", params: [] },
        { sql: "UPDATE meta SET value = ? WHERE key = 'rootPath'", params: [this.storagePath] },
      ]);
    }
  }

  async addPaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const statements = paths.map((relativePath) => {
      const { folder, fileName } = splitPath(relativePath);
      const mimeType = mimeTypeForFilename(relativePath);
      const thumbnailPriority =
        mimeType?.startsWith("image/") || mimeType?.startsWith("video/")
          ? ConversionTaskPriority.Background
          : null;
      return {
        sql: `INSERT OR IGNORE INTO files (folder, fileName, mimeType, thumbnailConversionPriority, thumbnailConversionPrioritySetAt)
              VALUES (?, ?, ?, ?, ?)`,
        params: [
          folder,
          fileName,
          mimeType,
          thumbnailPriority,
          thumbnailPriority !== null ? new Date().toISOString() : null,
        ] as unknown[],
      };
    });
    await this.db.transaction(statements);
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
  ): Promise<Array<
    {
      relativePath: string;
      mimeType: string | null;
      sizeInBytes?: number;
    } & { [key in `${keyof typeof MetadataGroups}ProcessedAt`]?: string | null }
  >> {
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
    const rows = await this.db.all<Record<string, string | number>>("SELECT * FROM files");
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
      normalizedSearch.length === 0
        ? "%"
        : `%${escapeLikeLiteral(normalizedSearch)}%`;
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
        likeQuery, ...whereParams, limit);

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
        likeQuery, ...whereParams, limit);

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
      likeQuery, ...whereParams, limit);

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
      normalizedSearch.length === 0
        ? "%"
        : `%${escapeLikeLiteral(normalizedSearch)}%`;
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
        likeQuery, ...whereParams, limit);

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
        likeQuery, ...whereParams, limit);

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
      likeQuery, ...whereParams, limit);

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

  async queryFaceQueue(options: {
    status?: FaceQueueStatus;
    personId?: string;
    minConfidence?: number;
    page?: number;
    pageSize?: number;
    path?: string;
    includeSubfolders?: boolean;
  }): Promise<FaceQueueResult> {
    const status = options.status;
    const personId = options.personId?.trim();
    const isUnassignedFilter = personId === "__unassigned__";
    const minConfidence = options.minConfidence;
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.max(1, Math.min(500, options.pageSize ?? 100));
    const normalizedPath = options.path ? normalizeFolderPath(options.path) : null;
    const includeSubfolders = options.includeSubfolders !== false;

    let sql = `SELECT folder, fileName, dateTaken, faceTags FROM files WHERE faceTags IS NOT NULL`;
    const params: unknown[] = [];

    if (normalizedPath) {
      if (includeSubfolders) {
        sql += ` AND folder LIKE ?`;
        params.push(`${escapeLikeLiteral(normalizedPath)}%`);
      } else {
        sql += ` AND folder = ?`;
        params.push(normalizedPath);
      }
    }

    const rows = await this.db.all<{
      folder: string;
      fileName: string;
      dateTaken: number | null;
      faceTags: string | null;
    }>(sql, ...params);

    const allItems = rows.flatMap((row) => {
      const parsedFaceTags = parseFaceTags(row.faceTags);
      return parsedFaceTags
        .map((faceTag, index) => {
          const faceId =
            typeof faceTag.faceId === "string" && faceTag.faceId.trim().length > 0
              ? faceTag.faceId
              : `${row.folder}${row.fileName}#${index}`;
          const statusValue = faceTag.status ?? "unverified";
          const confidence = faceTag.suggestion?.confidence;
          return {
            faceId,
            relativePath: `${row.folder}${row.fileName}`,
            fileName: row.fileName,
            dateTaken: row.dateTaken ?? undefined,
            dimensions: faceTag.dimensions,
            person: faceTag.person,
            status: statusValue,
            source: faceTag.source,
            suggestion: faceTag.suggestion,
            quality: faceTag.quality,
            thumbnail: faceTag.thumbnail,
            confidence,
          };
        })
        .filter((item) => Boolean(item.dimensions));
    });

    const filteredItems = allItems
      .filter((item) => (status ? item.status === status : true))
      .filter((item) => {
        if (!personId) {
          return true;
        }

        if (isUnassignedFilter) {
          return item.person == null;
        }

        return item.person?.id === personId;
      })
      .filter((item) =>
        typeof minConfidence === "number" && Number.isFinite(minConfidence)
          ? (item.confidence ?? -1) >= minConfidence
          : true,
      )
      .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));

    const offset = (page - 1) * pageSize;
    const items = filteredItems.slice(offset, offset + pageSize).map(({ confidence: _confidence, ...rest }) => rest);

    return {
      items,
      total: filteredItems.length,
      page,
      pageSize,
    };
  }

  async acceptFaceSuggestion(options: {
    faceId: string;
    personId?: string;
    personName?: string;
    reviewer?: string;
  }): Promise<boolean> {
    const { faceId, personId, personName, reviewer } = options;
    const match = await this.findFaceById(faceId);
    if (!match) {
      return false;
    }

    const { row, tags } = match;
    const nextTags = tags.map((faceTag, index) => {
      const computedFaceId = getFaceId(row.folder, row.fileName, faceTag, index);
      if (computedFaceId !== faceId) {
        return faceTag;
      }

      const resolvedPersonId = personId ?? faceTag.suggestion?.personId;
      return {
        ...faceTag,
        faceId,
        person:
          resolvedPersonId || personName
            ? { id: resolvedPersonId ?? `name:${personName}`, ...(personName ? { name: personName } : {}) }
            : faceTag.person,
        status: "confirmed" as const,
        review: {
          action: "accept" as const,
          reviewedAt: new Date().toISOString(),
          ...(reviewer ? { reviewer } : {}),
        },
      };
    });

    await this.persistFaceTags(row.folder, row.fileName, nextTags);
    return true;
  }

  async rejectFaceSuggestion(options: {
    faceId: string;
    personId?: string;
    reviewer?: string;
  }): Promise<boolean> {
    const { faceId, personId, reviewer } = options;
    const match = await this.findFaceById(faceId);
    if (!match) {
      return false;
    }

    const { row, tags } = match;
    const nextTags = tags.map((faceTag, index) => {
      const computedFaceId = getFaceId(row.folder, row.fileName, faceTag, index);
      if (computedFaceId !== faceId) {
        return faceTag;
      }

      const shouldClearSuggestion =
        !personId || personId === faceTag.suggestion?.personId;

      return {
        ...faceTag,
        faceId,
        status: "rejected" as const,
        ...(shouldClearSuggestion ? { suggestion: undefined } : {}),
        review: {
          action: "reject" as const,
          reviewedAt: new Date().toISOString(),
          ...(reviewer ? { reviewer } : {}),
        },
      };
    });

    await this.persistFaceTags(row.folder, row.fileName, nextTags);
    return true;
  }

  async queryFacePeople(options?: { path?: string; includeSubfolders?: boolean }): Promise<FacePeopleItem[]> {
    const startTime = Date.now();
    const normalizedPath = options?.path ? normalizeFolderPath(options.path) : null;
    const includeSubfolders = options?.includeSubfolders !== false;

    let pathWhereClause = "";
    const params: unknown[] = [];

    if (normalizedPath) {
      if (includeSubfolders) {
        pathWhereClause = ` AND files.folder LIKE ?`;
        params.push(`${escapeLikeLiteral(normalizedPath)}%`);
      } else {
        pathWhereClause = ` AND files.folder = ?`;
        params.push(normalizedPath);
      }
    }

    const rows = await this.db.all<{
      personId: string;
      personName: string | null;
      personCount: number;
      folder: string;
      fileName: string;
      tagIndex: number;
      faceIdRaw: string | null;
      dimX: number;
      dimY: number;
      dimWidth: number;
      dimHeight: number;
      thumbPreferredHeight: number | null;
      thumbCropVersion: string | null;
    }>(
        `WITH expanded AS (
           SELECT
             files.folder AS folder,
             files.fileName AS fileName,
             CAST(tags.key AS INTEGER) AS tagIndex,
             json_extract(tags.value, '$.person.id') AS personIdRaw,
             json_extract(tags.value, '$.person.name') AS personNameRaw,
             json_extract(tags.value, '$.faceId') AS faceIdRaw,
             json_extract(tags.value, '$.dimensions.x') AS dimX,
             json_extract(tags.value, '$.dimensions.y') AS dimY,
             json_extract(tags.value, '$.dimensions.width') AS dimWidth,
             json_extract(tags.value, '$.dimensions.height') AS dimHeight,
             json_extract(tags.value, '$.thumbnail.preferredHeight') AS thumbPreferredHeight,
             json_extract(tags.value, '$.thumbnail.cropVersion') AS thumbCropVersion,
             COALESCE(json_extract(tags.value, '$.quality.overall'), 0) * 10000
               + COALESCE(json_extract(tags.value, '$.quality.effectiveResolution'), 0)
               + MAX(
                   0,
                   COALESCE(json_extract(tags.value, '$.dimensions.width'), 0)
                     * COALESCE(json_extract(tags.value, '$.dimensions.height'), 0)
                 ) * 1000 AS representativeScore
           FROM files, json_each(files.faceTags) AS tags
           WHERE files.faceTags IS NOT NULL
             AND json_type(tags.value, '$.dimensions') = 'object'
             ${pathWhereClause}
         ),
         ranked AS (
           SELECT
             COALESCE(personIdRaw, '__unassigned__') AS personId,
             COALESCE(
               personNameRaw,
               MAX(personNameRaw) OVER (
                 PARTITION BY COALESCE(personIdRaw, '__unassigned__')
               ),
               CASE WHEN personIdRaw IS NULL THEN 'Unassigned' ELSE NULL END
             ) AS personName,
             folder,
             fileName,
             tagIndex,
             faceIdRaw,
             dimX,
             dimY,
             dimWidth,
             dimHeight,
             thumbPreferredHeight,
             thumbCropVersion,
             representativeScore,
             COUNT(*) OVER (PARTITION BY COALESCE(personIdRaw, '__unassigned__')) AS personCount,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(personIdRaw, '__unassigned__')
               ORDER BY representativeScore DESC
             ) AS representativeRank
           FROM expanded
         )
         SELECT
           personId,
           personName,
           personCount,
           folder,
           fileName,
           tagIndex,
           faceIdRaw,
           dimX,
           dimY,
           dimWidth,
           dimHeight,
           thumbPreferredHeight,
           thumbCropVersion
         FROM ranked
         WHERE representativeRank = 1
         ORDER BY personCount DESC`,
      ...params,
    );

    const people = rows.map((row) => {
      const faceId = row.faceIdRaw?.trim().length
        ? row.faceIdRaw
        : `${row.folder}${row.fileName}#${row.tagIndex}`;
      const thumbnail =
        row.thumbPreferredHeight == null && row.thumbCropVersion == null
          ? undefined
          : {
              ...(row.thumbPreferredHeight == null
                ? {}
                : { preferredHeight: row.thumbPreferredHeight }),
              ...(row.thumbCropVersion == null ? {} : { cropVersion: row.thumbCropVersion }),
            };

      return {
        id: row.personId,
        ...(row.personName ? { name: row.personName } : {}),
        count: row.personCount,
        representativeFace: {
          faceId,
          relativePath: `${row.folder}${row.fileName}`,
          fileName: row.fileName,
          dimensions: {
            x: row.dimX,
            y: row.dimY,
            width: row.dimWidth,
            height: row.dimHeight,
          },
          ...(thumbnail ? { thumbnail } : {}),
        },
      };
    });

    console.log(
      `[faces] queryFacePeople returned ${people.length} buckets in ${Date.now() - startTime}ms`,
    );
    return people;
  }

  async queryFaceMatches(options: { faceId: string; limit?: number }): Promise<FaceMatchItem[]> {
    const faceId = options.faceId.trim();
    const limit = Math.max(1, Math.min(100, options.limit ?? 12));
    if (!faceId) {
      return [];
    }

    const target = await this.db.get<{ embedding: Buffer }>(
      `SELECT embedding FROM face_embeddings WHERE faceId = ?`,
      faceId,
    );
    if (!target?.embedding) {
      return [];
    }

    const rows = await this.db.all<{
      faceId: string;
      folder: string;
      fileName: string;
      personId: string | null;
      personName: string | null;
      status: string;
      dimensionsX: number | null;
      dimensionsY: number | null;
      dimensionsWidth: number | null;
      dimensionsHeight: number | null;
      thumbnailPreferredHeight: number | null;
      thumbnailCropVersion: string | null;
      confidence: number;
    }>(
      `SELECT
         faceId, folder, fileName, personId, personName, status,
         dimensionsX, dimensionsY, dimensionsWidth, dimensionsHeight,
         thumbnailPreferredHeight, thumbnailCropVersion,
         cosine_similarity(?, embedding) AS confidence
       FROM face_embeddings
       WHERE faceId != ? AND status != 'rejected'
       ORDER BY confidence DESC
       LIMIT ?`,
      target.embedding, faceId, limit,
    );

    return rows.map((row) => ({
      faceId: row.faceId,
      relativePath: `${row.folder}${row.fileName}`,
      fileName: row.fileName,
      dimensions: {
        x: row.dimensionsX ?? 0,
        y: row.dimensionsY ?? 0,
        width: row.dimensionsWidth ?? 0,
        height: row.dimensionsHeight ?? 0,
      },
      ...(row.personId ? { person: { id: row.personId, ...(row.personName ? { name: row.personName } : {}) } } : {}),
      status: row.status ?? "unverified",
      ...(row.thumbnailPreferredHeight != null || row.thumbnailCropVersion != null
        ? {
            thumbnail: {
              ...(row.thumbnailPreferredHeight != null ? { preferredHeight: row.thumbnailPreferredHeight } : {}),
              ...(row.thumbnailCropVersion != null ? { cropVersion: row.thumbnailCropVersion } : {}),
            },
          }
        : {}),
      confidence: Number(row.confidence.toFixed(4)),
    }));
  }

  async queryPersonFaceSuggestions(options: { personId: string; limit?: number }): Promise<FaceMatchItem[]> {
    const personId = options.personId.trim();
    const limit = Math.max(1, Math.min(200, options.limit ?? 200));
    if (!personId) {
      return [];
    }

    const profileFaces = await this.db.all<{
      embedding: Buffer;
      qualityOverall: number | null;
      qualityEffectiveResolution: number | null;
    }>(
      `SELECT embedding, qualityOverall, qualityEffectiveResolution
       FROM face_embeddings
       WHERE personId = ? AND status = 'confirmed'`,
      personId,
    );

    if (profileFaces.length === 0) {
      return [];
    }

    const centroid = buildWeightedCentroid(
      profileFaces.map((row) => ({
        embedding: blobToEmbedding(row.embedding),
        weight: embeddingWeight({
          overall: row.qualityOverall ?? undefined,
          effectiveResolution: row.qualityEffectiveResolution ?? undefined,
        }),
      })),
    );
    if (!centroid) {
      return [];
    }

    const centroidBlob = embeddingToBlob(centroid);
    const MIN_SIMILARITY = 0.4;

    const rows = await this.db.all<{
      faceId: string;
      folder: string;
      fileName: string;
      personId: string | null;
      personName: string | null;
      status: string;
      dimensionsX: number | null;
      dimensionsY: number | null;
      dimensionsWidth: number | null;
      dimensionsHeight: number | null;
      thumbnailPreferredHeight: number | null;
      thumbnailCropVersion: string | null;
      confidence: number;
    }>(
      `SELECT
         faceId, folder, fileName, personId, personName, status,
         dimensionsX, dimensionsY, dimensionsWidth, dimensionsHeight,
         thumbnailPreferredHeight, thumbnailCropVersion,
         cosine_similarity(?, embedding) AS confidence
       FROM face_embeddings
       WHERE personId IS NULL AND status != 'rejected'
       ORDER BY confidence DESC
       LIMIT ?`,
      centroidBlob, limit,
    );

    const topMatch = rows.at(0);
    if (!topMatch || topMatch.confidence < MIN_SIMILARITY) {
      return [];
    }

    const secondMatch = rows.at(1);
    if (secondMatch && topMatch.confidence / (secondMatch.confidence + 0.001) < 1.12) {
      return [];
    }

    return rows.map((row) => ({
      faceId: row.faceId,
      relativePath: `${row.folder}${row.fileName}`,
      fileName: row.fileName,
      dimensions: {
        x: row.dimensionsX ?? 0,
        y: row.dimensionsY ?? 0,
        width: row.dimensionsWidth ?? 0,
        height: row.dimensionsHeight ?? 0,
      },
      ...(row.personId ? { person: { id: row.personId, ...(row.personName ? { name: row.personName } : {}) } } : {}),
      status: row.status ?? "unverified",
      ...(row.thumbnailPreferredHeight != null || row.thumbnailCropVersion != null
        ? {
            thumbnail: {
              ...(row.thumbnailPreferredHeight != null ? { preferredHeight: row.thumbnailPreferredHeight } : {}),
              ...(row.thumbnailCropVersion != null ? { cropVersion: row.thumbnailCropVersion } : {}),
            },
          }
        : {}),
      confidence: Number(row.confidence.toFixed(4)),
    }));
  }

  private async findFaceById(faceId: string): Promise<{
    row: { folder: string; fileName: string; faceTags: string | null };
    tags: FaceTag[];
  } | null> {
    const embeddingRow = await this.db.get<{ folder: string; fileName: string }>(
      `SELECT folder, fileName FROM face_embeddings WHERE faceId = ?`,
      faceId,
    );

    if (embeddingRow) {
      const fileRow = await this.db.get<{ folder: string; fileName: string; faceTags: string | null }>(
        `SELECT folder, fileName, faceTags FROM files WHERE folder = ? AND fileName = ?`,
        embeddingRow.folder, embeddingRow.fileName,
      );
      if (fileRow) {
        const tags = parseFaceTags(fileRow.faceTags);
        const found = tags.some(
          (tag, index) => getFaceId(fileRow.folder, fileRow.fileName, tag, index) === faceId,
        );
        if (found) {
          return { row: fileRow, tags };
        }
      }
    }

    const rows = await this.db.all<{ folder: string; fileName: string; faceTags: string | null }>(
      `SELECT folder, fileName, faceTags FROM files WHERE faceTags IS NOT NULL`,
    );

    for (const row of rows) {
      const tags = parseFaceTags(row.faceTags);
      const found = tags.some(
        (tag, index) => getFaceId(row.folder, row.fileName, tag, index) === faceId,
      );
      if (found) {
        return { row, tags };
      }
    }

    return null;
  }

  private async persistFaceTags(folder: string, fileName: string, faceTags: FaceTag[]): Promise<void> {
    await this.db.run(
      `UPDATE files
       SET faceTags = ?, faceMetadataProcessedAt = ?
       WHERE folder = ? AND fileName = ?`,
      JSON.stringify(faceTags), new Date().toISOString(), folder, fileName,
    );
    await this.syncFaceEmbeddings(folder, fileName, faceTags);
  }

  async syncFaceEmbeddings(folder: string, fileName: string, faceTags: FaceTag[]): Promise<void> {
    await this.db.run(
      `DELETE FROM face_embeddings WHERE folder = ? AND fileName = ?`,
      folder, fileName,
    );

    const statements = faceTags
      .map((tag, index) => {
        const embedding = getFaceEmbedding(tag);
        if (!embedding || !tag.dimensions) {
          return null;
        }
        const faceId = getFaceId(folder, fileName, tag, index);
        return {
          sql: `INSERT OR REPLACE INTO face_embeddings
                (faceId, folder, fileName, tagIndex, embedding, personId, personName, status,
                 dimensionsX, dimensionsY, dimensionsWidth, dimensionsHeight,
                 qualityOverall, qualityEffectiveResolution,
                 thumbnailPreferredHeight, thumbnailCropVersion)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            faceId, folder, fileName, index,
            embeddingToBlob(embedding),
            tag.person?.id ?? null,
            tag.person?.name ?? null,
            tag.status ?? "unverified",
            tag.dimensions.x ?? null,
            tag.dimensions.y ?? null,
            tag.dimensions.width ?? null,
            tag.dimensions.height ?? null,
            tag.quality?.overall ?? null,
            tag.quality?.effectiveResolution ?? null,
            tag.thumbnail?.preferredHeight ?? null,
            tag.thumbnail?.cropVersion ?? null,
          ] as unknown[],
        };
      })
      .filter((stmt): stmt is NonNullable<typeof stmt> => stmt !== null);

    if (statements.length > 0) {
      await this.db.transaction(statements);
    }
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
      () => this.db.all<Record<string, unknown>>(mainSQL, ...whereParams, pageSize, offset),
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

  async getDateRange(filter: FilterElement): Promise<{ minDate: Date | null; maxDate: Date | null }> {
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
      ...params);

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
    const result = await this.db.get<{ count: number }>("SELECT COUNT(*) as count FROM files");
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
