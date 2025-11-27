import path from "node:path";
import { MetadataGroupKeys, type DatabaseFileEntry } from "./fileRecord.type.ts";
import { getExifMetadataFromFile, getFileInfo } from "../fileHandling/fileUtils.ts";
import type { FileRecord, QueryOptions, QueryResult } from "./indexDatabase.type.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { matchesFilter } from "./matchesFilter.ts";

export class IndexDatabase {
  private readonly storagePath: string;
  private entries: Map<string, DatabaseFileEntry>;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.entries = new Map();
  }

  async addFile(fileData: DatabaseFileEntry): Promise<void> {
    this.entries.set(fileData.relativePath, structuredClone(fileData));
  }

  async removeFile(relativePath: string): Promise<void> {
    this.entries.delete(relativePath);
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
    const dbEntry = this.entries.get(relativePath);
    if (!dbEntry) {
      return undefined;
    }

    // Already flat, just return a clone
    const record = structuredClone(dbEntry) as FileRecord;

    if (!requiredMetadata?.length) {
      return record;
    }

    return await this.hydrateMetadata(relativePath, requiredMetadata);
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
              console.log(`[metadata] Reading EXIF for ${relativePath} (${mimeType})`);
              const exifStart = Date.now();
              extraData = await getExifMetadataFromFile(fullPath);
              console.log(`[metadata] EXIF read for ${relativePath} took ${Date.now() - exifStart}ms`);
            } catch (error) {
              // File format doesn't support EXIF or parsing failed
              console.warn(`[metadata] Could not read EXIF metadata for ${relativePath}:`, error instanceof Error ? error.message : String(error));
              extraData = {};
            }
          } else {
            // Non-media file, skip EXIF parsing
            console.log(`[metadata] Skipping EXIF for non-media file ${relativePath} (${mimeType})`);
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
      const isEarlierPage = matches < (page-1) * pageSize;
      if (isEarlierPage){
        continue;
      }
      hydrationPromises.push(this.hydrateMetadata(file.relativePath, metadata));
      const lastOfPage = matches === (page * pageSize) - 1;
      if (lastOfPage){
        // break;
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
}
