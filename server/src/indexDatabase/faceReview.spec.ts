import { describe, expect, it } from "@jest/globals";
import {
  MERGE_PROPOSAL_THRESHOLD,
  type AnomalyInput,
  type MergeProposal,
  type OptimizeCluster,
  type TightenProposal,
  haversineKm,
  planOptimization,
  planSplit,
  scoreAnomalies,
  suggestCutoff,
} from "./faceReview.ts";

const DAY = 86_400_000;
const YEAR = 365 * DAY;

/** A tight band of genuine sightings, descending, with no real break in it. */
const cleanBand = (count: number, top = 0.92, step = 0.004): number[] =>
  Array.from({ length: count }, (_, i) => top - i * step);

const unit = (values: number[]): Float32Array => {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return Float32Array.from(values.map((v) => v / magnitude));
};

const baseFace = (overrides: Partial<AnomalyInput> & { faceId: number }): AnomalyInput => ({
  similarity: 0.85,
  takenAt: null,
  latitude: null,
  longitude: null,
  folder: "Photos/2024",
  ...overrides,
});

describe("suggestCutoff", () => {
  it("returns null for a clean cluster with no natural break", () => {
    expect(suggestCutoff(cleanBand(30))).toBeNull();
  });

  it("returns null below the minimum member count, however obvious the gap", () => {
    expect(suggestCutoff([0.95, 0.94, 0.93, 0.92, 0.5])).toBeNull();
  });

  it("finds the break between the band and a trailing group of intruders", () => {
    const similarities = [...cleanBand(20), 0.61, 0.6, 0.58];
    const cutoff = suggestCutoff(similarities);
    expect(cutoff).not.toBeNull();
    expect(cutoff!.keepCount).toBe(20);
    // Midpoint of the gap, so no member sits exactly on the boundary.
    expect(cutoff!.threshold).toBeGreaterThan(0.61);
    expect(cutoff!.threshold).toBeLessThan(cleanBand(20)[19]);
  });

  it("ignores a large gap in the upper half rather than discarding most of the person", () => {
    // The only big step is at index 3 of 24 — cutting there would throw away 21
    // of 24 faces, which is a split, not a cutoff.
    const similarities = [0.99, 0.98, 0.97, ...cleanBand(21, 0.8, 0.004)];
    expect(suggestCutoff(similarities)).toBeNull();
  });

  it("requires the gap to stand out against the distribution's own spread", () => {
    // Broad cluster: ordinary steps are already ~0.02, so a 0.035 step is not
    // evidence of anything even though it clears the absolute floor.
    const ragged = Array.from({ length: 20 }, (_, i) => 0.9 - i * 0.02);
    ragged[15] -= 0.015;
    expect(suggestCutoff(ragged)).toBeNull();
  });

  it("uses a spread that does not collapse as the cluster grows", () => {
    // The regression this guards: with a *median neighbour gap* scale, adding
    // members drives the scale to ~0 and any tail gap qualifies. Measured on the
    // real library a 17k-face person had a median gap of ~1e-5. Same shaped
    // distribution, two sizes — both must give the same verdict.
    const band = (count: number) =>
      Array.from({ length: count }, (_, i) => 0.85 - (i / count) * 0.2);
    const withTail = (count: number) => [...band(count), 0.3, 0.29];

    const small = suggestCutoff(withTail(40));
    const large = suggestCutoff(withTail(4000));
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    // Both cut the same two stragglers off the bottom, not a size-dependent set.
    expect(small!.keepCount).toBe(40);
    expect(large!.keepCount).toBe(4000);

    // And a clean band of either size is still judged clean.
    expect(suggestCutoff(band(40))).toBeNull();
    expect(suggestCutoff(band(4000))).toBeNull();
  });
});

