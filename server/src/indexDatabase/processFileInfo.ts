import { stat } from "node:fs/promises";
import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { FileInfo } from "./fileRecord.type.ts";
import { IndexDatabase } from "./indexDatabase.ts";

const batchSize = 200;

const getFileInfoMetadata = async (fullPath: string): Promise<FileInfo> =>
  stat(fullPath).then((stats) => ({
    sizeInBytes: stats.size,
    created: new Date(stats.birthtimeMs),
    modified: new Date(stats.mtimeMs),
  }));

/**
 *
 * @param database
 * @param waitForEnabled Should return a promise that can indefinitely block the current loop
 * @param onComplete Called
 * @returns
 */
export const processFileInfoMetadata = async (
  database: IndexDatabase,
  waitForEnabled: () => Promise<void>,
  onComplete?: () => void,
) => {
  while (true) {
    const items = await database.getFilesNeedingMetadataUpdate("info", batchSize);

    if (items.length === 0) {
      onComplete?.();
      break;
    }

    for (const entry of items) {
      await waitForEnabled();

      const { relativePath } = entry;
      const fullPath = path.join(database.storagePath, stripLeadingSlash(relativePath));
      await getFileInfoMetadata(fullPath)
        .then((metadata) => database.addOrUpdateFileData(relativePath, metadata))
        .catch((e: unknown) => {
          if (typeof e === "object" && !!e && "code" in e && e.code === "ENOENT") {
            return database.removeFile(relativePath);
          }
        });
    }
  }
};
