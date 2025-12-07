import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { getExifMetadataFromFile, getFileInfo } from "../fileHandling/fileUtils.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroupKeys, type DatabaseFileEntry } from "./fileRecord.type.ts";
import type { FileRecord, QueryOptions, QueryResult } from "./indexDatabase.type.ts";
import { matchesFilter } from "./matchesFilter.ts";
import { getColumnNamesAndValues, rowToFileRecord } from "./rowFileRecordConversionFunctions.ts";

export class IndexDatabase {
  private readonly storagePath: string;
  private db: Database.Database;
  private readonly dbFilePath: string;
  private insertOrReplaceStmt: Database.Statement;
  private insertIfMissingStmt: Database.Statement;
  private selectDataStmt: Database.Statement;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    const envDbPath = process.env.INDEX_DB_PATH ?? process.env.INDEX_DB_LOCATION;
    this.dbFilePath = envDbPath ? path.resolve(envDbPath) : path.join(CACHE_DIR, "index.db");
    mkdirSync(path.dirname(this.dbFilePath), { recursive: true });
    
    this.db = new Database(this.dbFilePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        relativePath TEXT PRIMARY KEY,
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
        exifProcessedAt TEXT,
        thumbnailsProcessedAt TEXT
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Note: Prepared statements are initialized in load() after migration
    this.insertOrReplaceStmt = null as any;
    this.insertIfMissingStmt = null as any;
    this.selectDataStmt = null as any;
  }

  async load(): Promise<void> {
    console.log(`[IndexDatabase] Database opened at ${this.dbFilePath}`);
    this.ensureRootPath();
    
    // Initialize prepared statements
    this.insertOrReplaceStmt = this.db.prepare(
      "INSERT OR REPLACE INTO files (relativePath, mimeType) VALUES (?, ?)",
    );
    this.insertIfMissingStmt = this.db.prepare(
      "INSERT INTO files (relativePath, mimeType) VALUES (?, ?) ON CONFLICT(relativePath) DO NOTHING",
    );
    this.selectDataStmt = this.db.prepare(
      "SELECT * FROM files WHERE relativePath = ?",
    );
    const count = this.db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
    console.log(`[IndexDatabase] Contains ${count.count} entries`);
  }

  async save(): Promise<void> {
    // No-op for SQLite
  }

