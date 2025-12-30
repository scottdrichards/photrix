import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { getExifMetadataFromFile, getFileInfo } from "../fileHandling/fileUtils.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroups, whichMetadataGroup, type DatabaseEntry } from "./fileRecord.type.ts";
import type { FileRecord, QueryOptions, QueryResult } from "./indexDatabase.type.ts";
import { filterToSQL } from "./filterToSQL.ts";
import { fileRecordToColumnNamesAndValues, rowToFileRecord } from "./rowFileRecordConversionFunctions.ts";
import { escapeLikeLiteral } from "./utils/sqlUtils.ts";
import { normalizeFolderPath } from "./utils/pathUtils.ts";

export class IndexDatabase {
  private readonly storagePath: string;
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

    console.log(`[IndexDatabase] Database opened at ${this.dbFilePath}`);
    this.ensureRootPath();
    
    this.selectDataStmt = this.db.prepare(
      "SELECT * FROM files WHERE relativePath = ?",
    );
    const count = this.db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
    console.log(`[IndexDatabase] Contains ${count.count} entries`);
  }

  async addFile(fileData: DatabaseEntry): Promise<void> {

    const columns = fileRecordToColumnNamesAndValues(fileData);
    
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

  async moveFile(oldRelativePath: string, newRelativePath: string): Promise<void> {
    const row = this.db.prepare('SELECT * FROM files WHERE relativePath = ?').get(oldRelativePath) as DatabaseEntry | undefined;
    if (!row) {
      throw new Error(
        `moveFile: File at path "${oldRelativePath}" does not exist in the database.`,
      );
    }

    const updated: DatabaseEntry = {
      ...row,
      relativePath: newRelativePath,
    };

    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM files WHERE relativePath = ?').run(oldRelativePath);
      const columns = fileRecordToColumnNamesAndValues(updated);
      
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
    fileData: Partial<DatabaseEntry>,
  ): Promise<void> {
    const execute = () => {
      const row = this.selectDataStmt.get(relativePath) as DatabaseEntry | undefined;
      const existingEntry = row;
      const updatedEntry = {
        ...(existingEntry ?? { relativePath: relativePath, mimeType: mimeTypeForFilename(relativePath) }),
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
    const row = this.selectDataStmt.get(relativePath) as Record<string, any> | undefined;
    if (!row) {
      return undefined;
    }

    const record = rowToFileRecord(row);

    const hasAllMetadata = !requiredMetadata || requiredMetadata.every(key => key in record);
    if (hasAllMetadata) {
      return record;
    }

    return await this.hydrateMetadata(relativePath, requiredMetadata);
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

  addPaths(paths: string[]): void {
    if (!paths.length) return;
    const addPath = this.db.prepare(
      "INSERT OR IGNORE INTO files (relativePath) VALUES (?)",
    );
    const tx = this.db.transaction((list: string[]) => {
      for (const relativePath of list) {
        addPath.run(relativePath);
      }
    });
    tx(paths);
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
    const promises =  requiredMetadata
      .filter(key => !(key in originalDBEntry)) // We already have this metadata
      .map(whichMetadataGroup)
      .reduce((acc, group) => acc.includes(group) ? acc : [...acc, group], [] as Array<keyof typeof MetadataGroups>)
      .map(async (groupName) => {
      const relativeNoLeadingSlash = relativePath.replace(/^\/+/, "");
      const fullPath = path.join(this.storagePath, relativeNoLeadingSlash);
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
    const baseFolderPath = normalizeFolderPath(relativePath);

    const startIndex = baseFolderPath.length + 1; // SQLite substr() is 1-indexed
    const likePrefix = `${escapeLikeLiteral(baseFolderPath)}%`;

    const stmt = this.db.prepare(
      `SELECT DISTINCT substr(relativePath, ?, instr(substr(relativePath, ?), '/') - 1) AS folder
       FROM files
       WHERE relativePath LIKE ? ESCAPE '\\'
         AND instr(substr(relativePath, ?), '/') > 0
       ORDER BY folder`,
    );

    const rows = stmt.all(startIndex, startIndex, likePrefix, startIndex) as Array<{ folder: string | null }>;
    return rows
      .map((row) => row.folder)
      .filter((folder): folder is string => Boolean(folder))
      .sort((a, b) => a.localeCompare(b));
  }

  async queryFiles<TMetadata extends Array<keyof FileRecord>>(
    options: QueryOptions,
  ): Promise<QueryResult<TMetadata>> {
    const { filter, metadata, pageSize = 1_000, page = 1 } = options;
    console.log(`[query] Starting query: filter=${JSON.stringify(filter)}, metadata=${JSON.stringify(metadata)}, page=${page}, pageSize=${pageSize}`);
    const startTime = Date.now();

    // Convert filter to SQL
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    
    // Build the count query
    const countSQL = `SELECT COUNT(*) as count FROM files ${whereClause ? `WHERE ${whereClause}` : ''}`;
    const countResult = this.db.prepare(countSQL).get(...whereParams) as { count: number };
    const total = countResult.count;
    
    // Build the main query with sorting and pagination
    const offset = (page - 1) * pageSize;
    const mainSQL = `
      SELECT * FROM files 
      ${whereClause ? `WHERE ${whereClause}` : ''}
      ORDER BY CASE WHEN dateTaken IS NULL THEN 0 ELSE 1 END DESC, dateTaken DESC, relativePath ASC
      LIMIT ? OFFSET ?
    `;
    
    const rows = this.db.prepare(mainSQL).all(...whereParams, pageSize, offset) as Array<Record<string, any>>;
    const matchedFiles = rows.map(v=>rowToFileRecord(v, metadata));

    // Hydrate metadata for the current page
    const hydrationPromises = matchedFiles.map(file => 
      this.hydrateMetadata(file.relativePath, metadata)
    );

    const result = {
      items: await Promise.all(hydrationPromises) as Array<{ relativePath: string } & Pick<FileRecord, TMetadata[number]>>,
      page,
      pageSize,
      total,
    } as QueryResult<TMetadata>;
    const elapsed = Date.now() - startTime;
    console.log(`[query] Completed in ${elapsed}ms: ${result.total} total items, ${result.items.length} items on page`);
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
