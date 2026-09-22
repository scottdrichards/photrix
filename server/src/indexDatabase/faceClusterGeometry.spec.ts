import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexDatabase } from "./indexDatabase.ts";
import { splitPath } from "./utils/pathUtils.ts";

/**
 * The geometry operations against real SQLite and real greedy clustering. The
 * cap maths itself is covered in faceGeometry.spec.ts; what matters here is
 * that the persisted state agrees with it — that a shrink really evicts, a grow
 * really admits, and a refit really moves the stored centre.
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

/** Unit vector `angle` radians from the reference direction, in a chosen plane. */
const faceAt = (angle: number, plane = 1): Float64Array => {
  const v = new Float64Array(DIMENSION);
  v[0] = Math.cos(angle);
  v[plane] = Math.sin(angle);
  return v;
};

const addFacePhoto = async (
  db: IndexDatabase,
  relativePath: string,
  angle: number,
  plane = 1,
) => {
  const { folder, fileName } = splitPath(relativePath);
  await db.addFile({ folder, fileName, mimeType: "image/jpeg" });
  await db.saveFaceDetectionResult(
    relativePath,
    [
      {
        box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        confidence: 0.95,
        embedding: faceAt(angle, plane),
      },
    ],
    new Date("2026-01-01T00:00:00.000Z"),
  );
};

const drain = async (db: IndexDatabase) => {
  while (await db.clusterPendingFaces(256)) {
    /* until nothing pending */
  }
};

const faceIdOf = async (db: IndexDatabase, relativePath: string) =>
  (await db.getFacesForFile(relativePath))[0]!.id;