describe("scoreAnomalies", () => {
  it("flags a face far below the rest on similarity", () => {
    const faces = [
      ...Array.from({ length: 10 }, (_, i) => baseFace({ faceId: i, similarity: 0.9 })),
      baseFace({ faceId: 99, similarity: 0.48 }),
    ];
    const results = scoreAnomalies(faces);
    const outlier = results.find((r) => r.faceId === 99)!;
    expect(outlier.flags).toContain("low-similarity");
    expect(outlier.score).toBeGreaterThan(0.7);
    expect(results.find((r) => r.faceId === 0)!.flags).toHaveLength(0);
  });

  it("flags a date far outside the person's own range, not merely an old photo", () => {
    const start = Date.UTC(2020, 0, 1);
    const faces = [
      ...Array.from({ length: 12 }, (_, i) =>
        baseFace({ faceId: i, takenAt: start + i * 30 * DAY }),
      ),
      baseFace({ faceId: 99, takenAt: start - 12 * YEAR }),
    ];
    const results = scoreAnomalies(faces);
    expect(results.find((r) => r.faceId === 99)!.flags).toContain("date");
    // Every in-range face, including the earliest, stays unflagged.
    for (const id of [0, 5, 11]) {
      expect(results.find((r) => r.faceId === id)!.flags).not.toContain("date");
    }
  });

  it("does not fire the date signal when the person has no date spread", () => {
    const at = Date.UTC(2022, 5, 1);
    const faces = Array.from({ length: 12 }, (_, i) => baseFace({ faceId: i, takenAt: at }));
    faces.push(baseFace({ faceId: 99, takenAt: at + 3 * DAY }));
    for (const result of scoreAnomalies(faces)) {
      expect(result.flags).not.toContain("date");
    }
  });

  it("flags a photo far from every other sighting but tolerates a day trip", () => {
    const home = { latitude: 47.6, longitude: -122.33 };
    const faces = [
      ...Array.from({ length: 8 }, (_, i) => baseFace({ faceId: i, ...home })),
      // ~80 km away: a normal day out, must not flag.
      baseFace({ faceId: 50, latitude: 47.0, longitude: -122.9 }),
      // Another continent.
      baseFace({ faceId: 99, latitude: 48.85, longitude: 2.35 }),
    ];
    const results = scoreAnomalies(faces);
    expect(results.find((r) => r.faceId === 50)!.flags).not.toContain("location");
    expect(results.find((r) => r.faceId === 99)!.flags).toContain("location");
  });

  it("scores by the strongest single signal, so correlated weak signals cannot outrank a strong one", () => {
    const start = Date.UTC(2020, 0, 1);
    const common = Array.from({ length: 24 }, (_, i) =>
      baseFace({
        faceId: i,
        takenAt: start + i * 30 * DAY,
        latitude: 47.6,
        longitude: -122.33,
        folder: `Photos/${i % 4}`,
      }),
    );
    // A holiday abroad: new place, new folder, edge of the date range — three
    // mild signals at once, but a perfectly good face of the right person.
    const holiday = baseFace({
      faceId: 90,
      similarity: 0.88,
      takenAt: start + 25 * 30 * DAY,
      latitude: 48.85,
      longitude: 2.35,
      folder: "Photos/Paris",
    });
    // A genuine intruder: nothing unusual about the context, just not them.
    const intruder = baseFace({
      faceId: 91,
      similarity: 0.46,
      takenAt: start + 10 * 30 * DAY,
      latitude: 47.6,
      longitude: -122.33,
      folder: "Photos/1",
    });
    const results = scoreAnomalies([...common, holiday, intruder]);
    const holidayScore = results.find((r) => r.faceId === 90)!.score;
    const intruderScore = results.find((r) => r.faceId === 91)!.score;
    expect(intruderScore).toBeGreaterThan(holidayScore);
  });

  it("attaches readable evidence to every flag it raises", () => {
    const faces = [
      ...Array.from({ length: 10 }, (_, i) => baseFace({ faceId: i, similarity: 0.9 })),
      baseFace({ faceId: 99, similarity: 0.46 }),
    ];
    const outlier = scoreAnomalies(faces).find((r) => r.faceId === 99)!;
    expect(outlier.reasons).toHaveLength(outlier.flags.length);
    expect(outlier.reasons[0]).toMatch(/similarity/);
  });
});

describe("haversineKm", () => {
  it("measures a known distance", () => {
    // Seattle to Paris, ~7900 km.
    expect(haversineKm(47.6, -122.33, 48.85, 2.35)).toBeGreaterThan(7800);
    expect(haversineKm(47.6, -122.33, 48.85, 2.35)).toBeLessThan(8100);
  });
});

