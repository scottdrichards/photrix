import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { getExifMetadataFromFile, getFileInfo } from "../fileHandling/fileUtils.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroupKeys, type DatabaseFileEntry } from "./fileRecord.type.ts";
import type { FileRecord, QueryOptions, QueryResult } from "./indexDatabase.type.ts";
import { matchesFilter } from "./matchesFilter.ts";

export class IndexDatabase {
  private readonly storagePath: string;
  private db: Database.Database;
  private readonly dbFilePath: string;
  private readonly insertOrReplaceStmt: Database.Statement;
  private readonly insertIfMissingStmt: Database.Statement;
  private readonly selectDataStmt: Database.Statement;

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
        data JSON NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.insertOrReplaceStmt = this.db.prepare(
      "INSERT OR REPLACE INTO files (relativePath, data) VALUES (?, ?)",
    );
    this.insertIfMissingStmt = this.db.prepare(
      "INSERT INTO files (relativePath, data) VALUES (?, ?) ON CONFLICT(relativePath) DO NOTHING",
    );
    this.selectDataStmt = this.db.prepare(
      "SELECT data FROM files WHERE relativePath = ?",
    );
  }

  async load(): Promise<void> {
    console.log(`[IndexDatabase] Database opened at ${this.dbFilePath}`);
    this.ensureRootPath();
    const count = this.db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
    console.log(`[IndexDatabase] Contains ${count.count} entries`);
  }

  async save(): Promise<void> {
    // No-op for SQLite
  }

  async addFile(fileData: DatabaseFileEntry): Promise<void> {
    this.insertOrReplaceStmt.run(fileData.relativePath, JSON.stringify(fileData));
  }

  async removeFile(relativePath: string): Promise<void> {
    this.db.prepare('DELETE FROM files WHERE relativePath = ?').run(relativePath);
  }

  async moveFile(oldRelativePath: string, newRelativePath: string): Promise<void> {
    const row = this.db.prepare('SELECT data FROM files WHERE relativePath = ?').get(oldRelativePath) as { data: string } | undefined;
    if (!row) {
      throw new Error(
        `moveFile: File at path "${oldRelativePath}" does not exist in the database.`,
      );
    }

    const originalEntry = JSON.parse(row.data) as DatabaseFileEntry;
    const updated: DatabaseFileEntry = {
      ...originalEntry,
      relativePath: newRelativePath,
    };

    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM files WHERE relativePath = ?').run(oldRelativePath);
      this.db.prepare('INSERT INTO files (relativePath, data) VALUES (?, ?)').run(newRelativePath, JSON.stringify(updated));
    });
    transaction();
  }

  async addOrUpdateFileData(
    relativePath: string,
    fileData: Partial<DatabaseFileEntry>,
  ): Promise<void> {
    const execute = () => {
      const row = this.selectDataStmt.get(relativePath) as { data: string } | undefined;
      const existingEntry = row ? JSON.parse(row.data) as DatabaseFileEntry : undefined;
      const updatedEntry = {
        ...(existingEntry ?? { relativePath, mimeType: mimeTypeForFilename(relativePath) }),
        ...fileData,
      };
      this.insertOrReplaceStmt.run(relativePath, JSON.stringify(updatedEntry));
    };

    await this.runWithRetry(execute);
  }

  async getFileRecord(
    relativePath: string,
    requiredMetadata?: Array<keyof FileRecord>,
  ): Promise<FileRecord | undefined> {
    const row = this.selectDataStmt.get(relativePath) as { data: string } | undefined;
    if (!row) {
      return undefined;
    }

    const record = JSON.parse(row.data) as FileRecord;

    if (!requiredMetadata?.length || !this.hydrationRequired(record, requiredMetadata)) {
      return record;
    }

    return await this.hydrateMetadata(relativePath, requiredMetadata);
  }

  getRecordsMissingDateTaken(limit = 50): FileRecord[] {
    const stmt = this.db.prepare(
      `SELECT data FROM files
       WHERE (json_extract(data, '$.mimeType') LIKE 'image/%' OR json_extract(data, '$.mimeType') LIKE 'video/%')
         AND json_extract(data, '$.dateTaken') IS NULL
         AND json_extract(data, '$.exifProcessedAt') IS NULL
       LIMIT ?`);
    const rows = stmt.all(limit) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as FileRecord);
  }

  countMissingInfo(): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM files
       WHERE json_extract(data, '$.sizeInBytes') IS NULL
          OR json_extract(data, '$.created') IS NULL
          OR json_extract(data, '$.modified') IS NULL`);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  countMissingDateTaken(): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM files
       WHERE (json_extract(data, '$.mimeType') LIKE 'image/%' OR json_extract(data, '$.mimeType') LIKE 'video/%')
         AND json_extract(data, '$.dateTaken') IS NULL
         AND json_extract(data, '$.exifProcessedAt') IS NULL`);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  countNeedingThumbnails(): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM files
       WHERE (json_extract(data, '$.mimeType') LIKE 'image/%' OR json_extract(data, '$.mimeType') LIKE 'video/%')
         AND COALESCE(json_extract(data, '$.thumbnailsReady'), 0) = 0
         AND json_extract(data, '$.thumbnailsProcessedAt') IS NULL`);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  countMediaEntries(): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM files
       WHERE json_extract(data, '$.mimeType') LIKE 'image/%'
          OR json_extract(data, '$.mimeType') LIKE 'video/%'`);
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
      `SELECT data FROM files
       WHERE (json_extract(data, '$.mimeType') LIKE 'image/%' OR json_extract(data, '$.mimeType') LIKE 'video/%')
         AND COALESCE(json_extract(data, '$.thumbnailsReady'), 0) = 0
         AND json_extract(data, '$.thumbnailsProcessedAt') IS NULL
       LIMIT ?`)
      .all(limit) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as FileRecord);
  }

  insertMissingPaths(paths: string[]): void {
    if (!paths.length) return;
    const tx = this.db.transaction((list: string[]) => {
      for (const relativePath of list) {
        const base: DatabaseFileEntry = {
          relativePath,
          mimeType: mimeTypeForFilename(relativePath),
        };
        this.insertIfMissingStmt.run(relativePath, JSON.stringify(base));
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
    const row = this.selectDataStmt.get(relativePath) as { data: string } | undefined;
    if (!row) {
      throw new Error(
        `hydrateMetadata: File at path "${relativePath}" does not exist in the database.`,
      );
    }
    const originalDBEntry = JSON.parse(row.data) as DatabaseFileEntry;
    
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
    const updatedRow = this.selectDataStmt.get(relativePath) as { data: string };
    return JSON.parse(updatedRow.data) as FileRecord;
  }

  *files(): IterableIterator<FileRecord> {
    const stmt = this.db.prepare('SELECT data FROM files');
    for (const row of stmt.iterate()) {
      yield JSON.parse((row as { data: string }).data) as FileRecord;
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