describe("cluster geometry", () => {
  it("shrinks to evict an outlying face and reports what goes with it", async () => {
    await withTempDb(async (db) => {
      // A tight band plus two stragglers further out, all in one cluster.
      for (let i = 0; i < 10; i += 1) {
        await addFacePhoto(db, `p/band-${i}.jpg`, 0.02 * i);
      }
      await addFacePhoto(db, "p/far-a.jpg", 0.55);
      await addFacePhoto(db, "p/far-b.jpg", 0.6);
      await drain(db);

      const personId = (await db.getPeopleFacesForFile("p/band-0.jpg"))[0]!.personId;
      const farB = await faceIdOf(db, "p/far-b.jpg");

      // Preview first: it must name both stragglers, since evicting the outer
      // one cannot leave the one beyond it behind.
      const preview = (await db.shrinkToExcludeFace(personId, farB, { dryRun: true }))!;
      expect(preview.excludable).toBe(true);
      expect(preview.affected).toBe(1);
      expect(preview.sample).toHaveLength(1);

      // Nothing changed yet.
      let review = (await db.getFaceClusterReview(personId))!;
      expect(review.faces).toHaveLength(12);

      const applied = (await db.shrinkToExcludeFace(personId, farB))!;
      expect(applied.affected).toBe(1);

      review = (await db.getFaceClusterReview(personId))!;
      expect(review.faces.map((f) => f.fileName)).not.toContain("far-b.jpg");
      // Evicted, not rejected — it is free to be re-homed elsewhere.
      expect(review.rejected).toHaveLength(0);
    });
  });

  it("reports a face it cannot evict by shrinking alone", async () => {
    await withTempDb(async (db) => {
      // The band has to be *spread* for this case to exist at all: a cluster's
      // centre sits in the middle of its members, so against a tight band every
      // outsider is further out than everyone and shrinking always works. Only
      // a broad cluster has an interior for a look-alike to hide in.
      for (let i = 0; i < 10; i += 1) {
        await addFacePhoto(db, `p/band-${i}.jpg`, 0.09 * i);
      }
      // Sitting essentially on the centre, closer in than most real members.
      await addFacePhoto(db, "p/interior.jpg", 0.4);
      await drain(db);

      const personId = (await db.getPeopleFacesForFile("p/band-0.jpg"))[0]!.personId;
      const interior = await faceIdOf(db, "p/interior.jpg");

      const preview = (await db.shrinkToExcludeFace(personId, interior, { dryRun: true }))!;
      // Removing it costs the whole band — the signal the UI uses to offer a
      // per-face rejection instead.
      expect(preview.affected).toBeGreaterThanOrEqual(10);
    });
  });

  it("grows towards a face without sweeping the far side in", async () => {
    await withTempDb(async (db) => {
      for (let i = 0; i < 8; i += 1) {
        await addFacePhoto(db, `p/band-${i}.jpg`, 0.02 * i);
      }
      await drain(db);
      const personId = (await db.getPeopleFacesForFile("p/band-0.jpg"))[0]!.personId;

      // Both have to sit beyond the global threshold (cos 0.62 ~ 0.90 rad) or
      // they would simply have joined the band on their own and there would be
      // nothing to grow towards.
      await addFacePhoto(db, "p/wanted.jpg", 1.0);
      await addFacePhoto(db, "p/stranger.jpg", -1.0);
      await drain(db);

      const wanted = await faceIdOf(db, "p/wanted.jpg");
      const strangerPerson = (await db.getPeopleFacesForFile("p/stranger.jpg"))[0]!.personId;
      expect(strangerPerson).not.toBe(personId);

      const preview = (await db.growToIncludeFace(personId, wanted, { dryRun: true }))!;
      // The stranger is on the far side, so the moved centre must not reach it.
      expect(preview.faceIds).not.toContain(await faceIdOf(db, "p/stranger.jpg"));

      await db.growToIncludeFace(personId, wanted);
      const review = (await db.getFaceClusterReview(personId))!;
      expect(review.faces.map((f) => f.fileName)).toContain("wanted.jpg");
      expect(review.faces.map((f) => f.fileName)).not.toContain("stranger.jpg");
    });
  });

  it("starts a separate cluster under the same person when asked", async () => {
    await withTempDb(async (db) => {
      for (let i = 0; i < 8; i += 1) {
        await addFacePhoto(db, `p/band-${i}.jpg`, 0.02 * i);
      }
      await drain(db);
      const personId = (await db.getPeopleFacesForFile("p/band-0.jpg"))[0]!.personId;
      await db.renameCluster(personId, "Ada");

      await addFacePhoto(db, "p/other-look.jpg", 1.1);
      await drain(db);
      const other = await faceIdOf(db, "p/other-look.jpg");

      const created = (await db.startClusterForFace(personId, other))!;
      expect(created.clusterId).not.toBe(personId);

      // It belongs to the same person, so the review view still sees the face.
      const review = (await db.getFaceClusterReview(personId))!;
      expect(review.name).toBe("Ada");
      expect(review.faces.map((f) => f.fileName)).toContain("other-look.jpg");
    });
  });

  it("refits a cluster onto its surviving members", async () => {
    await withTempDb(async (db) => {
      for (let i = 0; i < 10; i += 1) {
        await addFacePhoto(db, `p/band-${i}.jpg`, 0.02 * i);
      }
      await addFacePhoto(db, "p/far.jpg", 0.6);
      await drain(db);

      const personId = (await db.getPeopleFacesForFile("p/band-0.jpg"))[0]!.personId;
      const before = (await db.getFaceClusterReview(personId))!;

      // Reject the straggler that was dragging the centre, then refit.
      await db.setFaceVerdicts([await faceIdOf(db, "p/far.jpg")], "rejected");
      const result = (await db.refitFaceCluster(personId))!;
      expect(result.caps).toBeGreaterThanOrEqual(1);
      expect(result.uncovered).toBe(0);

      const after = (await db.getFaceClusterReview(personId))!;
      expect(after.faces).toHaveLength(10);
      // With the outlier gone and the centre re-derived, the survivors sit
      // closer to it than they did before.
      const tightness = (r: typeof before) =>
        Math.min(...r.faces.map((f) => f.similarity ?? 0));
      expect(tightness(after)).toBeGreaterThan(tightness(before));
    });
  });

  it("splits a refit when one cap cannot avoid a rejected face", async () => {
    await withTempDb(async (db) => {
      // Two separated looks, with a rejected stranger in the gap between them.
      for (let i = 0; i < 5; i += 1) await addFacePhoto(db, `p/young-${i}.jpg`, 0.02 * i);
      for (let i = 0; i < 5; i += 1) await addFacePhoto(db, `p/old-${i}.jpg`, 0.9 + 0.02 * i);
      await addFacePhoto(db, "p/stranger.jpg", 0.45);
      await drain(db);

      const personId = (await db.getPeopleFacesForFile("p/young-0.jpg"))[0]!.personId;
      const review = (await db.getFaceClusterReview(personId))!;
      // All eleven landed together, which is the situation worth repairing.
      expect(review.faces.length).toBe(11);

      await db.setFaceVerdicts([await faceIdOf(db, "p/stranger.jpg")], "rejected");
      const result = (await db.refitFaceCluster(personId))!;

      expect(result.caps).toBeGreaterThanOrEqual(2);
      const after = (await db.getFaceClusterReview(personId))!;
      // Both looks still belong to the one person, across two caps.
      expect(after.faces).toHaveLength(10);
      expect(after.faces.map((f) => f.fileName)).toContain("young-0.jpg");
      expect(after.faces.map((f) => f.fileName)).toContain("old-0.jpg");
    });
  });
});
