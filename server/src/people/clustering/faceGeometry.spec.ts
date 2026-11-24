import { describe, expect, it } from "@jest/globals";
import {
  type Cap,
  collateralOf,
  dot,
  growCapToInclude,
  minimalEnclosingCap,
  normalize,
  refitCaps,
  shrinkCapToExclude,
  slerp,
} from "./faceGeometry.ts";

const DIMENSION = 64;

/**
 * A unit vector `angle` radians from e0, rotated in the (e0, e1) plane unless a
 * different plane is named. Lets every test state the geometry it wants
 * directly: `at(0.3)` is 0.3 radians from the reference direction, so its
 * cosine similarity to `at(0)` is exactly cos(0.3).
 */
const at = (angle: number, plane = 1): Float32Array => {
  const v = new Float32Array(DIMENSION);
  v[0] = Math.cos(angle);
  v[plane] = Math.sin(angle);
  return v;
};

const angleBetween = (a: Float32Array, b: Float32Array) =>
  Math.acos(Math.min(1, Math.max(-1, dot(a, b))));

describe("slerp", () => {
  it("travels the requested fraction of the arc, staying on the sphere", () => {
    const a = at(0);
    const b = at(1.2);
    const mid = slerp(a, b, 0.25);
    expect(angleBetween(a, mid)).toBeCloseTo(0.3, 5);
    expect(angleBetween(mid, b)).toBeCloseTo(0.9, 5);
    expect(dot(mid, mid)).toBeCloseTo(1, 5);
  });

  it("returns an endpoint when the two directions coincide", () => {
    // Compared by dot product, not by angle. acos has an infinite derivative at
    // 1, so a float32 dot of 0.99999994 — which is just "identical" after
    // rounding — becomes an angle of 3e-4 and looks like a real difference.
    // Anything asserting "same direction" has to do it in cosine space.
    const a = at(0.4);
    expect(dot(slerp(a, at(0.4), 0.5), a)).toBeCloseTo(1, 6);
  });
});

describe("minimalEnclosingCap", () => {
  it("centres between the extremes rather than on the crowd", () => {
    // Nine vectors bunched at one end and a single one far out: the *mean* sits
    // in the bunch, but the smallest enclosing cap has to sit near the midpoint.
    const vectors = [
      ...Array.from({ length: 9 }, (_, i) => at(0.01 * i)),
      at(1.0),
    ];
    const cap = minimalEnclosingCap(vectors)!;
    expect(cap).not.toBeNull();

    const capAngle = Math.acos(cap.minSimilarity);
    // Extremes are 0 and 1.0 rad apart, so the tight cap has radius ~0.5.
    expect(capAngle).toBeGreaterThan(0.45);
    expect(capAngle).toBeLessThan(0.56);

    // Every member is inside, which is the defining property.
    for (const vector of vectors) {
      expect(dot(vector, cap.centre)).toBeGreaterThanOrEqual(cap.minSimilarity - 1e-6);
    }
  });

  it("beats the centroid on radius for a lopsided set", () => {
    const vectors = [...Array.from({ length: 9 }, (_, i) => at(0.01 * i)), at(1.0)];
    const cap = minimalEnclosingCap(vectors)!;

    const mean = new Float32Array(DIMENSION);
    for (const v of vectors) for (let i = 0; i < DIMENSION; i += 1) mean[i] += v[i];
    const centroid = normalize(mean);
    const centroidRadius = Math.max(...vectors.map((v) => angleBetween(v, centroid)));

    expect(Math.acos(cap.minSimilarity)).toBeLessThan(centroidRadius);
  });

  it("handles a single member", () => {
    const cap = minimalEnclosingCap([at(0.7)])!;
    expect(cap.minSimilarity).toBe(1);
  });

  it("returns null for nothing", () => {
    expect(minimalEnclosingCap([])).toBeNull();
  });
});

