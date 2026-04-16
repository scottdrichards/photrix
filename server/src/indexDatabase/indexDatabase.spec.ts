import { describe, it, expect, jest } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileRecord } from "./fileRecord.type.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import { ConversionTaskPriority } from "./indexDatabase.type.ts";
import { splitPath } from "./utils/pathUtils.ts";

const withTempDb = async (testFn: (db: IndexDatabase) => Promise<void>) => {
  const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-media-root-"));
  const dbRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-db-root-"));
  process.env.INDEX_DB_LOCATION = dbRoot;

  try {
    const db = await IndexDatabase.create(mediaRoot);
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
      expect((await db.countPendingConversions()).thumbnail).toBe(2);
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

  it("returns the highest-priority conversion task from thumbnail or HLS queues", async () => {
    await withTempDb(async (db) => {
      await db.addPaths(["photo.jpg", "video.mp4"]);
      await db.addOrUpdateFileData("video.mp4", {
        duration: 12,
      });
      await db.setConversionPriority(
        "photo.jpg",
        "thumbnail",
        ConversionTaskPriority.UserImplicit,
      );
      await db.setConversionPriority(
        "video.mp4",
        "thumbnail",
        ConversionTaskPriority.Background,
      );
      await db.setConversionPriority(
        "video.mp4",
        "hls",
        ConversionTaskPriority.UserBlocked,
      );

      const [nextTask] = await db.getNextConversionTasks();

      expect(nextTask).toEqual({
        relativePath: "/video.mp4",
        taskType: "hls",
      });
    });
  });

  it("userImplicit conversion queue is LIFO", async () => {
    await withTempDb(async (db) => {
      await db.addPaths(["older.jpg", "newer.jpg"]);

      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        await db.setConversionPriority("older.jpg", "thumbnail", ConversionTaskPriority.UserImplicit);

        jest.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
        await db.setConversionPriority("newer.jpg", "thumbnail", ConversionTaskPriority.UserImplicit);
      } finally {
        jest.useRealTimers();
      }

      const [nextTask] = await db.getNextConversionTasks();

      expect(nextTask).toEqual({
        relativePath: "/newer.jpg",
        taskType: "thumbnail",
      });
    });
  });

  it("raiseConversionPriority bumps background items but does not lower higher-priority or already-converted items", async () => {
    await withTempDb(async (db) => {
      await db.addPaths(["background.jpg", "blocked.jpg", "converted.jpg"]);
      await db.setConversionPriority("background.jpg", "thumbnail", ConversionTaskPriority.Background);
      await db.setConversionPriority("blocked.jpg", "thumbnail", ConversionTaskPriority.UserBlocked);
      await db.setConversionPriority("converted.jpg", "thumbnail", null); // mark as done

      await db.raiseConversionPriority(
        ["/background.jpg", "/blocked.jpg", "/converted.jpg"],
        "thumbnail",
        ConversionTaskPriority.UserImplicit,
      );

      const background = await db.getConversionTaskInfo("/background.jpg", "thumbnail");
      const blocked = await db.getConversionTaskInfo("/blocked.jpg", "thumbnail");
      const converted = await db.getConversionTaskInfo("/converted.jpg", "thumbnail");

      expect(background?.priority).toBe(ConversionTaskPriority.UserImplicit);
      expect(blocked?.priority).toBe(ConversionTaskPriority.UserBlocked);
      expect(converted?.priority).toBeNull();
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
});
