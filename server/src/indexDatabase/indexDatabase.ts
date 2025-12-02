import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { getExifMetadataFromFile, getFileInfo } from "../fileHandling/fileUtils.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroupKeys, type DatabaseFileEntry } from "./fileRecord.type.ts";
import type { FileRecord, QueryOptions, QueryResult } from "./indexDatabase.type.ts";
import { matchesFilter } from "./matchesFilter.ts";

export class IndexDatabase {
  private readonly storagePath: string;
  private entries: Map<string, DatabaseFileEntry>;
  private isDirty = false;
  private readonly dbFilePath: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.entries = new Map();
    this.dbFilePath = path.join(CACHE_DIR, "index.json");
    
    // Auto-save every 10 seconds if dirty
    setInterval(() => {
      void this.save();
    }, 10_000);
  }

  async load(): Promise<void> {
    try {
      console.log(`[IndexDatabase] Loading database from ${this.dbFilePath}`);
      const data = await readFile(this.dbFilePath, "utf-8");
      const entries = JSON.parse(data) as [string, DatabaseFileEntry][];
      this.entries = new Map(entries);
      console.log(`[IndexDatabase] Loaded ${this.entries.size} entries`);
    } catch (error) {
      // Ignore error if file doesn't exist (first run)
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[IndexDatabase] Failed to load database:", error);
      } else {
        console.log("[IndexDatabase] No existing database found, starting fresh.");
      }
    }
  }

  async save(): Promise<void> {
    if (!this.isDirty) return;
    
    try {
      console.log(`[IndexDatabase] Saving ${this.entries.size} entries to disk...`);
      const data = JSON.stringify(Array.from(this.entries.entries()));
      await writeFile(this.dbFilePath, data, "utf-8");
      this.isDirty = false;
      console.log("[IndexDatabase] Save complete.");
    } catch (error) {
      console.error("[IndexDatabase] Failed to save database:", error);
    }
  }

  async addFile(fileData: DatabaseFileEntry): Promise<void> {
    this.entries.set(fileData.relativePath, structuredClone(fileData));
    this.isDirty = true;
  }

  async removeFile(relativePath: string): Promise<void> {
    this.entries.delete(relativePath);
    this.isDirty = true;
  }

  async moveFile(oldRelativePath: string, newRelativePath: string): Promise<void> {
    const originalEntry = this.entries.get(oldRelativePath);
    if (!originalEntry) {
      throw new Error(
        `moveFile: File at path "${oldRelativePath}" does not exist in the database.`,
      );
    }

    const updated: DatabaseFileEntry = {
      ...originalEntry,
      relativePath: newRelativePath,
    };

    this.entries.delete(oldRelativePath);
    this.entries.set(newRelativePath, updated);
    this.isDirty = true;
  }

  async addOrUpdateFileData(
    relativePath: string,
    fileData: Partial<DatabaseFileEntry>,
  ): Promise<void> {
    const existingEntry = this.entries.get(relativePath);
    this.entries.set(relativePath, {
      ...(existingEntry ?? { relativePath, mimeType: mimeTypeForFilename(relativePath) }),
      ...fileData,
    });
    this.isDirty = true;
  }

  async getFileRecord(
    relativePath: string,
    /**
     * Optional set of metadata keys to ensure are loaded in the returned FileRecord.
     * This will fetch any missing metadata from storage if not already present in the database.
     * so if you want it to only use available data in the database, leave this undefined.
     */
    requiredMetadata?: Array<keyof FileRecord>,
  ): Promise<FileRecord | undefined> {
    const record = this.entries.get(relativePath);
    if (!record) {
      return undefined;
    }

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
    const originalDBEntry = this.entries.get(relativePath);
    if (!originalDBEntry) {
      throw new Error(
        `hydrateMetadata: File at path "${relativePath}" does not exist in the database.`,
      );
    }
    
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
    });
    
    await Promise.all(promises);
    return this.entries.get(relativePath) as FileRecord;
  }

  files(): IterableIterator<FileRecord> {
    // Entries are already flat, just cast to FileRecord
    return this.entries.values() as IterableIterator<FileRecord>;
  }

  /**
   * 
   * @param relativePath Start without slash, end in "/" - root is ""
   * @returns 
   */
  getFolders(relativePath: string): Array<string> {
    const baseFolderPath = relativePath !== "" ? (relativePath.endsWith("/") ? relativePath : relativePath + "/") : "";
    
    const folders = this.entries
      .keys()
      .filter((entryPath) => entryPath.startsWith(baseFolderPath))
      .map((entryPath) => entryPath.substring(baseFolderPath.length).split("/"))
      .filter((pathParts) => pathParts.length > 1) // Must have at least a folder and filename
      .reduce((folderSet, pathParts) => folderSet.add(pathParts[0]), new Set<string>());

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
    return this.entries.size;
  }
}
