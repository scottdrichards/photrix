import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexDatabase } from "./indexDatabase.ts";

/**
 * Runs `testFn` against a fresh, empty database over an empty media root, then
 * closes it and deletes both directories.
 *
 * `init()` resolves before startup maintenance and the vector index load, which
 * both run in the background. Both are awaited first: maintenance can clear
 * fields a test just set, and cleanup must not delete the directory under a
 * load still in progress.
 */
export const withTempDb = async (testFn: (db: IndexDatabase) => Promise<void>) => {
  const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-media-root-"));
  const dbRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-db-root-"));
  process.env.INDEX_DB_LOCATION = dbRoot;
  let db: IndexDatabase | undefined;
  try {
    db = new IndexDatabase(mediaRoot);
    await db.init();
    await db.startupMaintenance;
    await db.vectorIndexLoaded;
    await testFn(db);
  } finally {
    await db?.close();
    rmSync(mediaRoot, { recursive: true, force: true });
    rmSync(dbRoot, { recursive: true, force: true });
  }
};
