import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileSystemScanFolder } from "./fileSystemScanFolder.ts";
import { IndexDatabase } from "./indexDatabase.ts";

const mkTempDir = async (prefix: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), prefix));

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

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
      await fileSystemScanFolder(db).onComplete();

      const a = await db.getFileRecord("a.jpg");
      const b = await db.getFileRecord("nested/b.mp4");

      expect(a?.mimeType).toBe("image/jpeg");
      expect(b?.mimeType).toBe("video/mp4");
      expect(await db.countAllEntries()).toBe(2);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("pauses and resumes a scan in-flight", async () => {
    const rootDir = await mkTempDir("photrix-scan-controls-root-");

    try {
      const files = Array.from({ length: 501 }, (_unused, index) =>
        path.join(rootDir, `f-${index}.jpg`),
      );
      await Promise.all(files.map((filePath) => fs.writeFile(filePath, "x")));

      const firstBatchEntered = createDeferred();
      const releaseFirstBatch = createDeferred();
      let addPathsCalls = 0;

      const addPaths = jest.fn(async (_relativePaths: string[]) => {
        addPathsCalls += 1;
        if (addPathsCalls === 1) {
          firstBatchEntered.resolve();
          await releaseFirstBatch.promise;
        }
      });

      const runner = fileSystemScanFolder({
        storagePath: rootDir,
        addPaths,
      } as unknown as IndexDatabase);

      await firstBatchEntered.promise;
      runner.pause?.();
      releaseFirstBatch.resolve();

      await Promise.resolve();
      await Promise.resolve();
      expect(addPathsCalls).toBe(1);

      await runner.resume?.();
      await runner.onComplete();
      expect(addPathsCalls).toBe(2);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("cancels a scan in-flight", async () => {
    const rootDir = await mkTempDir("photrix-scan-cancel-root-");

    try {
      const files = Array.from({ length: 501 }, (_unused, index) =>
        path.join(rootDir, `c-${index}.jpg`),
      );
      await Promise.all(files.map((filePath) => fs.writeFile(filePath, "x")));

      const firstBatchEntered = createDeferred();
      const releaseFirstBatch = createDeferred();
      let addPathsCalls = 0;

      const addPaths = jest.fn(async (_relativePaths: string[]) => {
        addPathsCalls += 1;
        if (addPathsCalls === 1) {
          firstBatchEntered.resolve();
          await releaseFirstBatch.promise;
        }
      });

      const runner = fileSystemScanFolder({
        storagePath: rootDir,
        addPaths,
      } as unknown as IndexDatabase);

      await firstBatchEntered.promise;
      runner.cancel?.();
      releaseFirstBatch.resolve();

      await expect(runner.onComplete()).rejects.toThrow("cancelled");
      expect(addPathsCalls).toBe(1);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
