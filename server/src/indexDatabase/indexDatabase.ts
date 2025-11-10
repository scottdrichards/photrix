import path from "node:path";
import { databaseEntryToFileRecord } from "./databaseEntryToFileRecord.js";
import { MetadataGroupKeys, type DatabaseFileEntry } from "./fileRecord.type.js";
import { getExifMetadataFromFile, getFileInfo } from "./fileUtils.js";
import type {
  FileRecord,
  QueryOptions,
  QueryResult,
  FilterElement,
} from "./indexDatabase.type.js";

export class IndexDatabase {
  private readonly storagePath?: string;
  private entries: Record<string, DatabaseFileEntry>;

  constructor(storagePath?: string) {
    this.storagePath = storagePath;
    this.entries = {};
  }

  async addFile(fileData: DatabaseFileEntry): Promise<void> {
    this.entries[fileData.relativePath] = structuredClone(fileData);
  }

  async removeFile(relativePath: string): Promise<void> {
    delete this.entries[relativePath];
  }

  async moveFile(oldRelativePath: string, newRelativePath: string): Promise<void> {
    const existing = this.entries[oldRelativePath];
    if (!existing) {
      throw new Error(
        `moveFile: File at path "${oldRelativePath}" does not exist in the database.`,
      );
    }

    const updated: DatabaseFileEntry = {
      ...existing,
      relativePath: newRelativePath,
    };

    delete this.entries[oldRelativePath];
    this.entries[newRelativePath] = updated;
  }

  async addOrUpdateFileData(
    relativePath: string,
    fileData: Partial<DatabaseFileEntry>,
  ): Promise<void> {
    const existingEntry = this.entries[relativePath];
    if (!existingEntry) {
      throw new Error(`File at path "${relativePath}" does not exist in the database.`);
    }
    this.entries[relativePath] = {
      ...existingEntry,
      ...fileData,
    };
  }

  async getFileRecord(
    relativePath: string,
    /**
     * Optional set of metadata keys to ensure are loaded in the returned FileRecord.
     * This will fetch any missing metadata from storage if not already present in the database.
     * so if you want it to only use available data in the database, leave this undefined.
     */
    requiredMetadata?: Set<keyof FileRecord>,
  ): Promise<FileRecord | undefined> {
    const dbEntry = this.entries[relativePath];
    if (!dbEntry) {
      return undefined;
    }

    const record = databaseEntryToFileRecord(dbEntry);

    if (!requiredMetadata?.size) {
      return record;
    }

    await this.hydrateMetadata(relativePath, requiredMetadata);
    return this.getFileRecord(relativePath);
  }

  private async hydrateMetadata(
    relativePath: string,
    requiredMetadata: Set<keyof FileRecord>,
  ) {
    const dbEntry = this.entries[relativePath];
    const record = databaseEntryToFileRecord(dbEntry);
    const promises = Array.from(requiredMetadata)
      .map((m) => {
        if (m in record) {
          return "groupAlreadyRetrieved";
        }

        const found = Object.entries(MetadataGroupKeys).find(([_, keys]) => {
          // Union causing issues... so have to cast as unknown
          if ((keys as unknown as Array<keyof FileRecord>).includes(m)) {
            return true;
          }
          return false;
        });
        if (!found) {
          throw new Error(`Requested metadata key "${String(m)}" is not recognized.`);
        }

        const groupName = found[0] as keyof typeof MetadataGroupKeys;
        if (groupName in dbEntry) {
          return "groupAlreadyRetrieved";
        }
        return groupName;
      })
      .filter((g) => g !== "groupAlreadyRetrieved")
      .map(async (groupName) => {
        if (!this.storagePath) {
          throw new Error(
            `Cannot fetch missing metadata group "${groupName}" without storagePath configured on IndexDatabase.`,
          );
        }
        const fullPath = path.join(this.storagePath, relativePath);
        switch (groupName) {
          case "info":
            this.entries[relativePath].info = await getFileInfo(fullPath);
            break;
          case "exifMetadata":
            this.entries[relativePath].exifMetadata =
              await getExifMetadataFromFile(fullPath);
            break;
          case "aiMetadata":
          case "faceMetadata":
            // Not implemented yet
            return Promise.resolve({});
          default:
            throw new Error(`Unhandled metadata group "${groupName}"`);
        }
      });
    await Promise.all(promises);
  }

  async listFiles(): Promise<FileRecord[]> {
    const records: FileRecord[] = [];
    for (const entry of Object.values(this.entries)) {
      records.push(databaseEntryToFileRecord(entry));
    }
    return records;
  }

  async queryFiles<TMetadata extends Array<keyof FileRecord> | undefined = undefined>(
    options: QueryOptions,
  ): Promise<QueryResult<TMetadata>> {
    const { filter, metadata, pageSize = 50, page = 1 } = options;

    // Get all records
    const allRecords = await this.listFiles();

    // Apply filter
    const filteredRecords = allRecords.filter((record) =>
      this.matchesFilter(record, filter),
    );

    // Paginate
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedRecords = filteredRecords.slice(startIndex, endIndex);

    // Ensure required metadata is loaded for paginated items
    if (metadata) {
      const metadataSet = new Set(metadata) as Set<keyof FileRecord>;
      await Promise.all(
        paginatedRecords.map((record) =>
          this.hydrateMetadata(record.relativePath, metadataSet),
        ),
      );
    }

    // Build result items
    const items = paginatedRecords.map((record) => {
      const item: Record<string, unknown> = { relativePath: record.relativePath };
      if (metadata) {
        for (const key of metadata) {
          item[key as string] = record[key];
        }
      }
      return item;
    });

    return {
      items,
      total: filteredRecords.length,
      page,
      pageSize,
    } as QueryResult<TMetadata>;
  }

  private matchesFilter(record: FileRecord, filter: FilterElement): boolean {
    if ("operation" in filter) {
      // LogicalFilter
      if (filter.operation === "and") {
        return filter.conditions.every((cond: FilterElement) =>
          this.matchesFilter(record, cond),
        );
      } else {
        return filter.conditions.some((cond: FilterElement) =>
          this.matchesFilter(record, cond),
        );
      }
    }

    // FilterCondition
    for (const [key, value] of Object.entries(filter)) {
      if (value === null) {
        // Field must be missing/undefined
        if (record[key as keyof FileRecord] !== undefined) {
          return false;
        }
      } else if (key in record) {
        const recordValue = record[key as keyof FileRecord];
        // Simple equality check for now - can be enhanced
        if (recordValue !== value) {
          return false;
        }
      } else {
        // Field doesn't exist in record but filter expects it
        return false;
      }
    }

    return true;
  }
}
