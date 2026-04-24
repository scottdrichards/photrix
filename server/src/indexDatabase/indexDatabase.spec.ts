import { describe, it, expect, jest } from "@jest/globals";
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
    await db.init();
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

  it("persists and returns livePhotoVideoFileName in queried metadata", async () => {
    await withTempDb(async (db) => {
      await db.addFile(createRecord("live/photo.heic", { mimeType: "image/heic" }));
      await db.addOrUpdateFileData("live/photo.heic", {
        exifProcessedAt: "2026-01-05T00:00:00.000Z",
        livePhotoVideoFileName: "photo.MOV",
      });

      const record = await db.getFileRecord("live/photo.heic");
      expect(record?.livePhotoVideoFileName).toBe("photo.MOV");

      const result = await db.queryFiles({
        filter: {},
        metadata: ["livePhotoVideoFileName"],
        pageSize: 10,
        page: 1,
      });

      expect(result.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            folder: "/live/",
            fileName: "photo.heic",
            livePhotoVideoFileName: "photo.MOV",
          }),
        ]),
      );
    });
  });

  it("tracks missing metadata counters", async () => {
    await withTempDb(async (db) => {
      await db.addPaths(["a.jpg", "b.mp4", "doc.txt"]);

      expect(await db.countAllEntries()).toBe(3);
      expect(await db.countMediaEntries()).toBe(2);
      expect(await db.countImageEntries()).toBe(1);
      expect(await db.countMissingInfo()).toBe(3);
      expect(await db.countMissingDateTaken()).toBe(2);
    });
  });

  it("returns records needing metadata updates", async () => {
    await withTempDb(async (db) => {
      await db.addPaths(["a.jpg", "b.mp4"]);
      await db.addOrUpdateFileData("a.jpg", {
        exifProcessedAt: "2026-01-01T00:00:00.000Z",
      });

      const needingExif = await db.getFilesNeedingMetadataUpdate("exif", 10);

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

      const latest = await db.getMostRecentExifProcessedEntry();

      expect(latest?.folder).toBe("/");
      expect(latest?.fileName).toBe("newer.jpg");
      expect(latest?.completedAt).toBe("2026-01-03T00:00:00.000Z");
    });
  });

  it("returns queryFiles results sorted newest-first by dateTaken, falling back to created", async () => {
    await withTempDb(async (db) => {
      const oldest = new Date("2022-01-01T00:00:00.000Z");
      const middle = new Date("2023-06-15T00:00:00.000Z");
      const newest = new Date("2024-12-31T00:00:00.000Z");
      const noDate = new Date("2021-01-01T00:00:00.000Z");
      const exifAt = "2026-01-01T00:00:00.000Z";
      const infoAt = "2026-01-01T00:00:00.000Z";

      await db.addFile(
        createRecord("middle.jpg", { exifProcessedAt: exifAt, dateTaken: middle }),
      );
      await db.addFile(
        createRecord("oldest.jpg", { exifProcessedAt: exifAt, dateTaken: oldest }),
      );
      await db.addFile(
        createRecord("newest.jpg", { exifProcessedAt: exifAt, dateTaken: newest }),
      );
      // No dateTaken — should fall back to created for sort position
      await db.addFile(
        createRecord("nodateTaken.jpg", {
          infoProcessedAt: infoAt,
          created: noDate,
          modified: noDate,
        }),
      );

      const result = await db.queryFiles({
        filter: {},
        metadata: ["dateTaken"],
        pageSize: 10,
        page: 1,
      });

      expect(result.items.map((i) => i.fileName)).toEqual([
        "newest.jpg",
        "middle.jpg",
        "oldest.jpg",
        "nodateTaken.jpg",
      ]);
    });
  });
});
