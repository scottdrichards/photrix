import { describe, it, expect, jest } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexDatabase } from "./indexDatabase.ts";
import { splitPath } from "./utils/pathUtils.ts";

const withTempDb = async (testFn: (db: IndexDatabase) => Promise<void>) => {
  const mediaRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-media-root-"));
  const dbRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-db-root-"));
  process.env.INDEX_DB_LOCATION = dbRoot;
  try {
    const db = new IndexDatabase(mediaRoot);
    await db.init();
    await db.startupMaintenance;
    await testFn(db);
  } finally {
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

      const queued = await db.getVideosNeedingFaceAnalysis();
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

      const queued = (await db.getVideosNeedingFaceAnalysis()).map((v) => v.relativePath);
      expect(queued).toEqual(["/lp/solo.mp4"]);
      const progress = await db.getVideoFaceAnalysisProgress();
      expect(progress).toEqual({ total: 2, remaining: 1, coolingDown: 0, unreadable: 0 });
    });
  });

  it("holds a failed video back for the whole cooldown instead of retrying it", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "v/bad.mp4");
      await db.saveVideoFaceAnalysisError("v/bad.mp4");

      expect(await db.getVideosNeedingFaceAnalysis()).toEqual([]);
      // Back after the cooldown, and marked so it goes behind fresh work.
      const later = jest
        .spyOn(Date, "now")
        .mockReturnValue(Date.now() + IndexDatabase.VIDEO_FACE_RETRY_COOLDOWN_MS + 1);
      expect(await db.getVideosNeedingFaceAnalysis()).toMatchObject([
        { relativePath: "/v/bad.mp4", failedBefore: true },
      ]);
      later.mockRestore();
      // Still owed, so progress doesn't claim it is done, and says why.
      expect(await db.getVideoFaceAnalysisProgress()).toMatchObject({
        remaining: 1,
        coolingDown: 1,
      });
      // Not this run's work, so the ETA doesn't price it.
      expect(await db.getVideoFaceQueueCostInputs()).toEqual([]);
    });
  });

  it("drops a video whose frames can't be decoded from the queue for good", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "v/corrupt.mp4");
      await db.saveImageAnalysisDecodeError("v/corrupt.mp4");
      expect(await db.getVideosNeedingFaceAnalysis()).toEqual([]);
      expect(await db.getVideoFaceAnalysisProgress()).toMatchObject({
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
      expect(await db.getVideoFaceQueueCostInputs()).toEqual([
        { durationSeconds: 40, sizeBytes: 300e6, width: 3840, height: 2160 },
      ]);
      expect((await db.getVideosNeedingFaceAnalysis())[0]).toMatchObject({
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
      await db.saveFaceDetectionResult("v/party.mp4", [
        {
          box: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
          confidence: 0.9,
          embedding: unit(1),
          frameTimeMs: 10_000,
          appearances,
        },
      ]);
      while (await db.clusterPendingFaces(256)) {
        /* drain */
      }

      const [face] = await db.getPeopleFacesForFile("v/party.mp4");
      expect(face).toMatchObject({ frameTimeMs: 10_000, appearances });

      // Re-detection replaces them, and removing the file leaves no orphans.
      await db.saveFaceDetectionResult("v/party.mp4", [
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
      await db.saveFaceDetectionResult("v/party.mp4", [
        {
          box: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
          confidence: 0.9,
          embedding: unit(1),
          frameTimeMs: 4_500,
        },
      ]);
      // A photo face alongside it, with no frame time.
      await db.addFile({ folder: "/p/", fileName: "a.jpg", mimeType: "image/jpeg" });
      await db.saveFaceDetectionResult("p/a.jpg", [
        {
          box: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
          confidence: 0.9,
          embedding: unit(2),
        },
      ]);
      while (await db.clusterPendingFaces(256)) {
        /* drain */
      }

      expect(await db.getVideosNeedingFaceAnalysis()).toEqual([]);

      const result = await db.queryFaceClusters({ filter: {} });
      expect(result.clusters).toHaveLength(1);
      const detail = await db.getFaceClusterDetail({
        filter: {},
        clusterId: result.clusters[0].id,
      });
      const byPath = new Map(detail.cluster!.faces.map((face) => [face.path, face]));
      expect(byPath.get("/v/party.mp4")?.frameTimeMs).toBe(4_500);
      expect(byPath.get("/p/a.jpg")).not.toHaveProperty("frameTimeMs");

      const preview = await db.getClusterFacePreview(result.clusters[0].id);
      expect(preview.find((face) => face.path === "/v/party.mp4")?.frameTimeMs).toBe(
        4_500,
      );
    });
  });
});
