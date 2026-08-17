import { beforeEach, describe, expect, it } from "@jest/globals";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileSystemScanFolder } from "./fileSystemScanFolder.ts";
import { IndexDatabase } from "./indexDatabase.ts";

const mkTempDir = async (prefix: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), prefix));

describe("fileSystemScanFolder: media root unavailable", () => {
  beforeEach(() => {
    process.env.ThumbnailCacheDirectory ??= path.join(os.tmpdir(), "photrix-test-thumbs");
  });

  it("does not prune the index when the root directory itself is missing", async () => {
    const rootDir = await mkTempDir("photrix-missing-root-");
    const dbDir = await mkTempDir("photrix-missing-db-");
    process.env.INDEX_DB_LOCATION = dbDir;

    try {
      await fs.writeFile(path.join(rootDir, "keep.jpg"), "k");

      const db = new IndexDatabase(rootDir);
      await db.init();
      await fileSystemScanFolder(db).onComplete();
      expect(await db.countAllEntries()).toBe(1);
      expect(db.mediaRootUnavailable).toBe(false);

      // Simulate the media root going away entirely (e.g. an unmounted CIFS
      // share that doesn't even present an empty directory).
      await fs.rm(rootDir, { recursive: true, force: true });

      await fileSystemScanFolder(db).onComplete();

      expect(db.mediaRootUnavailable).toBe(true);
      expect(await db.countAllEntries()).toBe(1);
      expect(await db.getFileRecord("keep.jpg")).toBeDefined();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("does not prune the index when the root exists but scans zero files against a non-empty index", async () => {
    const rootDir = await mkTempDir("photrix-empty-mount-root-");
    const dbDir = await mkTempDir("photrix-empty-mount-db-");
    process.env.INDEX_DB_LOCATION = dbDir;

    try {
      await fs.writeFile(path.join(rootDir, "keep.jpg"), "k");

      const db = new IndexDatabase(rootDir);
      await db.init();
      await fileSystemScanFolder(db).onComplete();
      expect(await db.countAllEntries()).toBe(1);

      // Simulate an interim/empty mount: the directory exists (mountpoint
      // present) but is empty because nothing is actually mounted there.
      await fs.rm(path.join(rootDir, "keep.jpg"));

      await fileSystemScanFolder(db).onComplete();

      expect(db.mediaRootUnavailable).toBe(true);
      expect(await db.countAllEntries()).toBe(1);
      expect(await db.getFileRecord("keep.jpg")).toBeDefined();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("resumes normal pruning and clears the flag once the root is available again", async () => {
    const rootDir = await mkTempDir("photrix-recovers-root-");
    const dbDir = await mkTempDir("photrix-recovers-db-");
    process.env.INDEX_DB_LOCATION = dbDir;

    try {
      await fs.writeFile(path.join(rootDir, "keep.jpg"), "k");
      await fs.writeFile(path.join(rootDir, "gone.jpg"), "g");

      const db = new IndexDatabase(rootDir);
      await db.init();
      await fileSystemScanFolder(db).onComplete();
      expect(await db.countAllEntries()).toBe(2);

      // Go through an unavailable window.
      await fs.rm(path.join(rootDir, "keep.jpg"));
      await fs.rm(path.join(rootDir, "gone.jpg"));
      await fileSystemScanFolder(db).onComplete();
      expect(db.mediaRootUnavailable).toBe(true);
      expect(await db.countAllEntries()).toBe(2);

      // Root becomes available again, with one real deletion this time.
      await fs.writeFile(path.join(rootDir, "keep.jpg"), "k");
      await fileSystemScanFolder(db).onComplete();

      expect(db.mediaRootUnavailable).toBe(false);
      expect(await db.countAllEntries()).toBe(1);
      expect(await db.getFileRecord("keep.jpg")).toBeDefined();
      expect(await db.getFileRecord("gone.jpg")).toBeUndefined();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
