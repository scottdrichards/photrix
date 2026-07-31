import { describe, expect, it } from "@jest/globals";
import type { DetectedFace } from "./faceDetector.type.ts";
import { identifyFaces, prepareCentroids, type NamedCentroid } from "./identifyFaces.ts";

const DIMENSIONS = 8;
/** An axis no centroid owns, used to tilt a face away from everyone at once. */
const NEUTRAL_AXIS = DIMENSIONS - 1;

/** A Float32 centroid BLOB pointing along one axis. */
const centroidBlob = (axis: number, scale = 3): Buffer => {
  const vector = new Float32Array(DIMENSIONS);
  vector[axis] = scale;
  return Buffer.from(vector.buffer.slice(0));
};

const named = (clusterId: number, name: string, axis: number): NamedCentroid => ({
  clusterId,
  name,
  centroid: centroidBlob(axis),
});

const face = (
  axis: number,
  {
    confidence = 0.95,
    tilt = 0,
    size = 0.2,
  }: { confidence?: number; tilt?: number; size?: number } = {},
): DetectedFace => {
  const embedding = new Float64Array(DIMENSIONS);
  embedding[axis] = 1;
  // Bleed magnitude onto an axis no centroid owns, so similarity drops without
  // the face accidentally pointing at somebody else.
  embedding[NEUTRAL_AXIS] = tilt;
  return {
    box: { x: 0.1, y: 0.1, width: size, height: size },
    confidence,
    embedding,
  };
};

/** Large enough that the pixel gate never fires unless a test wants it to. */
const BIG = { width: 4000, height: 4000 };