describe("growCapToInclude", () => {
  const capAt = (centreAngle: number, radius: number): Cap => ({
    centre: at(centreAngle),
    minSimilarity: Math.cos(radius),
  });

  it("moves the centre towards the new face and grows by half the overshoot", () => {
    const cap = capAt(0, 0.2);
    const face = at(0.6);
    const grown = growCapToInclude(cap, face);

    // Radius becomes the midpoint of the old radius and the face's angle.
    expect(Math.acos(grown.minSimilarity)).toBeCloseTo(0.4, 4);
    // The centre travelled half the overshoot towards the face.
    expect(angleBetween(cap.centre, grown.centre)).toBeCloseTo(0.2, 4);
    // ...in the direction of the face, not away from it.
    expect(angleBetween(grown.centre, face)).toBeLessThan(angleBetween(cap.centre, face));
  });

  it("admits the new face and keeps everything the old cap held", () => {
    const cap = capAt(0, 0.2);
    const face = at(0.6);
    const grown = growCapToInclude(cap, face);

    expect(dot(face, grown.centre)).toBeGreaterThanOrEqual(grown.minSimilarity - 1e-6);
    // Sample the old cap's rim all the way round, including the far side.
    for (const plane of [1, 2, 3]) {
      for (const sign of [1, -1]) {
        const rim = slerp(cap.centre, at(sign * Math.PI / 2, plane), 0.2 / (Math.PI / 2));
        expect(dot(rim, cap.centre)).toBeGreaterThanOrEqual(cap.minSimilarity - 1e-6);
        expect(dot(rim, grown.centre)).toBeGreaterThanOrEqual(grown.minSimilarity - 1e-6);
      }
    }
  });

  it("does not sweep the far side outwards, unlike inflating in place", () => {
    const cap = capAt(0, 0.2);
    const face = at(0.6);
    const grown = growCapToInclude(cap, face);

    // A stranger sitting just beyond the rim on the *opposite* side from the
    // new face. Raising the radius in place to 0.6 would swallow it; moving the
    // centre must not.
    const stranger = at(-0.35);
    expect(dot(stranger, at(0))).toBeLessThan(Math.cos(0.2)); // outside the old cap
    expect(dot(stranger, at(0))).toBeGreaterThan(Math.cos(0.6)); // inflating would take it
    expect(dot(stranger, grown.centre)).toBeLessThan(grown.minSimilarity); // moving does not
  });

  it("is a no-op for a face already inside", () => {
    const cap = capAt(0, 0.5);
    expect(growCapToInclude(cap, at(0.2))).toBe(cap);
  });
});

describe("shrinkCapToExclude", () => {
  it("puts the target just outside and leaves the centre alone", () => {
    const cap: Cap = { centre: at(0), minSimilarity: Math.cos(0.8) };
    const target = at(0.6);
    const floor = shrinkCapToExclude(cap, target);
    expect(dot(target, cap.centre)).toBeLessThan(floor);
  });

  it("reports everything the shrink removes, the target included", () => {
    const cap: Cap = { centre: at(0), minSimilarity: Math.cos(0.8) };
    const members = [0.1, 0.3, 0.55, 0.62, 0.7, 0.75].map((a) => ({
      faceId: Math.round(a * 100),
      vector: at(a),
    }));
    const target = members.find((m) => m.faceId === 62)!;

    const floor = shrinkCapToExclude(cap, target.vector);
    const collateral = collateralOf(cap, floor, members);

    // The target and everything further out than it; nothing closer. The target
    // belongs in the count because "this removes 3 faces" is what the user is
    // agreeing to, not "3 besides the one you clicked".
    expect(collateral.map((m) => m.faceId).sort((a, b) => a - b)).toEqual([62, 70, 75]);
  });

  it("cannot remove an interior face — the case that needs an exception", () => {
    const cap: Cap = { centre: at(0), minSimilarity: Math.cos(0.8) };
    const members = [0.1, 0.3, 0.5, 0.7].map((a) => ({ faceId: Math.round(a * 100), vector: at(a) }));
    // A convincing look-alike sitting closer to the centre than most real
    // members. No radius removes it without taking them as well.
    const lookalike = { faceId: 20, vector: at(0.2) };

    const floor = shrinkCapToExclude(cap, lookalike.vector);
    const collateral = collateralOf(cap, floor, members);
    expect(collateral.length).toBe(3);
  });
});

