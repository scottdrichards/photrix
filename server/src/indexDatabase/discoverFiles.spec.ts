import { beforeEach, describe, expect, it } from "@jest/globals";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileSystemScanFolder } from "./fileSystemScanFolder.ts";
import { IndexDatabase } from "./indexDatabase.ts";

const mkTempDir = async (prefix: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), prefix));

describe("discoverFiles", () => {
  beforeEach(() => {
    process.env.ThumbnailCacheDirectory ??= path.join(os.tmpdir(), "photrix-test-thumbs");
  });

  it("adds discovered files to the database", async () => {
    const rootDir = await mkTempDir("photrix-discover-root-");
    const dbDir = await mkTempDir("photrix-discover-db-");
    process.env.INDEX_DB_LOCATION = dbDir;

    try {
      await fs.mkdir(path.join(rootDir, "nested"), { recursive: true });
      await fs.writeFile(path.join(rootDir, "a.jpg"), "a");
      await fs.writeFile(path.join(rootDir, "nested", "b.mp4"), "b");

      const db = new IndexDatabase(rootDir);
      await db.init();
      await fileSystemScanFolder(db);

      const a = await db.getFileRecord("a.jpg");
      const b = await db.getFileRecord("nested/b.mp4");

      expect(a?.mimeType).toBe("image/jpeg");
      expect(b?.mimeType).toBe("video/mp4");
      expect(await db.countAllEntries()).toBe(2);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