describe("identifyFaces", () => {
  const centroids = prepareCentroids([
    named(1, "Alice", 0),
    named(2, "Bob", 1),
    named(3, "Carol", 2),
  ]);

  it("names the person whose centroid the face points at", () => {
    const [result] = identifyFaces([face(1)], centroids);
    expect(result.name).toBe("Bob");
    expect(result.similarity).toBeCloseTo(1, 5);
    expect(result.rejectedFor).toBeNull();
    expect(result.candidates[0]).toMatchObject({ name: "Bob", clusterId: 2 });
  });

  it("withholds a name when the best score is under the threshold", () => {
    // Tilted far enough that its best cosine similarity lands under 0.2.
    const [result] = identifyFaces([face(1, { tilt: 5 })], centroids);
    expect(result.name).toBeNull();
    expect(result.rejectedFor).toBe("threshold");
    // The evidence is still reported — the caller can log a near miss.
    expect(result.candidates).not.toHaveLength(0);
  });

  it("honours a caller-supplied threshold", () => {
    const tilted = [face(1, { tilt: 5 })];
    expect(identifyFaces(tilted, centroids)[0].name).toBeNull();
    expect(identifyFaces(tilted, centroids, { threshold: 0.15 })[0].name).toBe("Bob");
  });

  /** A face pointing between two people, scaled so its top similarity is `peak`. */
  const between = (peak: number): DetectedFace => {
    const embedding = new Float64Array(DIMENSIONS);
    // Equal parts Alice and Bob, so the margin between them is ~0, then tilted
    // onto the neutral axis until the best similarity lands on `peak`.
    embedding[0] = 1;
    embedding[1] = 0.98;
    const planar = Math.hypot(embedding[0], embedding[1]);
    const best = embedding[0] / planar;
    embedding[NEUTRAL_AXIS] = planar * Math.sqrt((best / peak) ** 2 - 1);
    return { box: { x: 0, y: 0, width: 0.2, height: 0.2 }, confidence: 0.95, embedding };
  };

  it("withholds a name when a moderate match has two people neck and neck", () => {
    // The shape junk produces: no real opinion, so the top scores bunch up.
    const [result] = identifyFaces([between(0.25)], centroids);
    expect(result.similarity).toBeGreaterThan(0.2);
    expect(result.similarity).toBeLessThan(0.3);
    expect(result.margin).toBeLessThan(0.05);
    expect(result.name).toBeNull();
    expect(result.rejectedFor).toBe("margin");
  });

  it("names a strong match even with a thin margin, because relatives resemble each other", () => {
    // Measured case: a correct match at 0.381 similarity had only a 0.034
    // margin against the subject's own family. The margin gate must not veto it.
    const [result] = identifyFaces([between(0.38)], centroids);
    expect(result.similarity).toBeGreaterThan(0.3);
    expect(result.margin).toBeLessThan(0.05);
    expect(result.name).toBe("Alice");
    expect(result.rejectedFor).toBeNull();
  });

  it("still rejects a strong-looking match that is too small to be a face", () => {
    const tiny = { ...between(0.38), box: { x: 0, y: 0, width: 0.002, height: 0.002 } };
    const [result] = identifyFaces([tiny], centroids, { decodedSize: BIG });
    expect(result.name).toBeNull();
    expect(result.rejectedFor).toBe("tooSmall");
  });

  it("drops detections below the confidence floor rather than naming them", () => {
    // A low-confidence detection is texture, not a face: it must not be scored
    // at all, because its embedding matches everyone equally badly. Measured
    // junk detections sat at 0.57-0.58, real matches from 0.66 up.
    expect(identifyFaces([face(1, { confidence: 0.57 })], centroids)).toHaveLength(0);
    expect(identifyFaces([face(1, { confidence: 0.66 })], centroids)).toHaveLength(1);
  });

  it("rejects a face too small to carry an identity", () => {
    // 0.002 * 4000 = 8 px, the size of the junk detections in the doorbell
    // sample that nonetheless scored high in absolute terms.
    const tiny = face(1, { size: 0.002 });
    const [result] = identifyFaces([tiny], centroids, { decodedSize: BIG });
    expect(result.name).toBeNull();
    expect(result.rejectedFor).toBe("tooSmall");
    expect(result.facePixels).toEqual({ width: 8, height: 8 });
  });

  it("skips the size gate when the decoded size is unknown", () => {
    const tiny = face(1, { size: 0.002 });
    const [result] = identifyFaces([tiny], centroids);
    expect(result.name).toBe("Bob");
    expect(result.facePixels).toBeUndefined();
  });

  it("measures faces in pixels when the decoded size is known", () => {
    const [result] = identifyFaces([face(1, { size: 0.05 })], centroids, {
      decodedSize: BIG,
    });
    expect(result.facePixels).toEqual({ width: 200, height: 200 });
    expect(result.name).toBe("Bob");
  });

  it("takes a person's best cluster, not their average, when they were merged", () => {
    // Two clusters, one name: a face resembling only the second must still
    // resolve to that person at full similarity.
    const merged = prepareCentroids([
      named(1, "Alice", 0),
      named(2, "Alice", 5),
      named(3, "Bob", 1),
    ]);
    const [result] = identifyFaces([face(5)], merged);
    expect(result.name).toBe("Alice");
    expect(result.similarity).toBeCloseTo(1, 5);
    // Collapsed by name: Alice appears once despite owning two centroids.
    expect(result.candidates.filter((c) => c.name === "Alice")).toHaveLength(1);
  });

  it("orders faces by area so the nearest subject is first", () => {
    const results = identifyFaces(
      [face(0, { size: 0.1 }), face(1, { size: 0.5 })],
      centroids,
    );
    expect(results.map((r) => r.name)).toEqual(["Bob", "Alice"]);
  });

  it("returns nothing for a frame with no faces", () => {
    expect(identifyFaces([], centroids)).toEqual([]);
  });

  it("reports an infinite margin when only one person is known", () => {
    const [result] = identifyFaces([face(0)], prepareCentroids([named(1, "Alice", 0)]));
    expect(result.margin).toBe(Infinity);
    expect(result.name).toBe("Alice");
  });

  it("skips a degenerate centroid instead of ranking a NaN", () => {
    const zeroed: NamedCentroid = {
      clusterId: 9,
      name: "Ghost",
      centroid: Buffer.from(new Float32Array(DIMENSIONS).buffer.slice(0)),
    };
    const prepared = prepareCentroids([zeroed, named(1, "Alice", 0)]);
    expect(prepared.map((c) => c.name)).toEqual(["Alice"]);
    const [result] = identifyFaces([face(0)], prepared);
    expect(result.name).toBe("Alice");
  });

  it("skips a face whose embedding has no magnitude", () => {
    const empty: DetectedFace = {
      box: { x: 0, y: 0, width: 0.2, height: 0.2 },
      confidence: 0.95,
      embedding: new Float64Array(DIMENSIONS),
    };
    expect(identifyFaces([empty], centroids)).toHaveLength(0);
  });
});
