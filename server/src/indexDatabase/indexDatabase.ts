import path from "node:path";
import { databaseEntryToFileRecord } from "./databaseEntryToFileRecord.js";
import {
  MetadataGroupKeys,
  type DatabaseFileEntry
} from "./fileRecord.type.js";
import { getExifMetadataFromFile, getFileInfo } from "./fileUtils.js";
import type { FileRecord } from "./indexDatabase.type.js";

const DEFAULT_PAGE_SIZE = 50;

export class IndexDatabase {
  private readonly storagePath: string;
  private entries: Record<string, DatabaseFileEntry>;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.entries = {};
  }

  async addFile(fileData: DatabaseFileEntry): Promise<void> {
    this.entries[fileData.relativePath] = structuredClone(fileData);
  }

  async removeFile(relativePath: string): Promise<void> {
    delete this.entries[relativePath];
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
     * Optional array of metadata keys to ensure are loaded in the returned FileRecord.
     * This will fetch any missing metadata from storage if not already present in the database.
     * so if you want it to only use available data in the database, leave this undefined.
     */
    requiredMetadata?: Array<keyof FileRecord>,
  ): Promise<FileRecord | undefined> {
    const dbEntry = this.entries[relativePath];
    if (!dbEntry) {
      return undefined;
    }

    const record = databaseEntryToFileRecord(dbEntry);

    if (!requiredMetadata || requiredMetadata.length === 0) {
		return record;
    }

    const groupsRequired = requiredMetadata.map<
      keyof typeof MetadataGroupKeys | "groupAlreadyRetrieved"
    >((m) => {
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
    });

    const promises = Array.from(new Set(groupsRequired))
      .filter((g) => g !== "groupAlreadyRetrieved")
      .map(async (groupName) => {
        const fullPath = path.join(
          this.storagePath,
          relativePath,
        );
        switch (groupName) {
          case 'info':
            this.entries[relativePath].info = await getFileInfo(fullPath);
            break;
          case "exifMetadata":
            this.entries[relativePath].exifMetadata = await getExifMetadataFromFile(fullPath);
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
    return this.getFileRecord(relativePath);
  }
}
