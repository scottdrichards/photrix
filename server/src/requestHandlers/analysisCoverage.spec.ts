import { describe, expect, it, jest } from "@jest/globals";
import { createCoverageReporter } from "./analysisCoverage.ts";

const progress = {
  total: 120,
  done: 100,
  remaining: 15,
  coolingDown: 4,
  nextRetryAt: 1_800_000_000_000 as number | null,
  unreadable: 3,
};

const analysisWith = (getVideoFaceAnalysisProgress: () => Promise<typeof progress>) => ({
  getVideoFaceAnalysisProgress: jest.fn(getVideoFaceAnalysisProgress),
});

describe("createCoverageReporter (feedback #158)", () => {
  it("splits what is left into waiting and held back for a retry", async () => {
    const report = createCoverageReporter(analysisWith(async () => progress));

    expect(await report()).toEqual([
      {
        name: "Video faces",
        unit: "videos",
        done: 100,
        waiting: 11,
        retrying: 4,
        nextRetryAt: 1_800_000_000_000,
        unreadable: 3,
      },
    ]);
  });

  it("leaves the retry time out when nothing is held back", async () => {
    const report = createCoverageReporter(
      analysisWith(async () => ({ ...progress, coolingDown: 0, nextRetryAt: null })),
    );

    expect((await report())[0]).not.toHaveProperty("nextRetryAt");
  });

  it("shares one count between pollers until it goes stale", async () => {
    let clock = 0;
    const analysis = analysisWith(async () => progress);
    const report = createCoverageReporter(analysis, { ttlMs: 1000, now: () => clock });

    await Promise.all([report(), report()]);
    clock = 999;
    await report();
    expect(analysis.getVideoFaceAnalysisProgress).toHaveBeenCalledTimes(1);

    clock = 1000;
    await report();
    expect(analysis.getVideoFaceAnalysisProgress).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep a failed count for the whole TTL", async () => {
    const analysis = analysisWith(async () => progress);
    analysis.getVideoFaceAnalysisProgress.mockRejectedValueOnce(new Error("busy"));
    const report = createCoverageReporter(analysis, { ttlMs: 60_000, now: () => 0 });

    await expect(report()).rejects.toThrow("busy");
    expect(await report()).toHaveLength(1);
  });
});
