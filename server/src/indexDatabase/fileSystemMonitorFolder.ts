import { watch } from "node:fs";
import { lstat } from "node:fs/promises";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { fileSystemScanFolder } from "./fileSystemScanFolder.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import path from "node:path";

type FileChangeType = "delete" | "create";

export type FileChangeEvent = {
  relativePath: string;
  changeType: FileChangeType;
  class: "file" | "directory";
};

/**
 * Watches a directory and synchronizes changes to the database. Returns a function to stop watching.
 */
export const fileSystemMonitorFolder = (db: IndexDatabase) => {
  const rootPath = db.storagePath;

  const handleChange = async (_eventType: "rename" | "change", filename: string) => {
    const relativePath = ((value: string) =>
      stripLeadingSlash(value).replace(/\\/g, "/"))(
      path.relative(rootPath, path.join(rootPath, filename.toString())),
    );

    if (!relativePath) {
      return;
    }

    const absolutePath = path.join(rootPath, relativePath);

    try {
      const stats = await lstat(absolutePath);
      if (stats.isFile()) {
        await db.addPaths([relativePath]);
        return;
      }
      if (stats.isDirectory()) {
        await fileSystemScanFolder(db, absolutePath);
        return;
      }
    } catch {
      // Nothing exists
      if (!(await db.removeFile(relativePath))) {
        await db.removeFolder(relativePath);
      }
    }
  };

  const watcher = watch(rootPath, { recursive: true }, void handleChange);
  return () => watcher.close();
};
