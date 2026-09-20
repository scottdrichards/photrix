import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexDatabase } from "./indexDatabase.ts";
import { splitPath } from "./utils/pathUtils.ts";

/**
 * End-to-end cover for the review/repair path: real embeddings, real greedy
 * clustering, real SQLite. The pure scoring lives in faceReview.spec.ts; what
 * is worth proving here is that the *persisted* behaviour holds — that a cutoff
 * actually removes the right rows, that a confirmed face is immune to one, that
 * a radius keeps new faces out on the next scan, and that a verdict survives a
 * re-cluster.
 */

const DIMENSION = 128;

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

/**
 * A vector `angle` radians away from the reference direction, so its cosine
 * similarity to a face built at angle 0 is exactly cos(angle). That makes every
 * test able to state the similarity it wants rather than tuning noise until a
 * cluster happens to form.
 */
const faceAt = (angle: number, jitterSeed: number): Float64Array => {
  const vector = new Float64Array(DIMENSION);
  vector[0] = Math.cos(angle);
  vector[1] = Math.sin(angle);
  for (let i = 2; i < DIMENSION; i += 1) {
    vector[i] = Math.sin(jitterSeed * 7.3 + i) * 0.002;
  }
  return vector;
};

/** Adds one photo containing exactly one face at `angle`. */
const addFacePhoto = async (
  db: IndexDatabase,
  relativePath: string,
  angle: number,
  seed: number,
  extra: { dateTaken?: Date; latitude?: number; longitude?: number } = {},
) => {
  const { folder, fileName } = splitPath(relativePath);
  await db.addFile({
    folder,
    fileName,
    mimeType: "image/jpeg",
    ...(extra.dateTaken ? { dateTaken: extra.dateTaken } : {}),
    ...(extra.latitude !== undefined ? { locationLatitude: extra.latitude } : {}),
    ...(extra.longitude !== undefined ? { locationLongitude: extra.longitude } : {}),
  });
  await db.saveFaceDetectionResult(
    relativePath,
    [
      {
        box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        confidence: 0.95,
        embedding: faceAt(angle, seed),
      },
    ],
    new Date("2026-01-01T00:00:00.000Z"),
  );
};

const drainClustering = async (db: IndexDatabase) => {
  while (await db.clusterPendingFaces(256)) {
    /* keep going until nothing is pending */
  }
};

/**
 * Twelve faces of one person in a tight band (similarity ~0.96-0.99 to each
 * other) plus three intruders at ~0.70 — close enough to be swept into the same
 * cluster by the 0.62 threshold, which is exactly the failure this whole
 * feature exists to clean up.
 */
const BAND_COUNT = 12;
const INTRUDER_COUNT = 3;

const buildContaminatedPerson = async (db: IndexDatabase) => {
  for (let i = 0; i < BAND_COUNT; i += 1) {
    await addFacePhoto(db, `people/band-${i}.jpg`, 0.15 + i * 0.012, i);
  }
  for (let i = 0; i < INTRUDER_COUNT; i += 1) {
    await addFacePhoto(db, `people/intruder-${i}.jpg`, 0.79 + i * 0.01, 100 + i);
  }
  await drainClustering(db);

  const faces = await db.getPeopleFacesForFile("people/band-0.jpg");
  expect(faces).toHaveLength(1);
  return faces[0]!.personId;
};

