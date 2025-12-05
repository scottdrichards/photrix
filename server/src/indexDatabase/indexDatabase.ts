import Database from "better-sqlite3";
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

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.dbFilePath = path.join(CACHE_DIR, "index.db");
    
    this.db = new Database(this.dbFilePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        relativePath TEXT PRIMARY KEY,
        data JSON NOT NULL
      )
    `);
  }

  async load(): Promise<void> {
    console.log(`[IndexDatabase] Database opened at ${this.dbFilePath}`);
    const count = this.db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
    console.log(`[IndexDatabase] Contains ${count.count} entries`);
  }

  async save(): Promise<void> {
    // No-op for SQLite
  }

  async addFile(fileData: DatabaseFileEntry): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO files (relativePath, data) VALUES (?, ?)').run(
      fileData.relativePath,
      JSON.stringify(fileData)
    );
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
    const row = this.db.prepare('SELECT data FROM files WHERE relativePath = ?').get(relativePath) as { data: string } | undefined;
    
    const existingEntry = row ? JSON.parse(row.data) as DatabaseFileEntry : undefined;
    
    const updatedEntry = {
      ...(existingEntry ?? { relativePath, mimeType: mimeTypeForFilename(relativePath) }),
      ...fileData,
    };

    this.db.prepare('INSERT OR REPLACE INTO files (relativePath, data) VALUES (?, ?)').run(
      relativePath,
      JSON.stringify(updatedEntry)
    );
  }

  async getFileRecord(
    relativePath: string,
    requiredMetadata?: Array<keyof FileRecord>,
  ): Promise<FileRecord | undefined> {
    const row = this.db.prepare('SELECT data FROM files WHERE relativePath = ?').get(relativePath) as { data: string } | undefined;
    if (!row) {
      return undefined;
    }

    const record = JSON.parse(row.data) as FileRecord;

    if (!requiredMetadata?.length || !this.hydrationRequired(record, requiredMetadata)) {
      return record;
    }

    return await this.hydrateMetadata(relativePath, requiredMetadata);
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
    const row = this.db.prepare('SELECT data FROM files WHERE relativePath = ?').get(relativePath) as { data: string } | undefined;
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
    const updatedRow = this.db.prepare('SELECT data FROM files WHERE relativePath = ?').get(relativePath) as { data: string };
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
}
