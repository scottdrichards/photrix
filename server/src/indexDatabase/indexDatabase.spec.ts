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

  it("only returns face tasks after EXIF processing is complete", async () => {
    await withTempDb(async (db) => {
      await db.addPaths(["no-exif.jpg", "with-exif.jpg"]);
      await db.addOrUpdateFileData("with-exif.jpg", {
        exifProcessedAt: "2026-01-01T00:00:00.000Z",
      });

      const needingFaces = await db.getFilesNeedingMetadataUpdate("faces", 10);

      expect(needingFaces.map((f) => f.relativePath)).toEqual(["/with-exif.jpg"]);
    });
  });

  it("prioritizes unattempted face scans ahead of failed ones", async () => {
    await withTempDb(async (db) => {
      await db.addPaths(["fresh.jpg", "failed.jpg"]);
      await db.addOrUpdateFileData("fresh.jpg", {
        exifProcessedAt: "2026-01-01T00:00:00.000Z",
      });
      await db.addOrUpdateFileData("failed.jpg", {
        exifProcessedAt: "2026-01-01T00:00:00.000Z",
        facesLastErrorAt: "2026-01-02T00:00:00.000Z",
      });

      const needingFaces = await db.getFilesNeedingMetadataUpdate("faces", 10);

      expect(needingFaces.map((f) => f.relativePath)).toEqual([
        "/fresh.jpg",
        "/failed.jpg",
      ]);
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

  it("keeps missing date fields nullish in query results", async () => {
    await withTempDb(async (db) => {
      await db.addFile(
        createRecord("no-dates.jpg", { exifProcessedAt: "2026-01-01T00:00:00.000Z" }),
      );

      const result = await db.queryFiles({
        filter: {},
        metadata: ["created", "modified", "dateTaken"],
        pageSize: 10,
        page: 1,
      });

      const row = result.items.find((item) => item.fileName === "no-dates.jpg");

      expect(row).toBeDefined();
      expect(row?.created).toBeUndefined();
      expect(row?.modified).toBeUndefined();
      expect(row?.dateTaken).toBeUndefined();
    });
  });

  it("sorts all-null date items deterministically by path", async () => {
    await withTempDb(async (db) => {
      await db.addFile(createRecord("z-last.jpg"));
      await db.addFile(createRecord("a-first.jpg"));

      const result = await db.queryFiles({
        filter: {},
        metadata: ["dateTaken"],
        pageSize: 10,
        page: 1,
      });

      expect(result.items.map((item) => item.fileName)).toEqual([
        "a-first.jpg",
        "z-last.jpg",
      ]);
    });
  });

  describe("face detection persistence", () => {
    const makeEmbedding = (seed: number) => {
      const arr = new Float64Array(128);
      for (let i = 0; i < arr.length; i += 1) {
        arr[i] = Math.sin(seed + i) * 0.1;
      }
      return arr;
    };

    it("round-trips face rows including float64 embedding values", async () => {
      await withTempDb(async (db) => {
        await db.addFile(createRecord("portraits/two.jpg"));

        const embedding1 = makeEmbedding(1);
        const embedding2 = makeEmbedding(2);
        await db.saveFaceDetectionResult(
          "portraits/two.jpg",
          [
            {
              box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
              confidence: 0.91,
              embedding: embedding1,
            },
            {
              box: { x: 0.5, y: 0.6, width: 0.1, height: 0.1 },
              confidence: 0.77,
              embedding: embedding2,
            },
          ],
          new Date("2026-03-15T12:00:00.000Z"),
        );

        const rows = await db.getFacesForFile("portraits/two.jpg");

        expect(rows).toHaveLength(2);
        expect(rows[0]?.box).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
        expect(rows[0]?.confidence).toBeCloseTo(0.91, 5);
        expect(rows[0]?.personId).toBeNull();
        expect(rows[0]?.detectedAt).toBe(new Date("2026-03-15T12:00:00.000Z").getTime());
        expect(rows[0]?.embedding).toBeInstanceOf(Float64Array);
        expect(rows[0]?.embedding.length).toBe(128);
        expect(Array.from(rows[0]!.embedding)).toEqual(Array.from(embedding1));
        expect(Array.from(rows[1]!.embedding)).toEqual(Array.from(embedding2));

        const record = await db.getFileRecord("portraits/two.jpg");
        expect(record?.facesProcessedAt).toBe("2026-03-15T12:00:00.000Z");
      });
    });

    it("stores an empty face list as scanned-no-faces", async () => {
      await withTempDb(async (db) => {
        await db.addFile(createRecord("empty.jpg"));
        await db.saveFaceDetectionResult(
          "empty.jpg",
          [],
          new Date("2026-04-01T00:00:00.000Z"),
        );

        const rows = await db.getFacesForFile("empty.jpg");
        expect(rows).toEqual([]);

        const record = await db.getFileRecord("empty.jpg");
        expect(record?.facesProcessedAt).toBe("2026-04-01T00:00:00.000Z");
      });
    });

    it("saves EXIF regions into face rows and keeps person ids stable by name", async () => {
      await withTempDb(async (db) => {
        await db.addFile(createRecord("metadata-faces.jpg"));

        await db.saveFacesFromMetadataRegions("metadata-faces.jpg", [
          {
            name: "Scott",
            area: { x: 0.2, y: 0.3, width: 0.1, height: 0.1 },
          },
          {
            name: "Scott",
            area: { x: 0.6, y: 0.4, width: 0.15, height: 0.15 },
          },
          {
            name: "Taylor",
            area: { x: 0.7, y: 0.7, width: 0.12, height: 0.12 },
          },
        ]);

        const rows = await db.getFacesForFile("metadata-faces.jpg");
        expect(rows).toHaveLength(3);
        expect(rows[0]?.embedding.length).toBe(0);
        expect(rows[0]?.personId).toBe(rows[1]?.personId);
        expect(rows[0]?.personId).not.toBe(rows[2]?.personId);
      });
    });

    it("replaces previously-saved face rows on re-scan", async () => {
      await withTempDb(async (db) => {
        await db.addFile(createRecord("rescan.jpg"));

        await db.saveFaceDetectionResult("rescan.jpg", [
          {
            box: { x: 0, y: 0, width: 0.1, height: 0.1 },
            confidence: 0.5,
            embedding: makeEmbedding(10),
          },
        ]);
        expect(await db.getFacesForFile("rescan.jpg")).toHaveLength(1);

        await db.saveFaceDetectionResult("rescan.jpg", [
          {
            box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
            confidence: 0.8,
            embedding: makeEmbedding(20),
          },
          {
            box: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
            confidence: 0.9,
            embedding: makeEmbedding(30),
          },
        ]);

        const rows = await db.getFacesForFile("rescan.jpg");
        expect(rows).toHaveLength(2);
        expect(rows[0]?.confidence).toBeCloseTo(0.8, 5);
        expect(rows[1]?.confidence).toBeCloseTo(0.9, 5);
      });
    });

    it("reports missingFaceDetection in status counts and clears it after save", async () => {
      await withTempDb(async (db) => {
        await db.addFile(createRecord("a.jpg"));
        await db.addFile(createRecord("b.jpg"));

        const before = await db.getStatusCounts();
        expect(before.imageEntries).toBe(2);
        expect(before.missingFaceDetection).toBe(2);

        await db.saveFaceDetectionResult("a.jpg", []);

        const after = await db.getStatusCounts();
        expect(after.missingFaceDetection).toBe(1);
      });
    });
  });
});