describe("face cluster review", () => {
  it("orders a person's faces by distance and finds the break above the intruders", async () => {
    await withTempDb(async (db) => {
      const personId = await buildContaminatedPerson(db);

      const review = await db.getFaceClusterReview(personId);
      expect(review).not.toBeNull();
      expect(review!.faces).toHaveLength(BAND_COUNT + INTRUDER_COUNT);

      const similarities = review!.faces.map((face) => face.similarity!);
      expect([...similarities].sort((a, b) => b - a)).toEqual(similarities);

      // The suggested cut lands exactly between the band and the intruders.
      expect(review!.suggestedCutoff).not.toBeNull();
      expect(review!.suggestedCutoff!.keepCount).toBe(BAND_COUNT);

      const cutFaceNames = review!.faces.slice(BAND_COUNT).map((face) => face.fileName);
      expect(cutFaceNames.sort()).toEqual([
        "intruder-0.jpg",
        "intruder-1.jpg",
        "intruder-2.jpg",
      ]);
    });
  });

  it("reports a dry-run cutoff without changing anything", async () => {
    await withTempDb(async (db) => {
      const personId = await buildContaminatedPerson(db);
      const { suggestedCutoff } = (await db.getFaceClusterReview(personId))!;

      const preview = await db.applyFaceClusterCutoff(
        personId,
        suggestedCutoff!.threshold,
        { dryRun: true },
      );
      expect(preview!.affected).toBe(INTRUDER_COUNT);

      const after = await db.getFaceClusterReview(personId);
      expect(after!.faces).toHaveLength(BAND_COUNT + INTRUDER_COUNT);
      expect(after!.rejected).toHaveLength(0);
      expect(after!.radius).toBeNull();
    });
  });

  it("applies a cutoff, remembers it as a radius, and keeps the removed faces recoverable", async () => {
    await withTempDb(async (db) => {
      const personId = await buildContaminatedPerson(db);
      const { suggestedCutoff } = (await db.getFaceClusterReview(personId))!;

      const applied = await db.applyFaceClusterCutoff(
        personId,
        suggestedCutoff!.threshold,
      );
      expect(applied!.affected).toBe(INTRUDER_COUNT);

      const after = await db.getFaceClusterReview(personId);
      expect(after!.faces).toHaveLength(BAND_COUNT);
      expect(after!.rejected.map((face) => face.fileName).sort()).toEqual([
        "intruder-0.jpg",
        "intruder-1.jpg",
        "intruder-2.jpg",
      ]);
      expect(after!.radius).toBeCloseTo(suggestedCutoff!.threshold, 6);
      // Nothing is left to cut, so there is no second suggestion to act on.
      expect(after!.suggestedCutoff).toBeNull();

      // And the removal is reversible.
      await db.setFaceVerdicts(
        after!.rejected.map((face) => face.faceId),
        null,
      );
      await drainClustering(db);
      const restored = await db.getFaceClusterReview(personId);
      expect(restored!.rejected).toHaveLength(0);
    });
  });

  it("never cuts a face the user has confirmed", async () => {
    await withTempDb(async (db) => {
      const personId = await buildContaminatedPerson(db);
      const review = (await db.getFaceClusterReview(personId))!;

      // Vouch for one of the very faces the cut line would otherwise remove.
      const doomed = review.faces[BAND_COUNT]!;
      expect(doomed.fileName).toMatch(/^intruder-/);
      await db.setFaceVerdicts([doomed.faceId], "confirmed");

      const applied = await db.applyFaceClusterCutoff(
        personId,
        review.suggestedCutoff!.threshold,
      );
      expect(applied!.affected).toBe(INTRUDER_COUNT - 1);
      expect(applied!.faceIds).not.toContain(doomed.faceId);

      const after = await db.getFaceClusterReview(personId);
      expect(after!.faces.map((face) => face.faceId)).toContain(doomed.faceId);
    });
  });

  it("builds an anchor from confirmed faces and says so", async () => {
    await withTempDb(async (db) => {
      const personId = await buildContaminatedPerson(db);
      const review = (await db.getFaceClusterReview(personId))!;
      expect(review.anchored).toBe(false);

      await db.setFaceVerdicts(
        review.faces.slice(0, 4).map((face) => face.faceId),
        "confirmed",
      );

      const anchored = (await db.getFaceClusterReview(personId))!;
      expect(anchored.anchored).toBe(true);
      expect(anchored.anchorCount).toBe(4);
    });
  });

  it("keeps a below-radius face out of the person on a later scan", async () => {
    await withTempDb(async (db) => {
      const personId = await buildContaminatedPerson(db);
      const { suggestedCutoff } = (await db.getFaceClusterReview(personId))!;
      await db.applyFaceClusterCutoff(personId, suggestedCutoff!.threshold);

      // A newly-indexed face just like the intruders: still above the global
      // 0.62 clustering threshold, so without the radius it would join.
      await addFacePhoto(db, "people/intruder-late.jpg", 0.79, 200);
      await drainClustering(db);

      const after = await db.getFaceClusterReview(personId);
      expect(after!.faces.map((face) => face.fileName)).not.toContain(
        "intruder-late.jpg",
      );

      const lateFaces = await db.getPeopleFacesForFile("people/intruder-late.jpg");
      // Rejected by *this* person, not by everyone — it still gets a cluster of
      // its own rather than being dropped on the floor.
      expect(lateFaces).toHaveLength(1);
      expect(lateFaces[0]!.personId).not.toBe(personId);
    });
  });

  it("re-applies a rejection after a full re-cluster", async () => {
    await withTempDb(async (db) => {
      const personId = await buildContaminatedPerson(db);
      const review = (await db.getFaceClusterReview(personId))!;
      const doomed = review.faces[BAND_COUNT]!;
      await db.setFaceVerdicts([doomed.faceId], "rejected");

      // Simulate what changing FACE_CLUSTER_SIMILARITY_THRESHOLD does: every
      // assignment is wiped, including the exclusion sentinel, and the backfill
      // re-derives the lot. This used to silently un-do the rejection.
      await db.resetFaceClusterAssignments();
      await drainClustering(db);
      const reapplied = await db.reapplyFaceVerdicts();
      expect(reapplied).toBe(1);

      // Cluster ids are re-derived from scratch, so ask the library where this
      // person lives now rather than assuming the id survived.
      const rebuiltPersonId = (await db.getPeopleFacesForFile("people/band-0.jpg"))[0]!
        .personId;
      const after = await db.getFaceClusterReview(rebuiltPersonId);
      expect(after!.faces.map((face) => face.faceId)).not.toContain(doomed.faceId);
      expect(after!.rejected.map((face) => face.faceId)).toContain(doomed.faceId);
    });
  });
});
