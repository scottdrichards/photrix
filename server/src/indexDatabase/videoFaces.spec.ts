import { describe, it, expect, jest } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexDatabase } from "./indexDatabase.ts";
import { splitPath } from "./utils/pathUtils.ts";
import { AnalysisStore } from "./analysisStore.ts";

const withTempDb = async (testFn: (db: IndexDatabase) => Promise<void>) => {
  const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-media-root-"));
  const dbRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-db-root-"));
  process.env.INDEX_DB_LOCATION = dbRoot;
  let db: IndexDatabase | undefined;
  try {
    db = new IndexDatabase(mediaRoot);
    await db.init();
    await db.startupMaintenance;
    await testFn(db);
  } finally {
    await db?.close();
    rmSync(mediaRoot, { recursive: true, force: true });
    rmSync(dbRoot, { recursive: true, force: true });
  }
};

const addVideo = async (
  db: IndexDatabase,
  relativePath: string,
  extra: { duration?: number; exif?: boolean; dateTaken?: Date } = {},
) => {
  const { folder, fileName } = splitPath(relativePath);
  await db.addFile({
    folder,
    fileName,
    mimeType: "video/mp4",
    ...(extra.duration !== undefined ? { duration: extra.duration } : {}),
    ...(extra.dateTaken ? { dateTaken: extra.dateTaken } : {}),
    ...(extra.exif === false ? {} : { exifProcessedAt: new Date() }),
  });
};

const unit = (seed: number): Float64Array => {
  const v = new Float64Array(64);
  v[0] = 1;
  v[1] = seed * 0.001;
  return v;
};

