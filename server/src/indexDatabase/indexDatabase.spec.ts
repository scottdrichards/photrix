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
    // init() resolves before the off-critical-path startup maintenance (one-time
    // migrations, including the EXIF-description backfill that clears
    // exifProcessedAt). Let it settle on the empty DB first so its user_version
    // gates trip here; otherwise it races the test body and can wipe fields the
    // test just set (e.g. exifProcessedAt), flaking under a loaded full suite.
    await db.startupMaintenance;
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

  describe("updateUserMetadata", () => {
    it("sets and clears the star rating without touching other columns", async () => {
      await withTempDb(async (db) => {
        await db.addFile(
          createRecord("photo.jpg", {
            exifProcessedAt: new Date(),
            cameraMake: "Canon",
          }),
        );

        expect(await db.updateUserMetadata("photo.jpg", { rating: 4 })).toBe(true);
        let record = await db.getFileRecord("photo.jpg");
        expect(record?.rating).toBe(4);
        // Unrelated EXIF columns are preserved.
        expect(record?.cameraMake).toBe("Canon");

        // 0 clears the rating back to unrated (NULL).
        await db.updateUserMetadata("photo.jpg", { rating: 0 });
        record = await db.getFileRecord("photo.jpg");
        expect(record?.rating ?? null).toBeNull();
      });
    });

    it("clamps ratings to 1–5 and dedupes/persists tags as JSON", async () => {
      await withTempDb(async (db) => {
        await db.addFile(createRecord("tagged.jpg", { exifProcessedAt: new Date() }));

        await db.updateUserMetadata("tagged.jpg", { rating: 9 });
        expect((await db.getFileRecord("tagged.jpg"))?.rating).toBe(5);

        await db.updateUserMetadata("tagged.jpg", {
          tags: ["beach", " sunset ", "beach", ""],
        });
        const record = await db.getFileRecord("tagged.jpg");
        expect(record?.tags).toEqual(["beach", "sunset"]);
      });
    });

    it("sets, trims, and clears the description without touching other columns", async () => {
      await withTempDb(async (db) => {
        await db.addFile(
          createRecord("captioned.jpg", {
            exifProcessedAt: new Date(),
            description: "From EXIF",
            cameraMake: "Canon",
          }),
        );

        await db.updateUserMetadata("captioned.jpg", {
          description: "  My own caption  ",
        });
        let record = await db.getFileRecord("captioned.jpg");
        expect(record?.description).toBe("My own caption");
        expect(record?.cameraMake).toBe("Canon");

        // Empty/whitespace-only clears back to NULL, same convention as rating.
        await db.updateUserMetadata("captioned.jpg", { description: "   " });
        record = await db.getFileRecord("captioned.jpg");
        expect(record?.description ?? null).toBeNull();

        await db.updateUserMetadata("captioned.jpg", { description: null });
        record = await db.getFileRecord("captioned.jpg");
        expect(record?.description ?? null).toBeNull();
      });
    });

    it("returns false for a missing file", async () => {
      await withTempDb(async (db) => {
        await expect(db.updateUserMetadata("missing.jpg", { rating: 3 })).resolves.toBe(
          false,
        );
      });
    });

    it("marks edited rows dirty for writeback and can list/clear them", async () => {
      await withTempDb(async (db) => {
        await db.addFile(createRecord("a.jpg", { exifProcessedAt: new Date() }));
        await db.addFile(createRecord("b.jpg", { exifProcessedAt: new Date() }));

        // Only edited rows appear in the writeback queue.
        await db.updateUserMetadata("a.jpg", { rating: 5, tags: ["keeper"] });

        let pending = await db.getFilesPendingMetadataWriteback();
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          path: "/a.jpg",
          rating: 5,
          tags: ["keeper"],
        });
        expect(typeof pending[0].dirtyAt).toBe("number");

        // Clearing the marker removes it from the queue without losing the edits.
        expect(await db.clearMetadataWriteback("a.jpg")).toBe(true);
        pending = await db.getFilesPendingMetadataWriteback();
        expect(pending).toHaveLength(0);
        const record = await db.getFileRecord("a.jpg");
        expect(record?.rating).toBe(5);
        expect(record?.tags).toEqual(["keeper"]);
      });
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

  it("returns false when moving a missing file", async () => {
    await withTempDb(async (db) => {
      await expect(db.moveFile("missing.jpg", "new/missing.jpg")).resolves.toBe(false);
    });
  });

  it("clears processed markers and derived faces on markFileForResync", async () => {
    await withTempDb(async (db) => {
      await db.addOrUpdateFileData("edited.jpg", {
        sizeInBytes: 1234,
        dateTaken: new Date("2026-07-01T00:00:00Z"),
        infoProcessedAt: new Date().toISOString(),
        exifProcessedAt: new Date().toISOString(),
        facesProcessedAt: new Date().toISOString(),
        embeddingProcessedAt: new Date().toISOString(),
      });
      await db.saveFaceDetectionResult("edited.jpg", [
        {
          box: { x: 0, y: 0, width: 10, height: 10 },
          confidence: 0.9,
          embedding: new Float64Array([0.1, 0.2, 0.3]),
        },
      ]);

      await expect(db.markFileForResync("edited.jpg")).resolves.toBe(true);

      const record = await db.getFileRecord("edited.jpg");
      // Processing markers reset so the pipeline reprocesses from scratch.
      expect(record?.infoProcessedAt ?? null).toBeNull();
      expect(record?.exifProcessedAt ?? null).toBeNull();
      expect(record?.facesProcessedAt ?? null).toBeNull();
      expect(record?.embeddingProcessedAt ?? null).toBeNull();
      // Value columns are left in place until reprocessing overwrites them.
      expect(record?.dateTaken).toBeDefined();
      // Old face detections are dropped.
      const faces = await db.getFacesForFile("edited.jpg");
      expect(faces).toHaveLength(0);
    });
  });

  it("returns false when marking a missing file for resync", async () => {
    await withTempDb(async (db) => {
      await expect(db.markFileForResync("missing.jpg")).resolves.toBe(false);
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

  it("sorts oldest-first when sort is date ascending, keeping undated items last", async () => {
    await withTempDb(async (db) => {
      const exifAt = "2026-01-01T00:00:00.000Z";
      await db.addFile(
        createRecord("middle.jpg", {
          exifProcessedAt: exifAt,
          dateTaken: new Date("2023-06-15T00:00:00.000Z"),
        }),
      );
      await db.addFile(
        createRecord("oldest.jpg", {
          exifProcessedAt: exifAt,
          dateTaken: new Date("2022-01-01T00:00:00.000Z"),
        }),
      );
      await db.addFile(
        createRecord("newest.jpg", {
          exifProcessedAt: exifAt,
          dateTaken: new Date("2024-12-31T00:00:00.000Z"),
        }),
      );
      await db.addFile(createRecord("undated.jpg", { exifProcessedAt: exifAt }));

      const result = await db.queryFiles({
        filter: {},
        metadata: ["dateTaken"],
        pageSize: 10,
        page: 1,
        sort: { field: "date", direction: "asc" },
      });

      expect(result.items.map((i) => i.fileName)).toEqual([
        "oldest.jpg",
        "middle.jpg",
        "newest.jpg",
        "undated.jpg",
      ]);
    });
  });

  it("sorts by rating with unrated files always last, in both directions", async () => {
    await withTempDb(async (db) => {
      const exifAt = "2026-01-01T00:00:00.000Z";
      await db.addFile(createRecord("five.jpg", { exifProcessedAt: exifAt, rating: 5 }));
      await db.addFile(createRecord("three.jpg", { exifProcessedAt: exifAt, rating: 3 }));
      await db.addFile(createRecord("one.jpg", { exifProcessedAt: exifAt, rating: 1 }));
      await db.addFile(createRecord("unrated.jpg", { exifProcessedAt: exifAt }));

      const desc = await db.queryFiles({
        filter: {},
        metadata: ["rating"],
        pageSize: 10,
        page: 1,
        sort: { field: "rating", direction: "desc" },
      });
      expect(desc.items.map((i) => i.fileName)).toEqual([
        "five.jpg",
        "three.jpg",
        "one.jpg",
        "unrated.jpg",
      ]);

      const asc = await db.queryFiles({
        filter: {},
        metadata: ["rating"],
        pageSize: 10,
        page: 1,
        sort: { field: "rating", direction: "asc" },
      });
      expect(asc.items.map((i) => i.fileName)).toEqual([
        "one.jpg",
        "three.jpg",
        "five.jpg",
        "unrated.jpg",
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

  it("returns immediate child folders with counts scoped to the filter", async () => {
    await withTempDb(async (db) => {
      const exifProcessedAt = "2026-01-01T00:00:00.000Z";
      await db.addFile(
        createRecord("trips/a.jpg", {
          rating: 5,
          mimeType: "image/jpeg",
          exifProcessedAt,
        }),
      );
      await db.addFile(
        createRecord("trips/2024/b.mp4", {
          rating: 5,
          mimeType: "video/mp4",
          exifProcessedAt,
        }),
      );
      await db.addFile(
        createRecord("family/c.mp4", {
          rating: 3,
          mimeType: "video/mp4",
          exifProcessedAt,
        }),
      );
      await db.addFile(
        createRecord("family/2020/d.mp4", {
          rating: 5,
          mimeType: "video/mp4",
          exifProcessedAt,
        }),
      );

      await expect(db.getFolders("/", {})).resolves.toEqual([
        { name: "family", count: 2 },
        { name: "trips", count: 2 },
      ]);

      await expect(
        db.getFolders("/", {
          rating: { min: 4 },
        }),
      ).resolves.toEqual([
        { name: "family", count: 1 },
        { name: "trips", count: 2 },
      ]);

      await expect(db.getFolders("/family/", { rating: { min: 5 } })).resolves.toEqual([
        { name: "2020", count: 1 },
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
        expect(rows[0]?.box).toEqual({ x: 0.25, y: 0.4, width: 0.3, height: 0.4 });
        expect(rows[1]?.box).toEqual({ x: 0.55, y: 0.65, width: 0.1, height: 0.1 });
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
        expect(rows[0]?.box).toEqual({ x: 0.2, y: 0.3, width: 0.1, height: 0.1 });
        expect(rows[1]?.box).toEqual({ x: 0.6, y: 0.4, width: 0.15, height: 0.15 });
        expect(rows[2]?.box).toEqual({ x: 0.7, y: 0.7, width: 0.12, height: 0.12 });
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

    it("computes photoQualityScore from detected faces' attributes, worst face wins", async () => {
      await withTempDb(async (db) => {
        await db.addFile(createRecord("quality/group.jpg"));

        await db.saveFaceDetectionResult("quality/group.jpg", [
          {
            box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
            confidence: 0.9,
            embedding: new Float64Array(128),
            attributes: { smile: 1, eyesOpen: 1, focus: 1, exposure: 1 },
          },
          {
            // The one blinking/blurry face in the group should set the
            // photo's score, not be averaged away by the good face above.
            box: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 },
            confidence: 0.9,
            embedding: new Float64Array(128),
            attributes: { smile: 0.2, eyesOpen: 0.1, focus: 0.1, exposure: 0.1 },
          },
        ]);

        const record = await db.getFileRecord("quality/group.jpg");
        expect(record?.photoQualityScore).toBeCloseTo(0.125, 5);
      });
    });

    it("leaves photoQualityScore null when no face has been scored", async () => {
      await withTempDb(async (db) => {
        await db.addFile(createRecord("quality/unscored.jpg"));

        await db.saveFaceDetectionResult("quality/unscored.jpg", [
          {
            box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
            confidence: 0.9,
            embedding: new Float64Array(128),
            // No `attributes` at all — detection ran without the attribute pass.
          },
        ]);

        const record = await db.getFileRecord("quality/unscored.jpg");
        expect(record?.photoQualityScore).toBeUndefined();
      });
    });

    it("resets photoQualityScore to null when a re-scan replaces scored faces with unscored ones", async () => {
      await withTempDb(async (db) => {
        await db.addFile(createRecord("quality/rescan.jpg"));

        await db.saveFaceDetectionResult("quality/rescan.jpg", [
          {
            box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
            confidence: 0.9,
            embedding: new Float64Array(128),
            attributes: { smile: 0.9, eyesOpen: 0.9, focus: 0.9, exposure: 0.9 },
          },
        ]);
        expect(
          (await db.getFileRecord("quality/rescan.jpg"))?.photoQualityScore,
        ).toBeCloseTo(0.9, 5);

        // A re-scan without attributes replaces the old (scored) face with a
        // fresh unscored one — the stale score must not survive it.
        await db.saveFaceDetectionResult("quality/rescan.jpg", [
          {
            box: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 },
            confidence: 0.9,
            embedding: new Float64Array(128),
          },
        ]);
        expect(
          (await db.getFileRecord("quality/rescan.jpg"))?.photoQualityScore,
        ).toBeUndefined();
      });
    });

    it("recomputes photoQualityScore via the attribute backfill path (saveFaceAttributes)", async () => {
      await withTempDb(async (db) => {
        await db.addFile(createRecord("quality/backfill.jpg"));

        // Simulates a face detected before the attribute feature existed:
        // no attributes yet, so no quality signal.
        await db.saveFaceDetectionResult("quality/backfill.jpg", [
          {
            box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
            confidence: 0.9,
            embedding: new Float64Array(128),
          },
        ]);
        expect(
          (await db.getFileRecord("quality/backfill.jpg"))?.photoQualityScore,
        ).toBeUndefined();

        const faces = await db.getFaceBoxesForAttributes("quality/backfill.jpg");
        expect(faces).toHaveLength(1);

        await db.saveFaceAttributes([
          {
            id: faces[0]!.id,
            attributes: { smile: 0.4, eyesOpen: 0.6, focus: 0.8, exposure: 0.6 },
          },
        ]);

        const record = await db.getFileRecord("quality/backfill.jpg");
        expect(record?.photoQualityScore).toBeCloseTo(0.6, 5);
      });
    });

    it("sorts by quality with unscored files always last, in both directions", async () => {
      await withTempDb(async (db) => {
        const withScore = async (name: string, score: number) => {
          await db.addFile(createRecord(name));
          await db.saveFaceDetectionResult(name, [
            {
              box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
              confidence: 0.9,
              embedding: new Float64Array(128),
              attributes: {
                smile: score,
                eyesOpen: score,
                focus: score,
                exposure: score,
              },
            },
          ]);
        };

        await withScore("quality/high.jpg", 0.9);
        await withScore("quality/mid.jpg", 0.5);
        await withScore("quality/low.jpg", 0.1);
        await db.addFile(createRecord("quality/none.jpg"));

        const desc = await db.queryFiles({
          filter: {},
          metadata: ["photoQualityScore"],
          pageSize: 10,
          page: 1,
          sort: { field: "quality", direction: "desc" },
        });
        expect(desc.items.map((i) => i.fileName)).toEqual([
          "high.jpg",
          "mid.jpg",
          "low.jpg",
          "none.jpg",
        ]);

        const asc = await db.queryFiles({
          filter: {},
          metadata: ["photoQualityScore"],
          pageSize: 10,
          page: 1,
          sort: { field: "quality", direction: "asc" },
        });
        expect(asc.items.map((i) => i.fileName)).toEqual([
          "low.jpg",
          "mid.jpg",
          "high.jpg",
          "none.jpg",
        ]);
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

    it("clusters face vectors and picks a center-like representative", async () => {
      await withTempDb(async (db) => {
        const unit = (values: number[]) => {
          const arr = new Float64Array(128);
          values.forEach((value, index) => {
            arr[index] = value;
          });
          return arr;
        };

        await db.addFile(createRecord("people/a-1.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("people/a-2.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("people/a-3.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("people/b-1.jpg", { dimensionsWidth: 2000 }));

        await db.saveFaceDetectionResult("people/a-1.jpg", [
          {
            box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            confidence: 0.9,
            embedding: unit([1, 0, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/a-2.jpg", [
          {
            box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
            confidence: 0.9,
            embedding: unit([0.98, 0.05, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/a-3.jpg", [
          {
            box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
            confidence: 0.9,
            embedding: unit([0.97, 0.06, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/b-1.jpg", [
          {
            box: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
            confidence: 0.9,
            embedding: unit([0, 1, 0]),
          },
        ]);

        // Test queryFaceClusters returns summaries without faces.
        // Clusters with fewer than MIN_FACE_CLUSTER_SIZE (2) faces are excluded,
        // so the b-cluster (1 face) is filtered out.
        const result = await db.queryFaceClusters({ filter: {} });

        expect(result.totalFaces).toBe(3);
        expect(result.totalClusters).toBe(1);
        expect(result.clusters[0]?.count).toBe(3);
        expect(result.clusters[0]?.representative.path).toBe("/people/a-1.jpg");
        // Summaries should not have faces
        expect(result.clusters[0]?.faces).toBeUndefined();

        // Test getFaceClusterDetail returns full cluster with faces
        const detailResult = await db.getFaceClusterDetail({
          filter: {},
          clusterId: result.clusters[0]!.id,
        });

        expect(detailResult.cluster).not.toBeNull();
        expect(detailResult.cluster?.faces).toHaveLength(3);
        expect(detailResult.cluster?.id).toBe(result.clusters[0]!.id);
      });
    });

    it("keeps low-confidence detections out of clusters (garbage-cluster gate)", async () => {
      await withTempDb(async (db) => {
        const unit = (values: number[]) => {
          const arr = new Float64Array(128);
          const magnitude = Math.hypot(...values) || 1;
          values.forEach((value, index) => {
            arr[index] = value / magnitude;
          });
          return arr;
        };

        // Three detections with an identical embedding: without the gate they
        // would all land in one cluster (count 3). The third is below the
        // confidence floor, so it must be excluded — leaving a cluster of 2.
        const embedding = unit([1, 0, 0]);
        await db.addFile(createRecord("gate/a-1.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("gate/a-2.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("gate/low.jpg", { dimensionsWidth: 2000 }));

        await db.saveFaceDetectionResult("gate/a-1.jpg", [
          { box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: 0.9, embedding },
        ]);
        await db.saveFaceDetectionResult("gate/a-2.jpg", [
          { box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }, confidence: 0.9, embedding },
        ]);
        await db.saveFaceDetectionResult("gate/low.jpg", [
          { box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, confidence: 0.5, embedding },
        ]);

        const result = await db.queryFaceClusters({ filter: {} });
        expect(result.totalClusters).toBe(1);
        expect(result.clusters[0]?.count).toBe(2);

        // The low-confidence face is excluded from clustering, not deleted.
        expect(await db.getFacesForFile("gate/low.jpg")).toHaveLength(1);
      });
    });

    it("refreshes drifted clusters so the representative tracks the centroid, not the seed", async () => {
      await withTempDb(async (db) => {
        const unit = (values: number[]) => {
          const arr = new Float64Array(128);
          const magnitude = Math.hypot(...values) || 1;
          values.forEach((value, index) => {
            arr[index] = value / magnitude;
          });
          return arr;
        };

        // Seed the cluster at angle 0, then fold in nine faces at 45°. Each new
        // face stays within the 0.62 threshold of the running mean, so they all
        // join one cluster while dragging the centroid off the seed toward 45°.
        const seedVec = unit([1, 0]);
        const nearVec = unit([1, 1]);

        await db.addFile(createRecord("drift/seed.jpg", { dimensionsWidth: 2000 }));
        await db.saveFaceDetectionResult("drift/seed.jpg", [
          {
            box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            confidence: 0.9,
            embedding: seedVec,
          },
        ]);
        for (let i = 0; i < 9; i += 1) {
          const path = `drift/near-${i}.jpg`;
          await db.addFile(createRecord(path, { dimensionsWidth: 2000 }));
          await db.saveFaceDetectionResult(path, [
            {
              box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
              confidence: 0.9,
              embedding: nearVec,
            },
          ]);
        }

        // Before refresh: the seed's stored similarity is a trivial 1.0 (it was
        // scored against its own centroid), so it wins as representative even
        // though the centroid has moved onto the near faces.
        const before = await db.queryFaceClusters({ filter: {} });
        expect(before.clusters).toHaveLength(1);
        expect(before.clusters[0]?.count).toBe(10);
        expect(before.clusters[0]?.representative.path).toBe("/drift/seed.jpg");

        const refreshed = await db.refreshStaleClusterSimilarities();
        expect(refreshed).toBe(1);

        // After refresh: rescored against the current centroid, a near face
        // (cosine ~1.0) outranks the seed (cosine ~0.71).
        const after = await db.queryFaceClusters({ filter: {} });
        expect(after.clusters[0]?.count).toBe(10);
        expect(after.clusters[0]?.representative.path).not.toBe("/drift/seed.jpg");
        expect(after.clusters[0]?.representative.path).toMatch(/^\/drift\/near-\d\.jpg$/);

        // A second refresh with no further growth is a no-op.
        await expect(db.refreshStaleClusterSimilarities()).resolves.toBe(0);
      });
    });

    it("rescores a merged sub-cluster's seed against the person centroid so it stops dominating", async () => {
      await withTempDb(async (db) => {
        const unit = (values: number[]) => {
          const arr = new Float64Array(128);
          const magnitude = Math.hypot(...values) || 1;
          values.forEach((value, index) => {
            arr[index] = value / magnitude;
          });
          return arr;
        };

        // Build a drifted main cluster: a seed at 0° plus nine faces at 45°,
        // then refresh so its representative is a near face (~0.997) rather than
        // the seed. Every stored similarity is now strictly below 1.0.
        const seedVec = unit([1, 0, 0]);
        const nearVec = unit([1, 1, 0]);
        await db.addFile(createRecord("main/seed.jpg", { dimensionsWidth: 2000 }));
        await db.saveFaceDetectionResult("main/seed.jpg", [
          { box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: 0.9, embedding: seedVec },
        ]);
        for (let i = 0; i < 9; i += 1) {
          const path = `main/near-${i}.jpg`;
          await db.addFile(createRecord(path, { dimensionsWidth: 2000 }));
          await db.saveFaceDetectionResult(path, [
            { box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }, confidence: 0.9, embedding: nearVec },
          ]);
        }
        await expect(db.refreshStaleClusterSimilarities()).resolves.toBe(1);

        // A tiny sub-cluster on an orthogonal axis: it never joins main (so it
        // stays separate), and its seed keeps the artificial clusterSimilarity of
        // 1.0. Two faces so it clears the single-face hidden-cluster floor.
        await db.addFile(createRecord("bg/seed.jpg", { dimensionsWidth: 2000 }));
        await db.saveFaceDetectionResult("bg/seed.jpg", [
          { box: { x: 0.5, y: 0.5, width: 0.03, height: 0.03 }, confidence: 0.9, embedding: unit([0, 0, 1]) },
        ]);
        await db.addFile(createRecord("bg/second.jpg", { dimensionsWidth: 2000 }));
        await db.saveFaceDetectionResult("bg/second.jpg", [
          { box: { x: 0.5, y: 0.5, width: 0.03, height: 0.03 }, confidence: 0.9, embedding: unit([0, 0.02, 1]) },
        ]);

        const before = await db.queryFaceClusters({ filter: {} });
        const main = before.clusters.find((c) => c.representative.path.startsWith("/main/"));
        const bg = before.clusters.find((c) => c.representative.path.startsWith("/bg/"));
        expect(main).toBeDefined();
        expect(bg).toBeDefined();

        await expect(db.mergeClusters(bg!.id, main!.id)).resolves.toBe(true);

        // The bg seed's 1.0 (scored against its own centroid) would otherwise
        // outrank main's best (~0.997) and become the person's representative and
        // first detail face. After rescore-on-merge the bg faces are scored
        // against main's centroid (~0) and drop to the back.
        const detail = await db.getFaceClusterDetail({ filter: {}, clusterId: main!.id });
        expect(detail.cluster?.representative.path).toMatch(/^\/main\/near-\d\.jpg$/);
        expect(detail.cluster?.faces[0]?.path).toMatch(/^\/main\//);
        const paths = detail.cluster?.faces.map((f) => f.path) ?? [];
        expect(paths).toEqual(expect.arrayContaining(["/bg/seed.jpg", "/bg/second.jpg"]));
        // Both bg faces rank behind every main face.
        expect(paths.slice(-2).every((p) => p.startsWith("/bg/"))).toBe(true);
      });
    });

    it("stores person names on the face cluster record and returns them in people queries", async () => {
      await withTempDb(async (db) => {
        const unit = (values: number[]) => {
          const arr = new Float64Array(128);
          values.forEach((value, index) => {
            arr[index] = value;
          });
          return arr;
        };

        await db.addFile(createRecord("people/named-1.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("people/named-2.jpg", { dimensionsWidth: 2000 }));

        await db.saveFaceDetectionResult("people/named-1.jpg", [
          {
            box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            confidence: 0.9,
            embedding: unit([1, 0, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/named-2.jpg", [
          {
            box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
            confidence: 0.9,
            embedding: unit([0.99, 0.01, 0]),
          },
        ]);

        const initial = await db.queryFaceClusters({ filter: {} });
        const clusterId = initial.clusters[0]?.id;

        expect(clusterId).toBeDefined();
        await expect(db.renameCluster(clusterId!, "Taylor")).resolves.toBe(true);

        const renamed = await db.queryFaceClusters({ filter: {} });
        expect(renamed.clusters[0]?.name).toBe("Taylor");

        const detail = await db.getFaceClusterDetail({
          filter: {},
          clusterId: clusterId!,
        });
        expect(detail.cluster?.name).toBe("Taylor");

        await expect(db.renameCluster(clusterId!, null)).resolves.toBe(true);
        const cleared = await db.getFaceClusterDetail({
          filter: {},
          clusterId: clusterId!,
        });
        expect(cleared.cluster?.name).toBeNull();
      });
    });

    it("returns per-file faces with resolved person id and name for the overlay", async () => {
      await withTempDb(async (db) => {
        const unit = (values: number[]) => {
          const arr = new Float64Array(128);
          values.forEach((value, index) => {
            arr[index] = value;
          });
          return arr;
        };

        await db.addFile(createRecord("people/overlay-1.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("people/overlay-2.jpg", { dimensionsWidth: 2000 }));

        await db.saveFaceDetectionResult("people/overlay-1.jpg", [
          {
            box: { x: 0.25, y: 0.35, width: 0.2, height: 0.2 },
            confidence: 0.9,
            embedding: unit([1, 0, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/overlay-2.jpg", [
          {
            box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
            confidence: 0.9,
            embedding: unit([0.99, 0.01, 0]),
          },
        ]);

        const clusters = await db.queryFaceClusters({ filter: {} });
        const clusterId = clusters.clusters[0]?.id;
        expect(clusterId).toBeDefined();
        await db.renameCluster(clusterId!, "Riley");

        const faces = await db.getPeopleFacesForFile("people/overlay-1.jpg");
        expect(faces).toHaveLength(1);
        // Boxes are stored as normalized centre coordinates (x + width/2), matching
        // getFacesForFile and the client's faceTableBoxes handling.
        expect(faces[0]?.box.x).toBeCloseTo(0.35, 5);
        expect(faces[0]?.box.y).toBeCloseTo(0.45, 5);
        expect(faces[0]?.box.width).toBeCloseTo(0.2, 5);
        expect(faces[0]?.box.height).toBeCloseTo(0.2, 5);
        expect(faces[0]?.personId).toBe(clusterId);
        expect(faces[0]?.name).toBe("Riley");

        // Files with no detected faces yield an empty list, not an error.
        await db.addFile(createRecord("people/no-faces.jpg", { dimensionsWidth: 2000 }));
        expect(await db.getPeopleFacesForFile("people/no-faces.jpg")).toEqual([]);
      });
    });

    it("returns person centroids and only unadopted merge suggestions in cluster detail", async () => {
      await withTempDb(async (db) => {
        const unit = (values: number[]) => {
          const arr = new Float64Array(128);
          values.forEach((value, index) => {
            arr[index] = value;
          });
          return arr;
        };

        await db.addFile(createRecord("people/alex-1.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("people/alex-2.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("people/jordan-1.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("people/jordan-2.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(
          createRecord("people/casey-1.jpg", {
            dimensionsWidth: 2000,
            exifProcessedAt: "2026-01-01T00:00:00.000Z",
            dateTaken: new Date("1998-06-01T00:00:00.000Z"),
          }),
        );
        await db.addFile(
          createRecord("people/casey-2.jpg", {
            dimensionsWidth: 2000,
            exifProcessedAt: "2026-01-01T00:00:00.000Z",
            dateTaken: new Date("2001-08-15T00:00:00.000Z"),
          }),
        );
        await db.addFile(createRecord("people/taylor-1.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("people/taylor-2.jpg", { dimensionsWidth: 2000 }));

        await db.saveFaceDetectionResult("people/alex-1.jpg", [
          {
            box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            confidence: 0.99,
            embedding: unit([1, 0, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/alex-2.jpg", [
          {
            box: { x: 0.12, y: 0.1, width: 0.2, height: 0.2 },
            confidence: 0.99,
            embedding: unit([0.99, 0.01, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/jordan-1.jpg", [
          {
            box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
            confidence: 0.99,
            embedding: unit([0, 1, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/jordan-2.jpg", [
          {
            box: { x: 0.22, y: 0.2, width: 0.2, height: 0.2 },
            confidence: 0.99,
            embedding: unit([0.01, 0.99, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/casey-1.jpg", [
          {
            box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
            confidence: 0.99,
            embedding: unit([0.55, 0.4, 0.73]),
          },
        ]);
        await db.saveFaceDetectionResult("people/casey-2.jpg", [
          {
            box: { x: 0.32, y: 0.3, width: 0.2, height: 0.2 },
            confidence: 0.99,
            embedding: unit([0.57, 0.38, 0.72]),
          },
        ]);
        await db.saveFaceDetectionResult("people/taylor-1.jpg", [
          {
            box: { x: 0.38, y: 0.34, width: 0.2, height: 0.2 },
            confidence: 0.99,
            embedding: unit([-1, 0, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/taylor-2.jpg", [
          {
            box: { x: 0.4, y: 0.34, width: 0.2, height: 0.2 },
            confidence: 0.99,
            embedding: unit([-0.99, 0.01, 0]),
          },
        ]);

        const initial = await db.queryFaceClusters({ filter: {} });

        const alex = initial.clusters.find((cluster) =>
          cluster.representative.path.includes("/people/alex-"),
        );
        const jordan = initial.clusters.find((cluster) =>
          cluster.representative.path.includes("/people/jordan-"),
        );
        const casey = initial.clusters.find((cluster) =>
          cluster.representative.path.includes("/people/casey-"),
        );

        expect(alex).toBeDefined();
        expect(jordan).toBeDefined();
        expect(casey).toBeDefined();

        const taylor = initial.clusters.find((cluster) =>
          cluster.representative.path.includes("/people/taylor-"),
        );

        expect(taylor).toBeDefined();

        await expect(
          db.renameCluster(jordan!.id, "Scott Douglas Richards"),
        ).resolves.toBe(true);
        await expect(db.renameCluster(taylor!.id, "Taylor")).resolves.toBe(true);
        await expect(db.mergeClusters(jordan!.id, alex!.id)).resolves.toBe(true);

        const detail = await db.getFaceClusterDetail({
          filter: {},
          clusterId: alex!.id,
        });

        expect(detail.cluster?.name).toBe("Scott Douglas Richards");
        expect(detail.cluster?.centroids).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: alex!.id, count: 2 }),
            expect.objectContaining({ id: jordan!.id, count: 2 }),
          ]),
        );
        expect(detail.cluster?.mergeSuggestions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: casey!.id,
              count: 2,
              name: null,
              yearRangeLabel: "1998-2001",
            }),
          ]),
        );
        expect(detail.cluster?.mergeSuggestions).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: taylor!.id })]),
        );
      });
    });

    it("separates a centroid back into an unadopted match group", async () => {
      await withTempDb(async (db) => {
        const unit = (values: number[]) => {
          const arr = new Float64Array(128);
          values.forEach((value, index) => {
            arr[index] = value;
          });
          return arr;
        };

        await db.addFile(createRecord("people/alex-1.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("people/alex-2.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("people/jordan-1.jpg", { dimensionsWidth: 2000 }));
        await db.addFile(createRecord("people/jordan-2.jpg", { dimensionsWidth: 2000 }));

        await db.saveFaceDetectionResult("people/alex-1.jpg", [
          {
            box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            confidence: 0.99,
            embedding: unit([1, 0, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/alex-2.jpg", [
          {
            box: { x: 0.12, y: 0.1, width: 0.2, height: 0.2 },
            confidence: 0.99,
            embedding: unit([0.99, 0.01, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/jordan-1.jpg", [
          {
            box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
            confidence: 0.99,
            embedding: unit([0, 1, 0]),
          },
        ]);
        await db.saveFaceDetectionResult("people/jordan-2.jpg", [
          {
            box: { x: 0.22, y: 0.2, width: 0.2, height: 0.2 },
            confidence: 0.99,
            embedding: unit([0.01, 0.99, 0]),
          },
        ]);

        const initial = await db.queryFaceClusters({ filter: {} });
        const alex = initial.clusters.find((cluster) =>
          cluster.representative.path.includes("/people/alex-"),
        );
        const jordan = initial.clusters.find((cluster) =>
          cluster.representative.path.includes("/people/jordan-"),
        );

        expect(alex).toBeDefined();
        expect(jordan).toBeDefined();

        await expect(db.renameCluster(alex!.id, "Alex")).resolves.toBe(true);
        await expect(db.mergeClusters(jordan!.id, alex!.id)).resolves.toBe(true);
        await expect(db.separateCluster(jordan!.id)).resolves.toBe(true);

        const alexDetail = await db.getFaceClusterDetail({
          filter: {},
          clusterId: alex!.id,
        });
        const jordanDetail = await db.getFaceClusterDetail({
          filter: {},
          clusterId: jordan!.id,
        });

        expect(alexDetail.cluster?.centroids).toEqual([
          expect.objectContaining({ id: alex!.id, count: 2 }),
        ]);
        expect(jordanDetail.cluster?.id).toBe(jordan!.id);
        expect(jordanDetail.cluster?.name).toBeNull();
        expect(jordanDetail.cluster?.centroids).toEqual([
          expect.objectContaining({ id: jordan!.id, count: 2 }),
        ]);
      });
    });
    it("filters the PCA overview to 100+ faces and recenters focused views on 10 neighbors", async () => {
      await withTempDb(async (db) => {
        const unit = (axis: number) => {
          const embedding = new Float64Array(128);
          embedding[axis] = 1;
          return embedding;
        };

        const addCluster = async (relativePath: string, axis: number, count: number) => {
          await db.addFile(
            createRecord(relativePath, {
              dimensionsWidth: 2000,
              dimensionsHeight: 1500,
            }),
          );
          await db.saveFaceDetectionResult(
            relativePath,
            Array.from({ length: count }, (_, index) => ({
              box: {
                x: 0.1 + (index % 5) * 0.01,
                y: 0.1 + (index % 4) * 0.01,
                width: 0.2,
                height: 0.2,
              },
              confidence: 0.99,
              embedding: unit(axis),
            })),
          );
        };

        await addCluster("people/focus.jpg", 0, 120);
        for (let i = 1; i <= 11; i++) {
          await addCluster(`people/neighbor-${i}.jpg`, i, 100);
        }
        await addCluster("people/excluded.jpg", 12, 99);

        const overview = await db.getFaceClustersPCA();

        expect(overview.points).toHaveLength(12);
        expect(overview.points.every((point) => point.count >= 100)).toBe(true);
        expect(overview.points.some((point) => point.focused)).toBe(false);

        const focusedClusterId = overview.points.find((point) => point.count === 120)?.id;
        expect(focusedClusterId).toBeDefined();

        const focused = await db.getFaceClustersPCA(focusedClusterId);
        expect(focused.points).toHaveLength(11);

        const centerPoint = focused.points.find((point) => point.id === focusedClusterId);
        expect(centerPoint).toBeDefined();
        expect(centerPoint?.focused).toBe(true);
        expect(centerPoint?.x).toBeCloseTo(0, 8);
        expect(centerPoint?.y).toBeCloseTo(0, 8);
        expect(centerPoint?.z).toBeCloseTo(0, 8);
      });
    });
  });

  describe("semanticSearch", () => {
    const addVideoWithTranscript = async (
      db: IndexDatabase,
      relativePath: string,
      transcript: string,
    ) => {
      await db.addFile(createRecord(relativePath, { mimeType: "video/mp4" }));
      await db.saveAudioTranscription(relativePath, [
        { start: 0, end: 1, text: transcript },
      ]);
    };

    it("matches transcript queries on whole words instead of raw substrings", async () => {
      await withTempDb(async (db) => {
        await addVideoWithTranscript(db, "cat.mp4", "the cat meows at dinner time");
        await addVideoWithTranscript(db, "vacation.mp4", "our family vacation montage");

        const results = await db.audioTranscriptSearch("cat", {}, 10);

        expect(results.map((r) => r.fileName)).toEqual(["cat.mp4"]);
      });
    });

    it("ranks exact transcript phrases above loose multi-word matches", async () => {
      await withTempDb(async (db) => {
        await addVideoWithTranscript(
          db,
          "exact.mp4",
          "happy birthday to you and many more",
        );
        await addVideoWithTranscript(
          db,
          "loose.mp4",
          "the birthday party made everyone happy",
        );

        const results = await db.audioTranscriptSearch("happy birthday", {}, 10);

        expect(results.map((r) => r.fileName)).toEqual(["exact.mp4", "loose.mp4"]);
        expect(results[0]?.similarity).toBeGreaterThan(results[1]?.similarity ?? 0);
      });
    });

    const addImageWithEmbedding = async (
      db: IndexDatabase,
      relativePath: string,
      embedding: number[],
    ) => {
      await db.addFile(createRecord(relativePath, { mimeType: "image/jpeg" }));
      await db.saveImageEmbedding(relativePath, Float32Array.from(embedding));
    };

    it("ranks images by cosine similarity to the query vector", async () => {
      await withTempDb(async (db) => {
        // Distinct unit-ish vectors so the ordering is unambiguous.
        await addImageWithEmbedding(db, "match.jpg", [1, 0, 0, 0]);
        await addImageWithEmbedding(db, "partial.jpg", [0.7071, 0.7071, 0, 0]);
        await addImageWithEmbedding(db, "orthogonal.jpg", [0, 1, 0, 0]);

        const results = await db.semanticSearch(Float32Array.from([1, 0, 0, 0]), {}, 10);

        expect(results.map((r) => r.fileName)).toEqual([
          "match.jpg",
          "partial.jpg",
          "orthogonal.jpg",
        ]);
        expect(results[0]?.similarity).toBeCloseTo(1, 5);
        expect(results[1]?.similarity).toBeCloseTo(0.7071, 3);
        expect(results[2]?.similarity).toBeCloseTo(0, 5);
      });
    });

    it("caps results at the requested limit", async () => {
      await withTempDb(async (db) => {
        await addImageWithEmbedding(db, "a.jpg", [1, 0, 0, 0]);
        await addImageWithEmbedding(db, "b.jpg", [0.9, 0.1, 0, 0]);
        await addImageWithEmbedding(db, "c.jpg", [0.8, 0.2, 0, 0]);

        const results = await db.semanticSearch(Float32Array.from([1, 0, 0, 0]), {}, 2);

        expect(results).toHaveLength(2);
        expect(results[0]?.fileName).toBe("a.jpg");
      });
    });

    it("ignores images without an embedding", async () => {
      await withTempDb(async (db) => {
        await addImageWithEmbedding(db, "embedded.jpg", [1, 0, 0, 0]);
        await db.addFile(createRecord("plain.jpg", { mimeType: "image/jpeg" }));

        const results = await db.semanticSearch(Float32Array.from([1, 0, 0, 0]), {}, 10);

        expect(results.map((r) => r.fileName)).toEqual(["embedded.jpg"]);
      });
    });
  });
});
