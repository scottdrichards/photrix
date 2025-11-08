import { DatabaseFileEntry } from "./fileRecord.type.js";
import { FileRecord } from "./indexDatabase.type.js";

export const databaseEntryToFileRecord = (entry: DatabaseFileEntry): FileRecord => structuredClone({
  relativePath: entry.relativePath,
  mimeType: entry.mimeType,
  ...entry.info,
  ...entry.exifMetadata,
  ...entry.aiMetadata,
  ...entry.faceMetadata,
});