describe("video face queue", () => {
  it("queues videos with EXIF, newest first, and carries their duration", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "v/old.mp4", {
        duration: 12,
        dateTaken: new Date("2020-01-01"),
      });
      await addVideo(db, "v/new.mp4", {
        duration: 30,
        dateTaken: new Date("2024-01-01"),
      });
      await addVideo(db, "v/no-exif.mp4", { exif: false });

      const queued = await db.analysis.getVideosNeedingFaceAnalysis();
      expect(queued).toHaveLength(2);
      expect(queued[0]).toMatchObject({
        relativePath: "/v/new.mp4",
        durationSeconds: 30,
        takenAt: new Date("2024-01-01").getTime(),
        failedBefore: false,
      });
      expect(queued[1]).toMatchObject({
        relativePath: "/v/old.mp4",
        durationSeconds: 12,
      });
    });
  });

  it("skips the movie half of a Live Photo, whose still already has the faces", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "lp/IMG_1.MOV");
      await addVideo(db, "lp/solo.mp4");
      await db.addFile({
        folder: "/lp/",
        fileName: "IMG_1.HEIC",
        mimeType: "image/heic",
        livePhotoVideoFileName: "IMG_1.MOV",
        // The pairing is an EXIF-pass column; it is only written alongside this.
        exifProcessedAt: new Date(),
      });

      const queued = (await db.analysis.getVideosNeedingFaceAnalysis()).map((v) => v.relativePath);
      expect(queued).toEqual(["/lp/solo.mp4"]);
      const progress = await db.analysis.getVideoFaceAnalysisProgress();
      expect(progress).toEqual({
        total: 2,
        done: 0,
        remaining: 1,
        coolingDown: 0,
        nextRetryAt: null,
        unreadable: 0,
      });
    });
  });

  it("holds a failed video back for the whole cooldown instead of retrying it", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "v/bad.mp4");
      await db.analysis.saveVideoFaceAnalysisError("v/bad.mp4");

      expect(await db.analysis.getVideosNeedingFaceAnalysis()).toEqual([]);
      // Back after the cooldown, and marked so it goes behind fresh work.
      const later = jest
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + AnalysisStore.VIDEO_FACE_RETRY_COOLDOWN_MS + 1);
      expect(await db.analysis.getVideosNeedingFaceAnalysis()).toMatchObject([
        { relativePath: "/v/bad.mp4", failedBefore: true },
      ]);
      later.mockRestore();
      // Still owed, so progress doesn't claim it is done, and says why and
      // when it comes back (feedback #158).
      const progress = await db.analysis.getVideoFaceAnalysisProgress();
      expect(progress).toMatchObject({ done: 0, remaining: 1, coolingDown: 1 });
      expect(progress.nextRetryAt).toBeGreaterThan(Date.now());
      expect(progress.nextRetryAt).toBeLessThanOrEqual(
        Date.now() + AnalysisStore.VIDEO_FACE_RETRY_COOLDOWN_MS,
      );
      // Not this run's work, so the ETA doesn't price it.
      expect(await db.analysis.getVideoFaceQueueCostInputs()).toEqual([]);
    });
  });

  it("drops a video whose frames can't be decoded from the queue for good", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "v/corrupt.mp4");
      await db.analysis.saveImageAnalysisDecodeError("v/corrupt.mp4");
      expect(await db.analysis.getVideosNeedingFaceAnalysis()).toEqual([]);
      expect(await db.analysis.getVideoFaceAnalysisProgress()).toMatchObject({
        remaining: 0,
        unreadable: 1,
      });
    });
  });

  it("hands the queue's sizes and resolutions to the ETA", async () => {
    await withTempDb(async (db) => {
      await db.addFile({
        folder: "/v/",
        fileName: "4k.mp4",
        mimeType: "video/mp4",
        duration: 40,
        sizeInBytes: 300e6,
        infoProcessedAt: new Date(),
        dimensionWidth: 3840,
        dimensionHeight: 2160,
        exifProcessedAt: new Date(),
      });
      expect(await db.analysis.getVideoFaceQueueCostInputs()).toEqual([
        { durationSeconds: 40, sizeBytes: 300e6, width: 3840, height: 2160 },
      ]);
      expect((await db.analysis.getVideosNeedingFaceAnalysis())[0]).toMatchObject({
        relativePath: "/v/4k.mp4",
        sizeBytes: 300e6,
      });
    });
  });

  it("stores when each person is on screen, and hands it to whoever asks who is in the video", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "v/party.mp4", { duration: 20 });
      const appearances = [
        { startMs: 0, endMs: 3_000 },
        { startMs: 9_000, endMs: 15_000 },
      ];
      await db.faces.saveFaceDetectionResult("v/party.mp4", [
        {
          box: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
          confidence: 0.9,
          embedding: unit(1),
          frameTimeMs: 10_000,
          appearances,
        },
      ]);
      while (await db.faceClusters.clusterPendingFaces(256)) {
        /* drain */
      }

      const [face] = await db.faces.getPeopleFacesForFile("v/party.mp4");
      expect(face).toMatchObject({ frameTimeMs: 10_000, appearances });

      // Re-detection replaces them, and removing the file leaves no orphans.
      await db.faces.saveFaceDetectionResult("v/party.mp4", [
        {
          box: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
          confidence: 0.9,
          embedding: unit(1),
          frameTimeMs: 1_000,
          appearances: [{ startMs: 1_000, endMs: 2_000 }],
        },
      ]);
      const rows = () =>
        db.asyncSqlite.all<{ n: number }>("SELECT COUNT(*) AS n FROM faceAppearances");
      expect((await rows())[0].n).toBe(1);
      await db.removeFile("v/party.mp4");
      expect((await rows())[0].n).toBe(0);
    });
  });

  it("stores each face's frame time and hands it back with the People faces", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "v/party.mp4", { duration: 20 });
      await db.faces.saveFaceDetectionResult("v/party.mp4", [
        {
          box: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
          confidence: 0.9,
          embedding: unit(1),
          frameTimeMs: 4_500,
        },
      ]);
      // A photo face alongside it, with no frame time.
      await db.addFile({ folder: "/p/", fileName: "a.jpg", mimeType: "image/jpeg" });
      await db.faces.saveFaceDetectionResult("p/a.jpg", [
        {
          box: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
          confidence: 0.9,
          embedding: unit(2),
        },
      ]);
      while (await db.faceClusters.clusterPendingFaces(256)) {
        /* drain */
      }

      expect(await db.analysis.getVideosNeedingFaceAnalysis()).toEqual([]);

      const result = await db.faceClusters.queryFaceClusters({ filter: {} });
      expect(result.clusters).toHaveLength(1);
      const detail = await db.faceClusters.getFaceClusterDetail({
        filter: {},
        clusterId: result.clusters[0].id,
      });
      const byPath = new Map(detail.cluster!.faces.map((face) => [face.path, face]));
      expect(byPath.get("/v/party.mp4")?.frameTimeMs).toBe(4_500);
      expect(byPath.get("/p/a.jpg")).not.toHaveProperty("frameTimeMs");

      const preview = await db.faces.getClusterFacePreview(result.clusters[0].id);
      expect(preview.find((face) => face.path === "/v/party.mp4")?.frameTimeMs).toBe(
        4_500,
      );
    });
  });

  // Feedback #153: video faces score lower than photo faces, so a capped
  // person's best-match-first list used to hold none of them.
  describe("a capped person's detail keeps videos' share", () => {
    const seedPerson = async (db: IndexDatabase) => {
      const face = (seed: number, frameTimeMs?: number) => ({
        box: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
        confidence: 0.9,
        embedding: unit(seed),
        ...(frameTimeMs !== undefined ? { frameTimeMs } : {}),
      });
      for (let i = 0; i < 6; i++) {
        await db.addFile({ folder: "/f/", fileName: `p${i}.jpg`, mimeType: "image/jpeg" });
        await db.faces.saveFaceDetectionResult(`f/p${i}.jpg`, [face(i + 1)]);
      }
      for (let i = 0; i < 3; i++) {
        await addVideo(db, `f/v${i}.mp4`, { duration: 20 });
        await db.faces.saveFaceDetectionResult(`f/v${i}.mp4`, [face(i + 10, 1_000)]);
      }
      while (await db.faceClusters.clusterPendingFaces(256)) {
        /* drain */
      }
      const { clusters } = await db.faceClusters.queryFaceClusters({ filter: {} });
      expect(clusters).toHaveLength(1);
      // Pin the ranking: every photo face outscores every video face.
      await db.asyncSqlite.run(
        `UPDATE faces SET clusterSimilarity =
           CASE WHEN frameTimeMs IS NULL THEN 0.9 - id * 0.001 ELSE 0.5 - id * 0.001 END`,
      );
      return clusters[0].id;
    };

    const videoCount = (faces: { frameTimeMs?: number }[]) =>
      faces.filter((face) => face.frameTimeMs !== undefined).length;

    it.each([
      ["unfiltered", {}, false],
      ["filtered", { folder: { folder: "/f/", recursive: true } }, false],
      // A named person resolves through faceClusters.personId (the IN path).
      ["unfiltered, named", {}, true],
      ["filtered, named", { folder: { folder: "/f/", recursive: true } }, true],
    ])("swaps the weakest photo for a video face (%s)", async (_label, filter, named) => {
      await withTempDb(async (db) => {
        const clusterId = await seedPerson(db);
        if (named) {
          expect(await db.faceClusters.renameCluster(clusterId, "Riley")).toBe(true);
          const [root] = await db.asyncSqlite.all<{ personId: number | null }>(
            "SELECT personId FROM faceClusters WHERE name = 'Riley'",
          );
          expect(root.personId).not.toBeNull();
        }
        // 3 of 9 faces are video, so 2 of 6 shown should be.
        const detail = await db.faceClusters.getFaceClusterDetail({ filter, clusterId, maxFaces: 6 });
        const faces = detail.cluster!.faces;
        expect(detail.cluster!.count).toBe(9);
        expect(faces).toHaveLength(6);
        expect(videoCount(faces)).toBe(2);
        // Still best match first: the four best photos, then the two videos.
        expect(faces.map((face) => face.path)).toEqual([
          "/f/p0.jpg",
          "/f/p1.jpg",
          "/f/p2.jpg",
          "/f/p3.jpg",
          "/f/v0.mp4",
          "/f/v1.mp4",
        ]);
      });
    });

    it("shows at least one video face, and every face when under the cap", async () => {
      await withTempDb(async (db) => {
        const clusterId = await seedPerson(db);
        const tight = await db.faceClusters.getFaceClusterDetail({ filter: {}, clusterId, maxFaces: 2 });
        expect(videoCount(tight.cluster!.faces)).toBe(1);
        expect(tight.cluster!.faces).toHaveLength(2);

        const all = await db.faceClusters.getFaceClusterDetail({ filter: {}, clusterId });
        expect(all.cluster!.faces).toHaveLength(9);
        expect(videoCount(all.cluster!.faces)).toBe(3);
      });
    });

    // The app always sends a filter (at least the standing default-exclusion
    // filter), so the filtered path is the one people actually hit.
    describe("a person's detail under a filter", () => {
      it.each([
        ["a positive filter", { mimeType: "image/jpeg" }, false],
        ["a not filter, like the default exclusion", { operation: "not", conditions: [{ mimeType: "video/mp4" }] }, false],
        ["a positive filter, named", { mimeType: "image/jpeg" }, true],
        ["a not filter, named", { operation: "not", conditions: [{ mimeType: "video/mp4" }] }, true],
      ])("keeps only the faces whose files pass (%s)", async (_label, filter, named) => {
        await withTempDb(async (db) => {
          const clusterId = await seedPerson(db);
          if (named) expect(await db.faceClusters.renameCluster(clusterId, "Riley")).toBe(true);
          const detail = await db.faceClusters.getFaceClusterDetail({
            filter: filter as Parameters<typeof db.faceClusters.getFaceClusterDetail>[0]["filter"],
            clusterId,
          });
          const cluster = detail.cluster!;
          expect(cluster.count).toBe(6);
          expect(cluster.faces.map((face) => face.path).sort()).toEqual(
            ["/f/p0.jpg", "/f/p1.jpg", "/f/p2.jpg", "/f/p3.jpg", "/f/p4.jpg", "/f/p5.jpg"],
          );
          expect(cluster.centroids).toEqual([expect.objectContaining({ id: clusterId, count: 6 })]);
        });
      });

      it("returns no person when the filter leaves none of their faces", async () => {
        await withTempDb(async (db) => {
          const clusterId = await seedPerson(db);
          const detail = await db.faceClusters.getFaceClusterDetail({
            filter: { mimeType: "image/png" },
            clusterId,
          });
          expect(detail.cluster).toBeNull();
        });
      });
    });
  });
});
