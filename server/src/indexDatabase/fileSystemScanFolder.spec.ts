import { describe, expect, it, jest } from "@jest/globals";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// stat() fails with EIO for these file names, as a flaky network share can.
const unreadable = new Set<string>();
const realFs = await import("node:fs/promises");
jest.unstable_mockModule("node:fs/promises", () => ({
  ...realFs,
  stat: (target: string) =>
    unreadable.has(path.basename(target))
      ? Promise.reject(Object.assign(new Error("EIO: i/o error, stat"), { code: "EIO" }))
      : realFs.stat(target),
}));

const { fileSystemScanFolder } = await import("./fileSystemScanFolder.ts");
const { IndexDatabase } = await import("./indexDatabase.ts");

describe("fileSystemScanFolder", () => {
  it("keeps a listed file it can't stat, and prunes one that is really gone", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "photrix-scan-root-"));
    process.env.INDEX_DB_LOCATION = await fs.mkdtemp(path.join(os.tmpdir(), "photrix-scan-db-"));
    let db: InstanceType<typeof IndexDatabase> | undefined;
    try {
      for (const name of ["keep.jpg", "flaky.jpg", "deleted.jpg"]) {
        await fs.writeFile(path.join(rootDir, name), "x");
      }
      db = new IndexDatabase(rootDir);
      await db.init();
      await fileSystemScanFolder(db).onComplete();
      expect(await db.countAllEntries()).toBe(3);

      unreadable.add("flaky.jpg");
      await fs.rm(path.join(rootDir, "deleted.jpg"));
      await fileSystemScanFolder(db).onComplete();

      expect(await db.getFileRecord("flaky.jpg")).toBeDefined();
      expect(await db.getFileRecord("deleted.jpg")).toBeUndefined();
      expect(await db.countAllEntries()).toBe(2);
    } finally {
      await db?.close();
      unreadable.clear();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