describe("planOptimization", () => {
  const cluster = (
    id: string,
    name: string | null,
    count: number,
    values: number[],
    similarities = cleanBand(10),
  ): OptimizeCluster => ({ id, name, count, vector: unit(values), similarities });

  it("proposes merging two near-identical centroids, larger absorbing smaller", async () => {
    const proposals = await planOptimization([
      cluster("person-1", null, 40, [1, 0.02, 0]),
      cluster("person-2", null, 6, [1, 0.03, 0]),
      cluster("person-3", null, 30, [0, 0, 1]),
    ]);
    const merges = proposals.filter((p): p is MergeProposal => p.kind === "merge");
    expect(merges).toHaveLength(1);
    expect(merges[0].targetId).toBe("person-1");
    expect(merges[0].sourceId).toBe("person-2");
    expect(merges[0].similarity).toBeGreaterThan(MERGE_PROPOSAL_THRESHOLD);
  });

  it("keeps the named side as the merge target even when it is smaller", async () => {
    const proposals = await planOptimization([
      cluster("person-1", null, 80, [1, 0.02, 0]),
      cluster("person-2", "Ada", 5, [1, 0.03, 0]),
    ]);
    const merge = proposals.find((p): p is MergeProposal => p.kind === "merge")!;
    expect(merge.targetId).toBe("person-2");
    expect(merge.sourceId).toBe("person-1");
  });

  it("reports a two-named-people pair but marks the name conflict", async () => {
    const proposals = await planOptimization([
      cluster("person-1", "Ada", 40, [1, 0.02, 0]),
      cluster("person-2", "Grace", 30, [1, 0.03, 0]),
    ]);
    const merge = proposals.find((p): p is MergeProposal => p.kind === "merge")!;
    expect(merge.nameConflict).toBe(true);
  });

  it("never proposes the same source twice, so the plan can be applied top-down", async () => {
    const proposals = await planOptimization([
      cluster("person-1", null, 40, [1, 0.01, 0]),
      cluster("person-2", null, 30, [1, 0.02, 0]),
      cluster("person-3", null, 20, [1, 0.03, 0]),
    ]);
    const merges = proposals.filter((p): p is MergeProposal => p.kind === "merge");
    const sources = merges.map((m) => m.sourceId);
    expect(new Set(sources).size).toBe(sources.length);
    for (const merge of merges) {
      expect(sources).not.toContain(merge.targetId);
    }
  });

  it("proposes a radius for a cluster with a trailing tail", async () => {
    const proposals = await planOptimization([
      cluster("person-1", "Ada", 23, [1, 0, 0], [...cleanBand(20), 0.61, 0.6, 0.58]),
      cluster("person-2", "Grace", 30, [0, 1, 0], cleanBand(30)),
    ]);
    const tightens = proposals.filter((p): p is TightenProposal => p.kind === "tighten");
    expect(tightens).toHaveLength(1);
    expect(tightens[0].clusterId).toBe("person-1");
    expect(tightens[0].affected).toBe(3);
  });
});

describe("planSplit", () => {
  const member = (faceId: number, values: number[]) => ({ faceId, vector: unit(values) });

  it("separates two genuinely distinct lobes", () => {
    const members = [
      ...Array.from({ length: 6 }, (_, i) => member(i, [1, 0.01 * i, 0])),
      ...Array.from({ length: 6 }, (_, i) => member(100 + i, [0, 0.01 * i, 1])),
    ];
    const plan = planSplit(members)!;
    expect(plan).not.toBeNull();
    expect(plan.crossSimilarity).toBeLessThan(0.3);
    const lobeWithZero = plan.lobes.find((lobe) => lobe.faceIds.includes(0))!;
    expect(lobeWithZero.faceIds).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("is deterministic across repeated calls", () => {
    const build = () => [
      ...Array.from({ length: 5 }, (_, i) => member(i, [1, 0.02 * i, 0])),
      ...Array.from({ length: 5 }, (_, i) => member(100 + i, [0, 0.02 * i, 1])),
    ];
    const first = planSplit(build())!;
    const second = planSplit(build())!;
    expect(second.lobes.map((l) => l.faceIds)).toEqual(first.lobes.map((l) => l.faceIds));
  });

  it("declines to split when one side would be too small to be a person", () => {
    const members = [
      ...Array.from({ length: 10 }, (_, i) => member(i, [1, 0.01 * i, 0])),
      member(100, [0, 0, 1]),
    ];
    expect(planSplit(members)).toBeNull();
  });

  it("declines when there are not enough members at all", () => {
    expect(planSplit([member(1, [1, 0, 0]), member(2, [0, 0, 1])])).toBeNull();
  });
});
