import { describe, expect, it } from "@jest/globals";
import {
  centroidSimilarity,
  dot,
  foldIntoCentroid,
  pickRepresentative,
  MOMENT_VISUAL_SIMILARITY_THRESHOLD,
} from "./momentClusterEngine.ts";

describe("momentClusterEngine", () => {
  it("dot: identical unit vectors score 1", () => {
    const v = new Float32Array([1, 0, 0]);
    expect(dot(v, v)).toBeCloseTo(1, 5);
  });

  it("dot: orthogonal vectors score 0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(dot(a, b)).toBeCloseTo(0, 5);
  });

  it("centroidSimilarity: matches dot product for a single-member centroid", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0.6, 0.8, 0]);
    expect(centroidSimilarity(a, 1, b)).toBeCloseTo(dot(a, b), 5);
  });

  it("centroidSimilarity: a near-duplicate frame clears the join threshold", () => {
    const centroid = new Float32Array([1, 0, 0]);
    // A slight perturbation representative of a second burst frame of the same
    // scene — small enough to stay above the join threshold.
    const nearDuplicate = normalize([0.99, 0.05, 0.02]);
    expect(centroidSimilarity(centroid, 1, nearDuplicate)).toBeGreaterThanOrEqual(
      MOMENT_VISUAL_SIMILARITY_THRESHOLD,
    );
  });

  it("centroidSimilarity: a different-angle shot of the same scene stays below the join threshold", () => {
    const centroid = new Float32Array([1, 0, 0]);
    // A meaningfully different embedding direction — standing in for two
    // people photographing the same event from different angles, which the
    // design explicitly requires NOT to cluster together.
    const differentAngle = normalize([0.5, 0.5, 0.7]);
    expect(centroidSimilarity(centroid, 1, differentAngle)).toBeLessThan(
      MOMENT_VISUAL_SIMILARITY_THRESHOLD,
    );
  });

  it("foldIntoCentroid: running sum accumulates member vectors", () => {
    let sum = new Float32Array([1, 0, 0]);
    sum = foldIntoCentroid(sum, new Float32Array([0, 1, 0]));
    expect(Array.from(sum)).toEqual([1, 1, 0]);
  });

  it("pickRepresentative: prefers the sharper member when quality is equal", () => {
    const winner = pickRepresentative([
      { folder: "/a/", fileName: "blurry.jpg", sharpnessScore: 10, photoQualityScore: null },
      { folder: "/a/", fileName: "sharp.jpg", sharpnessScore: 500, photoQualityScore: null },
    ]);
    expect(winner?.fileName).toBe("sharp.jpg");
  });

  it("pickRepresentative: a strong photoQualityScore bonus can overcome a small sharpness gap", () => {
    // Min-max normalization is relative to the whole cluster, so a third,
    // much-blurrier member spreads the scale enough that the two contenders'
    // near-identical sharpness lands close together (rather than snapping to
    // the 0/1 extremes a two-member comparison would force) — letting the
    // quality bonus decide between them, same as it would with a bigger burst.
    const winner = pickRepresentative([
      { folder: "/a/", fileName: "much-blurrier.jpg", sharpnessScore: 10, photoQualityScore: null },
      // Marginally sharper than its rival, but nobody's smiling/eyes-open.
      { folder: "/a/", fileName: "sharp-blink.jpg", sharpnessScore: 501, photoQualityScore: 0 },
      // Marginally less sharp but everyone's eyes are open and smiling — the
      // 0.5-weighted quality bonus outweighs the near-identical sharpness gap.
      {
        folder: "/a/",
        fileName: "good-expression.jpg",
        sharpnessScore: 500,
        photoQualityScore: 1,
      },
    ]);
    expect(winner?.fileName).toBe("good-expression.jpg");
  });

  it("pickRepresentative: unknown sharpness never outranks a scored member", () => {
    const winner = pickRepresentative([
      { folder: "/a/", fileName: "unreadable.jpg", sharpnessScore: null, photoQualityScore: null },
      { folder: "/a/", fileName: "scored.jpg", sharpnessScore: 1, photoQualityScore: null },
    ]);
    expect(winner?.fileName).toBe("scored.jpg");
  });

  it("pickRepresentative: single member is trivially the representative", () => {
    const only = { folder: "/a/", fileName: "only.jpg", sharpnessScore: null, photoQualityScore: null };
    expect(pickRepresentative([only])).toBe(only);
  });

  it("pickRepresentative: empty list returns null", () => {
    expect(pickRepresentative([])).toBeNull();
  });
});

const normalize = (values: number[]): Float32Array => {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return new Float32Array(values.map((v) => v / magnitude));
};
