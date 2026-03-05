import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileRecord } from "./fileRecord.type.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import { splitPath } from "./utils/pathUtils.ts";

const withTempDb = async (testFn: (db: IndexDatabase) => Promise<void>) => {
  const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-media-root-"));
  const dbRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-db-root-"));
  process.env.INDEX_DB_LOCATION = dbRoot;

  try {
    const db = new IndexDatabase(mediaRoot);
    await testFn(db);
  } finally {
    rmSync(mediaRoot, { recursive: true, force: true });
  }
};

const createRecord = (
  relativePath: string,
  overrides: Partial<FileRecord> = {},
): FileRecord => {
  const { folder, fileName } = splitPath(relativePath);
  return {
    folder,
    fileName,
    mimeType: relativePath.endsWith(".jpg") ? "image/jpeg" : "image/heic",
    ...overrides,
  };
};

describe("IndexDatabase", () => {
  it("adds and reads records", async () => {
    await withTempDb(async (db) => {
      await db.addFile(createRecord("sewing-threads.heic"));

      const record = await db.getFileRecord("sewing-threads.heic");

      expect(record?.folder).toBe("/");
      expect(record?.fileName).toBe("sewing-threads.heic");
      expect(record?.mimeType).toBe("image/heic");
    });
  });

  it("moves files to a new path", async () => {
    await withTempDb(async (db) => {
      await db.addFile(createRecord("old/file.heic"));
      await db.moveFile("old/file.heic", "new/renamed.heic");

      const oldRecord = await db.getFileRecord("old/file.heic");
      const movedRecord = await db.getFileRecord("new/renamed.heic");

      expect(oldRecord).toBeUndefined();
      expect(movedRecord?.folder).toBe("/new/");
      expect(movedRecord?.fileName).toBe("renamed.heic");
    });
  });

  it("throws when moving a missing file", async () => {
    await withTempDb(async (db) => {
      await expect(db.moveFile("missing.jpg", "new/missing.jpg")).rejects.toThrow(
        /does not exist/i,
      );
    });
  });

  it("merges updates in addOrUpdateFileData", async () => {
    await withTempDb(async (db) => {
      await db.addFile(createRecord("img.jpg"));
      await db.addOrUpdateFileData("img.jpg", {
        infoProcessedAt: "2026-01-01T00:00:00.000Z",
        sizeInBytes: 123,
        exifProcessedAt: "2026-01-02T00:00:00.000Z",
        cameraMake: "Canon",
        locationLatitude: 40.7,
      });

      const record = await db.getFileRecord("img.jpg");

      expect(record?.sizeInBytes).toBe(123);
      expect(record?.cameraMake).toBe("Canon");
      expect(record?.locationLatitude).toBeCloseTo(40.7, 3);
      expect(record?.mimeType).toBe("image/jpeg");
    });
  });

  it("tracks missing metadata counters", async () => {
    await withTempDb(async (db) => {
      db.addPaths(["a.jpg", "b.mp4", "doc.txt"]);

      expect(db.countAllEntries()).toBe(3);
      expect(db.countMediaEntries()).toBe(2);
      expect(db.countImageEntries()).toBe(1);
      expect(db.countMissingInfo()).toBe(3);
      expect(db.countMissingDateTaken()).toBe(2);
      expect(db.countNeedingThumbnails()).toBe(2);
    });
  });

  it("returns records needing metadata updates", async () => {
    await withTempDb(async (db) => {
      db.addPaths(["a.jpg", "b.mp4"]);
      await db.addOrUpdateFileData("a.jpg", {
        exifProcessedAt: "2026-01-01T00:00:00.000Z",
      });

      const needingExif = db.getFilesNeedingMetadataUpdate("exif", 10);

      expect(needingExif.map((f) => f.relativePath)).toContain("/b.mp4");
      expect(needingExif.map((f) => f.relativePath)).not.toContain("/a.jpg");
    });
  });

  it("returns most recent exif processed entry", async () => {
    await withTempDb(async (db) => {
      await db.addFile(
        createRecord("older.jpg", { exifProcessedAt: "2026-01-01T00:00:00.000Z" }),
      );
      await db.addFile(
        createRecord("newer.jpg", { exifProcessedAt: "2026-01-03T00:00:00.000Z" }),
      );

      const latest = db.getMostRecentExifProcessedEntry();

      expect(latest?.folder).toBe("/");
      expect(latest?.fileName).toBe("newer.jpg");
      expect(latest?.completedAt).toBe("2026-01-03T00:00:00.000Z");
    });
  });
});
