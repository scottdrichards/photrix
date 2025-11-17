import path from "node:path";
import { databaseEntryToFileRecord } from "./databaseEntryToFileRecord.ts";
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

    const record = databaseEntryToFileRecord(dbEntry);

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
    const record = databaseEntryToFileRecord(originalDBEntry);
    const promises = Array.from(requiredMetadata)
      .map((m) => {
        if (m in record) {
          return "groupAlreadyRetrieved";
        }

        const metadataGroupKey = Object.entries(MetadataGroupKeys).find(([_, keys]) => {
          // Union causing issues... so have to cast as unknown
          if ((keys as unknown as Array<keyof FileRecord>).includes(m)) {
            return true;
          }
          return false;
        });
        if (!metadataGroupKey) {
          throw new Error(`Requested metadata key "${m}" is not recognized.`);
        }

        const groupName = metadataGroupKey[0] as keyof typeof MetadataGroupKeys;
        if (groupName in originalDBEntry!) {
          return "groupAlreadyRetrieved";
        }
        return groupName;
      })
      .filter((g) => g !== "groupAlreadyRetrieved")
      .map(async (groupName) => {
        const fullPath = path.join(this.storagePath, relativePath);
        let extraData = {};
        switch (groupName) {
          case "info":
            extraData = { info: await getFileInfo(fullPath) };
            break;
          case "exifMetadata":
            extraData = { exifMetadata: await getExifMetadataFromFile(fullPath) };
            break;
          case "aiMetadata":
          case "faceMetadata":
            // Not implemented yet
            return Promise.resolve({});
          default:
            throw new Error(`Unhandled metadata group "${groupName}"`);
        }
        this.addOrUpdateFileData(relativePath, extraData);
      });
    await Promise.all(promises);
    return this.entries.get(relativePath);
  }

  files() {
    return this.entries.values().map(databaseEntryToFileRecord);
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

    const allRecords = Array.from(
      this.files().filter((record) => matchesFilter(record, filter)),
    );
    const records = allRecords.filter(
      (r, index) => index >= (page - 1) * pageSize && index < page * pageSize,
    );

    // Ensure required metadata is loaded for paginated items
    if (metadata.length) {
      await Promise.all(
        records.map((record) => this.hydrateMetadata(record.relativePath, metadata)),
      );
    }

    // Build result items
    const items = records.map((record) => {
      const item: Record<string, unknown> = { relativePath: record.relativePath };
      if (metadata) {
        for (const key of metadata) {
          item[key as string] = record[key];
        }
      }
      return item as { relativePath: string } & Pick<FileRecord, TMetadata[number]>;
    });

    return {
      items,
      page,
      pageSize,
      total: allRecords.length,
    } as QueryResult<TMetadata>;
  }
}
