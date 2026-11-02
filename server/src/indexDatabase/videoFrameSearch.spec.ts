import { describe, expect, it } from "@jest/globals";
import path from "node:path";
import type { IndexDatabase } from "./indexDatabase.ts";
import { VectorIndex } from "./vectorIndex/vectorIndex.ts";
import { encodeEmbedding } from "./embeddingCodec.ts";
import { withTempDb } from "./withTempDb.fixture.ts";

// Feedback #150: CLIP search over the sampled frames of videos.

const vec = (...values: number[]) => Float32Array.from(values);
const QUERY = vec(1, 0, 0, 0);

const addVideo = async (
  db: IndexDatabase,
  folder: string,
  fileName: string,
  frames: Array<{ timeMs: number; embedding: Float32Array }>,
) => {
  await db.addFile({ folder, fileName, mimeType: "video/mp4" });
  await db.analysis.saveVideoFrameEmbeddings(`${folder}${fileName}`, frames);
};

const addPhoto = async (db: IndexDatabase, folder: string, fileName: string, embedding: Float32Array) => {
  await db.addFile({ folder, fileName, mimeType: "image/jpeg" });
  await db.analysis.saveImageEmbedding(`${folder}${fileName}`, embedding);
};

describe("searching video frames", () => {
  it("finds a video by its best frame, ranked with photos, and says when that frame is", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "/v/", "beach.mp4", [
        { timeMs: 0, embedding: vec(0, 1, 0, 0) },
        { timeMs: 4_000, embedding: vec(1, 0, 0, 0) },
        { timeMs: 8_000, embedding: vec(0, 0, 1, 0) },
      ]);
      await addPhoto(db, "/p/", "half.jpg", vec(0.7071, 0.7071, 0, 0));
      await addPhoto(db, "/p/", "off.jpg", vec(0, 0, 0, 1));

      const results = await db.analysis.semanticSearch(QUERY, {}, 10);

      expect(results.map((r) => r.fileName)).toEqual(["beach.mp4", "half.jpg", "off.jpg"]);
      expect(results[0]).toMatchObject({ similarity: expect.closeTo(1, 4), matchTimeMs: 4_000 });
      expect(results[1]).not.toHaveProperty("matchTimeMs");
    });
  });

  it("marks the video's frames as embedded, so the video pass doesn't redo them", async () => {
    await withTempDb(async (db) => {
      await db.addFile({ folder: "/v/", fileName: "a.mp4", mimeType: "video/mp4", exifProcessedAt: new Date() });
      const needs = async () =>
        (await db.analysis.getVideosNeedingFaceAnalysis()).find((v) => v.relativePath === "/v/a.mp4");
      expect(await needs()).toMatchObject({ needsEmbedding: true });
      await db.analysis.saveVideoFrameEmbeddings("v/a.mp4", [{ timeMs: 0, embedding: QUERY }]);
      expect((await needs())?.needsEmbedding ?? false).toBe(false);
    });
  });

  it("only returns videos the filter allows", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "/elsewhere/", "best.mp4", [{ timeMs: 0, embedding: QUERY }]);
      await addVideo(db, "/trip/", "good.mp4", [{ timeMs: 2_000, embedding: vec(0.9, 0.1, 0, 0) }]);

      const results = await db.analysis.semanticSearch(
        QUERY,
        { folder: { folder: "trip", recursive: true } },
        10,
      );

      expect(results.map((r) => [r.fileName, r.matchTimeMs])).toEqual([["good.mp4", 2_000]]);
    });
  });

  it("drops a removed video, and carries a moved one's frames to its new name", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "/v/", "gone.mp4", [{ timeMs: 0, embedding: QUERY }]);
      await addVideo(db, "/v/", "old.mp4", [{ timeMs: 6_000, embedding: vec(0.9, 0.1, 0, 0) }]);

      await db.removeFile("v/gone.mp4");
      await db.moveFile("v/old.mp4", "w/new.mp4");

      const results = await db.analysis.semanticSearch(QUERY, {}, 10);
      expect(results.map((r) => [r.folder, r.fileName, r.matchTimeMs])).toEqual([
        ["/w/", "new.mp4", 6_000],
      ]);
    });
  });

  it("forgets a resynced video's frames until they are embedded again", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "/v/", "edited.mp4", [{ timeMs: 0, embedding: QUERY }]);
      await db.markFileForResync("v/edited.mp4");
      expect(await db.analysis.semanticSearch(QUERY, {}, 10)).toEqual([]);
    });
  });

  it("loads stored frames back into a fresh index", async () => {
    await withTempDb(async (db) => {
      await addVideo(db, "/v/", "kept.mp4", [
        { timeMs: 1_000, embedding: vec(0, 1, 0, 0) },
        { timeMs: 9_000, embedding: QUERY },
      ]);
      const index = new VectorIndex(path.join(process.env.INDEX_DB_LOCATION!, "index.db"));
      try {
        expect(await index.loaded).toMatchObject({ videos: 1 });
        const [hit] = await index.searchFrames(encodeEmbedding(QUERY)!, 5);
        expect(hit).toMatchObject({ folder: "/v/", fileName: "kept.mp4", timeMs: 9_000 });
      } finally {
        await index.close();
      }
    });
  });
});