  async addFile(fileData: DatabaseFileEntry): Promise<void> {
    const columns = getColumnNamesAndValues(fileData);
    
    if (columns.names.length !== columns.values.length) {
      throw new Error(
        `SQL parameter mismatch for ${fileData.relativePath}: ${columns.names.length} column names but ${columns.values.length} values. ` +
        `Columns: ${columns.names.join(', ')}. Values: ${JSON.stringify(columns.values)}`
      );
    }
    
    const placeholders = columns.values.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO files (${columns.names.join(', ')}) VALUES (${placeholders})`;
    this.db.prepare(sql).run(...columns.values);
  }

  async removeFile(relativePath: string): Promise<void> {
    this.db.prepare('DELETE FROM files WHERE relativePath = ?').run(relativePath);
  }

  async moveFile(oldRelativePath: string, newRelativePath: string): Promise<void> {
    const row = this.db.prepare('SELECT * FROM files WHERE relativePath = ?').get(oldRelativePath) as DatabaseFileEntry | undefined;
    if (!row) {
      throw new Error(
        `moveFile: File at path "${oldRelativePath}" does not exist in the database.`,
      );
    }

    const updated: DatabaseFileEntry = {
      ...row,
      relativePath: newRelativePath,
    };

    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM files WHERE relativePath = ?').run(oldRelativePath);
      const columns = getColumnNamesAndValues(updated);
      
      if (columns.names.length !== columns.values.length) {
        throw new Error(
          `SQL parameter mismatch for ${updated.relativePath}: ${columns.names.length} column names but ${columns.values.length} values. ` +
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
    fileData: Partial<DatabaseFileEntry>,
  ): Promise<void> {
    const execute = () => {
      const row = this.selectDataStmt.get(relativePath) as DatabaseFileEntry | undefined;
      const existingEntry = row;
      const updatedEntry = {
        ...(existingEntry ?? { relativePath, mimeType: mimeTypeForFilename(relativePath) }),
        ...fileData,
      };
      const columns = getColumnNamesAndValues(updatedEntry);
      
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

  async getFileRecord(
    relativePath: string,
    requiredMetadata?: Array<keyof FileRecord>,
  ): Promise<FileRecord | undefined> {
    const row = this.selectDataStmt.get(relativePath) as Record<string, any> | undefined;
    if (!row) {
      return undefined;
    }

    const record = rowToFileRecord(row);

    if (!requiredMetadata?.length || !this.hydrationRequired(record, requiredMetadata)) {
      return record;
    }

    return await this.hydrateMetadata(relativePath, requiredMetadata);
  }

  getRecordsMissingDateTaken(limit = 50): FileRecord[] {
    const stmt = this.db.prepare(
      `SELECT * FROM files
       WHERE (mimeType LIKE 'image/%' OR mimeType LIKE 'video/%')
         AND dateTaken IS NULL
         AND exifProcessedAt IS NULL
       LIMIT ?`);
    const rows = stmt.all(limit) as Array<Record<string, any>>;
    return rows.map((row) => rowToFileRecord(row));
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

  insertMissingPaths(paths: string[]): void {
    if (!paths.length) return;
    const tx = this.db.transaction((list: string[]) => {
      for (const relativePath of list) {
        const mimeType = mimeTypeForFilename(relativePath);
        this.insertIfMissingStmt.run(relativePath, mimeType);
      }
    });
    tx(paths);
  }

  private hydrationRequired(
    record: FileRecord,
    requiredMetadata: Array<keyof FileRecord>,
  ): boolean {
    return requiredMetadata.some((key) => !(key in record));
  }

  private async hydrateMetadata(
    relativePath: string,
    requiredMetadata: Array<keyof FileRecord>,
  ) {
    const row = this.selectDataStmt.get(relativePath) as Record<string, any> | undefined;
    if (!row) {
      throw new Error(
        `hydrateMetadata: File at path "${relativePath}" does not exist in the database.`,
      );
    }
    const originalDBEntry = rowToFileRecord(row);
    
    // Determine which metadata groups need to be loaded
    const groupsToLoad = new Set<keyof typeof MetadataGroupKeys>();
    
    for (const metadataKey of requiredMetadata) {
      // Skip if already present
      if (metadataKey in originalDBEntry) {
        continue;
      }
      
      // Find which group this key belongs to
      const metadataGroupKey = Object.entries(MetadataGroupKeys).find(([_, keys]) => {
        return (keys as unknown as Array<keyof FileRecord>).includes(metadataKey);
      });
      
      if (!metadataGroupKey) {
        throw new Error(`Requested metadata key "${metadataKey}" is not recognized.`);
      }
      
      groupsToLoad.add(metadataGroupKey[0] as keyof typeof MetadataGroupKeys);
    }
    
    // Load each required group
    const promises = Array.from(groupsToLoad).map(async (groupName) => {
      const fullPath = path.join(this.storagePath, relativePath);
      try {
        let extraData = {};
        switch (groupName) {
          case "info":
            extraData = await getFileInfo(fullPath);
            break;
          case "exifMetadata": {
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
            (extraData as any).exifProcessedAt = new Date().toISOString();
            break;
          }
          case "aiMetadata":
          case "faceMetadata":
            // Not implemented yet
            return;
          default:
            throw new Error(`Unhandled metadata group "${groupName}"`);
        }
        await this.addOrUpdateFileData(relativePath, extraData);
      } catch (error) {
        console.warn(`[metadata] Skipping group ${groupName} for ${relativePath}:`, error instanceof Error ? error.message : String(error));
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
    const baseFolderPath = relativePath !== "" ? (relativePath.endsWith("/") ? relativePath : relativePath + "/") : "";
    
    const folders = new Set<string>();
    const allPathsStmt = this.db.prepare('SELECT relativePath FROM files');
    
    for (const row of allPathsStmt.iterate()) {
      const entryPath = (row as { relativePath: string }).relativePath;
      if (entryPath.startsWith(baseFolderPath)) {
        const parts = entryPath.substring(baseFolderPath.length).split("/");
        if (parts.length > 1) {
          folders.add(parts[0]);
        }
      }
    }

    return Array.from(folders).sort((a, b) => a.localeCompare(b));
  }

  async queryFiles<TMetadata extends Array<keyof FileRecord>>(
    options: QueryOptions,
  ): Promise<QueryResult<TMetadata>> {
    const { filter, metadata, pageSize = 1_000, page = 1 } = options;
    console.log(`[query] Starting query: filter=${JSON.stringify(filter)}, metadata=${JSON.stringify(metadata)}, page=${page}, pageSize=${pageSize}`);
    const startTime = Date.now();

    let lastYield = startTime;
    let matches = 0;
    const hydrationPromises = [];
    
    for (const file of this.files()){
      if (Date.now() - lastYield > 100) {
        await new Promise((resolve) => setImmediate(resolve));
        lastYield = Date.now();
      }
      if (!matchesFilter(file, filter)) {
        continue;
      }
      matches ++;
      
      // Calculate pagination bounds (1-based matches index)
      const startMatch = (page - 1) * pageSize + 1;
      const endMatch = page * pageSize;

      if (matches >= startMatch && matches <= endMatch) {
        hydrationPromises.push(this.hydrateMetadata(file.relativePath, metadata));
      }
    }

    const result = {
      items: await Promise.all(hydrationPromises) as Array<{ relativePath: string } & Pick<FileRecord, TMetadata[number]>>,
      page,
      pageSize,
      total: matches,
    } as QueryResult<TMetadata>;
    const elapsed = Date.now() - startTime;
    console.log(`[query] Completed in ${elapsed}ms: ${result.total} items with metadata`);
    return result;
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