describe("refitCaps", () => {
  const member = (faceId: number, angle: number, plane = 1): { faceId: number; vector: Float32Array } => ({
    faceId,
    vector: at(angle, plane),
  });

  it("tightens a single cap around the survivors", () => {
    const keep = Array.from({ length: 8 }, (_, i) => member(i, 0.02 * i));
    const { caps, uncovered } = refitCaps(keep);
    expect(caps).toHaveLength(1);
    expect(uncovered).toHaveLength(0);
    expect(caps[0].faceIds.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Radius is the half-spread of the survivors, not whatever it was before.
    expect(Math.acos(caps[0].cap.minSimilarity)).toBeLessThan(0.09);
  });

  it("splits when one cap cannot hold the survivors without a rejected face", () => {
    // Two well-separated lobes — a childhood and an adult look — with a
    // stranger sitting in the gap between them.
    const keep = [
      ...Array.from({ length: 5 }, (_, i) => member(i, 0.02 * i)),
      ...Array.from({ length: 5 }, (_, i) => member(100 + i, 1.2 + 0.02 * i)),
    ];
    const stranger = at(0.6);

    const single = minimalEnclosingCap(keep.map((m) => m.vector))!;
    expect(dot(stranger, single.centre)).toBeGreaterThanOrEqual(single.minSimilarity);

    const { caps, uncovered } = refitCaps(keep, [stranger]);
    expect(caps.length).toBeGreaterThanOrEqual(2);
    expect(uncovered).toHaveLength(0);
    for (const fitted of caps) {
      expect(dot(stranger, fitted.cap.centre)).toBeLessThan(fitted.cap.minSimilarity);
    }
    // Every survivor still lands in exactly one cap.
    const covered = caps.flatMap((c) => c.faceIds).sort((a, b) => a - b);
    expect(covered).toEqual(keep.map((m) => m.faceId).sort((a, b) => a - b));
  });

  it("does not split when nothing is being kept out", () => {
    const keep = [
      ...Array.from({ length: 5 }, (_, i) => member(i, 0.02 * i)),
      ...Array.from({ length: 5 }, (_, i) => member(100 + i, 1.2 + 0.02 * i)),
    ];
    expect(refitCaps(keep, []).caps).toHaveLength(1);
  });

  it("gives up honestly rather than publishing a contaminated cap", () => {
    // Three survivors with a rejected face sitting right among them: no cap
    // covers them without it, and the group is too small to split.
    const keep = [member(1, 0.0), member(2, 0.4), member(3, 0.8)];
    // Sitting right between the survivors, so no cap covering them misses it.
    // (An earlier version put the stranger in a different plane, where it was
    // comfortably outside — the test passed for the wrong reason.)
    const stranger = at(0.4);
    const { caps, uncovered } = refitCaps(keep, [stranger], { minCapSize: 3 });
    expect(caps).toHaveLength(0);
    expect(uncovered.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("respects the cap budget", () => {
    const keep = Array.from({ length: 40 }, (_, i) => member(i, (i % 8) * 0.4, 1 + (i % 3)));
    const strangers = Array.from({ length: 6 }, (_, i) => at(0.2 + i * 0.35, 2));
    const { caps } = refitCaps(keep, strangers, { maxCaps: 3, minCapSize: 3 });
    expect(caps.length).toBeLessThanOrEqual(3);
  });

  it("returns nothing for no survivors", () => {
    expect(refitCaps([]).caps).toHaveLength(0);
  });
});
