import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { getExifMetadataFromFile, getFileInfo } from "../fileHandling/fileUtils.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroups, type FileRecord } from "./fileRecord.type.ts";
import { filterToSQL } from "./filterToSQL.ts";
import type {
  DateHistogramResult,
  FilterElement,
  GeoClusterResult,
  QueryOptions,
  QueryResult,
} from "./indexDatabase.type.ts";
import { fileRecordToColumnNamesAndValues, rowToFileRecord } from "./rowFileRecordConversionFunctions.ts";
import { joinPath, normalizeFolderPath, splitPath } from "./utils/pathUtils.ts";
import { escapeLikeLiteral } from "./utils/sqlUtils.ts";

export class IndexDatabase {
  public readonly storagePath: string;
  private db: Database.Database;
  private readonly dbFilePath: string;
  private selectDataStmt: Database.Statement;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    const envDbPath = process.env.INDEX_DB_PATH ?? process.env.INDEX_DB_LOCATION;
    this.dbFilePath = envDbPath ? path.resolve(envDbPath) : path.join(CACHE_DIR, "index.db");
    mkdirSync(path.dirname(this.dbFilePath), { recursive: true });

    this.db = new Database(this.dbFilePath);
    this.db.pragma('journal_mode = WAL');

    // Add custom REGEXP function for filtering
    this.db.function('REGEXP', { deterministic: true }, (pattern: string, text: string) => {
      try {
        return new RegExp(pattern).test(text) ? 1 : 0;
      } catch {
        return 0;
      }
    });

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        folder TEXT NOT NULL,
        fileName TEXT NOT NULL,
        mimeType TEXT,
        -- File Info
        sizeInBytes INTEGER,
        created TEXT,
        modified TEXT,
        -- EXIF Metadata
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
        orientation INTEGER,
        -- AI Metadata
        aiDescription TEXT,
        aiTags TEXT,
        -- Face Metadata
        faceTags TEXT,
        -- Processing status
        thumbnailsReady INTEGER DEFAULT 0,
        fileHash TEXT,
        infoProcessedAt TEXT,
        exifProcessedAt TEXT,
        thumbnailsProcessedAt TEXT,
        PRIMARY KEY (folder, fileName)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Create indexes for common query patterns
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_dateTaken ON files(dateTaken DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_mimeType ON files(mimeType)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_rating ON files(rating)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_infoProcessedAt ON files(infoProcessedAt)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_exifProcessedAt ON files(exifProcessedAt)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_files_thumbnailsProcessedAt ON files(thumbnailsProcessedAt)`);
    console.log(`[IndexDatabase] Database opened at ${this.dbFilePath}`);
    this.ensureRootPath();
    this.populateMissingMimeTypes();

    this.selectDataStmt = this.db.prepare(
      "SELECT * FROM files WHERE folder = ? AND fileName = ?",
    );
    const count = this.db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
    console.log(`[IndexDatabase] Contains ${count.count} entries`);
  }

  /**
   * One-time migration to populate mimeType for files that were added before
   * mimeType was being stored during initial file discovery.
   */
  private populateMissingMimeTypes(): void {
    const countResult = this.db.prepare('SELECT COUNT(*) as count FROM files WHERE mimeType IS NULL').get() as { count: number };
    if (countResult.count === 0) return;

    console.log(`[IndexDatabase] Populating mimeType for ${countResult.count} files...`);
    const startTime = Date.now();

    const rows = this.db.prepare('SELECT folder, fileName FROM files WHERE mimeType IS NULL').all() as Array<{ folder: string; fileName: string }>;
    const updateStmt = this.db.prepare('UPDATE files SET mimeType = ? WHERE folder = ? AND fileName = ?');
    
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const relativePath = joinPath(row.folder, row.fileName);
        const mimeType = mimeTypeForFilename(relativePath);
        updateStmt.run(mimeType, row.folder, row.fileName);
      }
    });
    tx();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[IndexDatabase] Populated mimeType for ${countResult.count} files in ${elapsed}s`);
  }

  async addFile(fileData: FileRecord): Promise<void> {

    const columns = fileRecordToColumnNamesAndValues(fileData);

    if (columns.names.length !== columns.values.length) {
      throw new Error(
        `SQL parameter mismatch for ${fileData.folder}${fileData.fileName}: ${columns.names.length} column names but ${columns.values.length} values. ` +
        `Columns: ${columns.names.join(', ')}. Values: ${JSON.stringify(columns.values)}`
      );
    }

    const placeholders = columns.values.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO files (${columns.names.join(', ')}) VALUES (${placeholders})`;
    this.db.prepare(sql).run(...columns.values);
  }

  async moveFile(oldRelativePath: string, newRelativePath: string): Promise<void> {
    const { folder: oldFolder, fileName: oldFile } = splitPath(oldRelativePath);
    const row = this.db.prepare('SELECT * FROM files WHERE folder = ? AND fileName = ?').get(oldFolder, oldFile) as FileRecord | undefined;
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

    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM files WHERE folder = ? AND fileName = ?').run(oldFolder, oldFile);
      const columns = fileRecordToColumnNamesAndValues(updated);

      if (columns.names.length !== columns.values.length) {
        throw new Error(
          `SQL parameter mismatch for ${newRelativePath}: ${columns.names.length} column names but ${columns.values.length} values. ` +
          `Columns: ${columns.names.join(', ')}. Values: ${JSON.stringify(columns.values)}`
        );
      }

      const placeholders = columns.values.map(() => '?').join(', ');
      const sql = `INSERT INTO files (${columns.names.join(', ')}) VALUES (${placeholders})`;
      this.db.prepare(sql).run(...columns.values);
    });
    transaction();
  }

  async addOrUpdateFileData(
    relativePath: string,
    fileData: Partial<FileRecord>,
  ): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    const execute = () => {
      const row = this.selectDataStmt.get(folder, fileName) as FileRecord | undefined;
      const existingEntry = row;
      const updatedEntry = {
        ...(existingEntry ?? { folder, fileName, mimeType: mimeTypeForFilename(relativePath) }),
        ...fileData,
      };
      const columns = fileRecordToColumnNamesAndValues(updatedEntry);

      if (columns.names.length !== columns.values.length) {
        throw new Error(
          `SQL parameter mismatch for ${relativePath}: ${columns.names.length} column names but ${columns.values.length} values. ` +
          `Columns: ${columns.names.join(', ')}. Values: ${JSON.stringify(columns.values)}`
        );
      }

      const placeholders = columns.values.map(() => '?').join(', ');
      const sql = `INSERT OR REPLACE INTO files (${columns.names.join(', ')}) VALUES (${placeholders})`;
      this.db.prepare(sql).run(...columns.values);
    };

    await this.runWithRetry(execute);
  }

  /**
   * 
   * @param relativePath 
   * @param requiredMetadata This is metadata that it will fetch if needed (i.e., with a filesystem write) 
   * @returns 
   */
  async getFileRecord(
    relativePath: string,
    requiredMetadata?: Array<keyof FileRecord>,
  ): Promise<FileRecord | undefined> {
    const { folder, fileName } = splitPath(relativePath);
    const row = this.selectDataStmt.get(folder, fileName) as Record<string, any> | undefined;
    if (!row) {
      return undefined;
    }

    const record = rowToFileRecord(row);

    const hasAllMetadata = !requiredMetadata || requiredMetadata.every(key => key in record);
    if (hasAllMetadata) {
      return record;
    }
    return record;
    // return await this.hydrateMetadata(relativePath, requiredMetadata);
  }

  countMissingInfo(): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM files
       WHERE sizeInBytes IS NULL
          OR created IS NULL
          OR modified IS NULL`);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  countMissingDateTaken(): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM files
       WHERE (mimeType LIKE 'image/%' OR mimeType LIKE 'video/%')
         AND dateTaken IS NULL
         AND exifProcessedAt IS NULL`);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  countNeedingThumbnails(): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM files
       WHERE (mimeType LIKE 'image/%' OR mimeType LIKE 'video/%')
         AND COALESCE(thumbnailsReady, 0) = 0
         AND thumbnailsProcessedAt IS NULL`);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  countMediaEntries(): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM files
       WHERE mimeType LIKE 'image/%'
          OR mimeType LIKE 'video/%'`);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  getRatingStats(): {
    total: number;
    rated: number;
    unrated: number;
    distribution: Record<string, number>;
  } {
    const rows = this.db
      .prepare(
        `SELECT rating, COUNT(*) as count
         FROM files
         WHERE mimeType LIKE 'image/%' OR mimeType LIKE 'video/%'
         GROUP BY rating`
      )
      .all() as Array<{ rating: number | null; count: number }>;

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

  private ensureRootPath(): void {
    const existing = this.db
      .prepare("SELECT value FROM meta WHERE key = 'rootPath'")
      .get() as { value: string } | undefined;

    if (!existing) {
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('rootPath', ?)").run(this.storagePath);
      return;
    }

    if (existing.value !== this.storagePath) {
      console.warn(`[IndexDatabase] Media root changed from ${existing.value} to ${this.storagePath}. Resetting index.`);
      const reset = this.db.transaction(() => {
        this.db.prepare("DELETE FROM files").run();
        this.db.prepare("UPDATE meta SET value = ? WHERE key = 'rootPath'").run(this.storagePath);
      });
      reset();
    }
  }

  getRecordsNeedingThumbnails(limit = 25): FileRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM files
       WHERE (mimeType LIKE 'image/%' OR mimeType LIKE 'video/%')
         AND COALESCE(thumbnailsReady, 0) = 0
         AND thumbnailsProcessedAt IS NULL
       LIMIT ?`)
      .all(limit) as Array<Record<string, any>>;
    return rows.map((row) => rowToFileRecord(row));
  }

  addPaths(paths: string[]): void {
    if (!paths.length) return;
    const addPath = this.db.prepare(
      "INSERT OR IGNORE INTO files (folder, fileName, mimeType) VALUES (?, ?, ?)",
    );
    const tx = this.db.transaction((list: string[]) => {
      for (const relativePath of list) {
        const { folder, fileName } = splitPath(relativePath);
        const mimeType = mimeTypeForFilename(relativePath);
        addPath.run(folder, fileName, mimeType);
      }
    });
    tx(paths);
  }

  countFilesNeedingMetadataUpdate(metadataGroupName: keyof typeof MetadataGroups): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM files WHERE ${metadataGroupName}ProcessedAt IS NULL`
    );
    const row = stmt.get() as { count: number };
    return row.count;
  }

  getFilesNeedingMetadataUpdate(metadataGroupName: keyof typeof MetadataGroups, limit = 200):Array<{
      relativePath: string;
      mimeType: string | null;
      sizeInBytes?: number;
    } & { [key in `${keyof typeof MetadataGroups}ProcessedAt`]?: string | null }>{
      
    const stmt = this.db.prepare(
      `SELECT folder, fileName, mimeType, sizeInBytes, ${metadataGroupName}ProcessedAt FROM files
       WHERE ${metadataGroupName}ProcessedAt IS NULL
       ORDER BY created DESC, folder DESC, fileName DESC
       LIMIT ?`
    );

    const rows = stmt.all(limit) as Array<Record<string, any>>;
    return rows.map((row) => {
      const relativePath = joinPath(row.folder as string, row.fileName as string);
      const mimeType = (row.mimeType as string | null) ?? mimeTypeForFilename(relativePath) ?? null;

      return {
        relativePath,
        mimeType,
        sizeInBytes: row.sizeInBytes,
        [metadataGroupName + "ProcessedAt"]: row[metadataGroupName + "ProcessedAt"],
      };
    });
  }

  /**
   * Gets the count of video files that have had EXIF processed (and thus are ready for HLS encoding).
   */
  countVideosReadyForHLS(): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM files WHERE mimeType LIKE 'video/%' AND exifProcessedAt IS NOT NULL`
    );
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Gets video files that have been processed for EXIF (ready for HLS encoding).
   */
  getVideosReadyForHLS(limit = 50): Array<{ relativePath: string }> {
    const stmt = this.db.prepare(
      `SELECT folder, fileName FROM files
       WHERE mimeType LIKE 'video/%' AND exifProcessedAt IS NOT NULL
       ORDER BY created DESC, folder DESC, fileName DESC
       LIMIT ?`
    );

    const rows = stmt.all(limit) as Array<{ folder: string; fileName: string }>;
    return rows.map((row) => ({
      relativePath: joinPath(row.folder, row.fileName),
    }));
  }

  private async hydrateMetadata(
    relativePath: string,
    requiredMetadata: Array<keyof FileRecord>,
  ) {
    const { folder, fileName } = splitPath(relativePath);
    const row = this.selectDataStmt.get(folder, fileName) as Record<string, any> | undefined;
    if (!row) {
      throw new Error(
        `hydrateMetadata: File at path "${relativePath}" does not exist in the database.`,
      );
    }
    const originalDBEntry = rowToFileRecord(row);
    return originalDBEntry;

    // Map metadata group names to their "processed at" column names
    const groupProcessedAtColumn: Record<keyof typeof MetadataGroups, string> = {
      info: 'infoProcessedAt',
      exif: 'exifProcessedAt',
      aiMetadata: 'aiProcessedAt',
      faceMetadata: 'faceProcessedAt',
    };

    // Determine which metadata groups need to be loaded (skip if already processed)
    const groupsToLoad = requiredMetadata
      .map(field =>
        Object.keys(MetadataGroups).find(groupKey =>
          (MetadataGroups as Record<string, readonly string[]>)[groupKey].includes(field)
        ) as keyof typeof MetadataGroups
      )
      .filter((group): group is keyof typeof MetadataGroups => group !== undefined)
      .reduce((acc, group) => acc.includes(group) ? acc : [...acc, group], [] as Array<keyof typeof MetadataGroups>)
      .filter(groupName => {
        if (!row) return true; // If no row, we need to load
        const processedAtColumn = groupProcessedAtColumn[groupName];
        return !row[processedAtColumn]; // Skip if already processed
      });

    if (groupsToLoad.length === 0) {
      return originalDBEntry;
    }

    const promises = groupsToLoad.map(async (groupName) => {
      const relativeNoLeadingSlash = relativePath.replace(/^\/+/, "");
      const fullPath = path.join(this.storagePath, relativeNoLeadingSlash);
      try {
        let extraData: Record<string, unknown> = {};
        switch (groupName) {
          case "info":
            extraData = await getFileInfo(fullPath);
            extraData.infoProcessedAt = new Date().toISOString();
            break;
          case "exif": {
            // Only attempt EXIF parsing for media files
            const mimeType = originalDBEntry?.mimeType || mimeTypeForFilename(relativePath);
            if (mimeType?.startsWith("image/") || mimeType?.startsWith("video/")) {
              try {
                extraData = await getExifMetadataFromFile(fullPath);
              } catch (error) {
                // File format doesn't support EXIF or parsing failed
                console.warn(`[metadata] Could not read EXIF metadata for ${relativePath}:`, error instanceof Error ? error.message : String(error));
                extraData = {};
              }
            } else {
              // Non-media file, skip EXIF parsing
              extraData = {};
            }
            extraData.exifProcessedAt = new Date().toISOString();
            break;
          }
          case "aiMetadata":
          case "faceMetadata":
            // Not implemented yet
            return;
          default:
            throw new Error(`Unhandled metadata group "${String(groupName)}"`);
        }
        await this.addOrUpdateFileData(relativePath, extraData);
      } catch (error) {
        console.warn(`[metadata] Skipping group ${String(groupName)} for ${relativePath}:`, error instanceof Error ? error.message : String(error));
      }
    });

    await Promise.all(promises);

    // Re-fetch to get updated data
    const updatedRow = this.selectDataStmt.get(relativePath) as Record<string, any>;
    return rowToFileRecord(updatedRow);
  }

  *files(): IterableIterator<FileRecord> {
    const stmt = this.db.prepare('SELECT * FROM files');
    for (const row of stmt.iterate()) {
      yield rowToFileRecord(row as Record<string, any>);
    }
  }

  getFolders(relativePath: string): Array<string> {
    const base = normalizeFolderPath(relativePath);

    if (base === '/') {
      const stmt = this.db.prepare(
        `SELECT DISTINCT 
         CASE 
         WHEN instr(substr(folder, 2), '/') > 0 
         -- If there are multiple "/", take everything between leading "/" and that "/"
         THEN substr(folder, 2, instr(substr(folder, 2), '/') - 1)
         -- Otherwise, take everything after the leading "/"
         ELSE substr(folder, 2)
         END AS folderName
       FROM files
       WHERE folder LIKE '/%' AND length(folder) > 1
       ORDER BY folderName`
      );
      const rows = stmt.all() as Array<{ folderName: string | null }>;
      return rows
        .map(row => row.folderName)
        .filter((v): v is string => Boolean(v))
        .sort((a, b) => a.localeCompare(b));
    }

    const escapedPrefix = escapeLikeLiteral(base);
    const prefixLen = base.length;
    const stmt = this.db.prepare(
      `SELECT DISTINCT 
         substr(folder, ?, instr(substr(folder, ?), '/') - 1) AS folderName
       FROM files
       WHERE folder LIKE ? ESCAPE '\\'
         AND length(folder) > ?
         AND instr(substr(folder, ?), '/') > 0
       ORDER BY folderName`
    );

    const rows = stmt.all(prefixLen + 1, prefixLen + 1, `${escapedPrefix}%`, prefixLen, prefixLen + 1) as Array<{ folderName: string | null }>;
    return rows
      .map(row => row.folderName)
      .filter((v): v is string => Boolean(v))
      .sort((a, b) => a.localeCompare(b));
  }

  queryGeoClusters(options: { filter: QueryOptions["filter"]; clusterSize: number; bounds?: { west: number; east: number; north: number; south: number } | null }): GeoClusterResult {
    const { filter, clusterSize, bounds } = options;
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const bucket = Math.max(clusterSize, 0.00000001);
    const latOrigin = Math.floor((bounds?.south ?? 0) / bucket) * bucket;
    const lonOrigin = Math.floor((bounds?.west ?? 0) / bucket) * bucket;

    const rows = this.db.prepare(
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
       ORDER BY count DESC`
    ).all(
      latOrigin, bucket,
      lonOrigin, bucket,
      ...whereParams,
      bucket, latOrigin,
      bucket, lonOrigin,
    ) as Array<{
      latitude: number;
      longitude: number;
      count: number;
      samplePath: string | null;
      sampleName: string | null;
    }>;

    const total = rows.reduce((sum, row) => sum + (row.count ?? 0), 0);

    return {
      clusters: rows,
      total,
    };
  }

  async queryFiles<TMetadata extends Array<keyof FileRecord>>(
    options: QueryOptions,
  ): Promise<QueryResult<TMetadata>> {
    const { filter, metadata, pageSize = 1_000, page = 1 } = options;
    console.log(`[query] Starting query: filter=${JSON.stringify(filter)}, metadata=${JSON.stringify(metadata)}, page=${page}, pageSize=${pageSize}`);
    const startTime = Date.now();

    // Convert filter to SQL
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    console.log(`[query] Generated SQL WHERE: "${whereClause}" with params: ${JSON.stringify(whereParams)}`);

    // Build the count query
    const countSQL = `SELECT COUNT(*) as count FROM files ${whereClause ? `WHERE ${whereClause}` : ''}`;
    const countResult = this.db.prepare(countSQL).get(...whereParams) as { count: number };
    const total = countResult.count;

    // Build the main query with sorting and pagination
    const offset = (page - 1) * pageSize;
    const mainSQL = `
      SELECT * FROM files 
      ${whereClause ? `WHERE ${whereClause}` : ''}
      ORDER BY CASE WHEN dateTaken IS NULL THEN 0 ELSE 1 END DESC, dateTaken DESC, folder ASC, fileName ASC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.prepare(mainSQL).all(...whereParams, pageSize, offset) as Array<Record<string, any>>;
    const matchedFiles = rows.map(v => rowToFileRecord(v, metadata));

    const result = {
      items: matchedFiles as Array<{ folder: string; fileName: string } & Pick<FileRecord, TMetadata[number]>>,
      page,
      pageSize,
      total,
    } as QueryResult<TMetadata>;
    const elapsed = Date.now() - startTime;
    console.log(`[query] Completed in ${elapsed}ms: ${result.total} total items, ${result.items.length} items on page`);
    return result;
  }

  getDateRange(filter: FilterElement): { minDate: Date | null; maxDate: Date | null } {
    const { where: whereClause, params } = filterToSQL(filter);
    const sql = `
      SELECT
        MIN(dateTaken) AS minDate,
        MAX(dateTaken) AS maxDate
      FROM files
      WHERE dateTaken IS NOT NULL
      ${whereClause ? `AND ${whereClause}` : ""}
    `;

    const result = this.db.prepare(sql).get(...params) as { minDate: number | null; maxDate: number | null };

    return {
      minDate: result?.minDate !== null && result?.minDate !== undefined ? new Date(result.minDate) : null,
      maxDate: result?.maxDate !== null && result?.maxDate !== undefined ? new Date(result.maxDate) : null,
    };
  }

  getDateHistogram(filter: FilterElement): DateHistogramResult {
    const range = this.getDateRange(filter);
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
    const grouping: "day" | "month" = monthDiff(minDate, maxDate) <= 2 || spanDays <= 120 ? "day" : "month";
    const bucketFormat = grouping === "day" ? "%Y-%m-%d" : "%Y-%m-01";

    const { where: whereClause, params } = filterToSQL(filter);
    const rows = this.db
      .prepare(
        `SELECT
            strftime('${bucketFormat}', datetime(dateTaken / 1000, 'unixepoch')) AS bucket,
            COUNT(*) AS count
          FROM files
          WHERE dateTaken IS NOT NULL
          ${whereClause ? `AND ${whereClause}` : ""}
          GROUP BY bucket
          ORDER BY bucket`
      )
      .all(...params) as Array<{ bucket: string; count: number }>;

    const buckets = rows.map(({ bucket, count }) => {
      const start = grouping === "day"
        ? Date.UTC(Number(bucket.slice(0, 4)), Number(bucket.slice(5, 7)) - 1, Number(bucket.slice(8, 10)))
        : Date.UTC(Number(bucket.slice(0, 4)), Number(bucket.slice(5, 7)) - 1, 1);

      const end = grouping === "day"
        ? start + dayMs
        : Date.UTC(Number(bucket.slice(0, 4)), Number(bucket.slice(5, 7)), 1);

      return { start, end, count };
    });

    const bucketSizeMs = grouping === "day" ? dayMs : buckets[0] ? buckets[0].end - buckets[0].start : 0;

    return { buckets, bucketSizeMs, minDate, maxDate, grouping };
  }

  getSize(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
    return result.count;
  }

  private async runWithRetry<T>(fn: () => T, attempts = 5): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return fn();
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
