import { DatabaseFileEntry } from "./fileRecord.type.ts";
import { FileRecord } from "./indexDatabase.type.ts";

export const databaseEntryToFileRecord = (entry: DatabaseFileEntry): FileRecord => structuredClone({
  relativePath: entry.relativePath,
  mimeType: entry.mimeType,
  ...entry.info,
  ...entry.exifMetadata,
  ...entry.aiMetadata,
  ...entry.faceMetadata,
});