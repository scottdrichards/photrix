import type { AnalysisCoverage } from "../../../shared/filter-contract/src/index.ts";
import type { AnalysisStore } from "../indexDatabase/analysisStore.ts";

/**
 * Feedback #158: the Status modal listed only running tasks, so a face pass
 * that had finished, or was resting while its failures cooled down, simply
 * disappeared, and one that was slow looked the same as one that was stuck.
 * This reports how far each library-wide pass has got, running or not.
 *
 * The counts are full scans of `files`, and every open Status modal polls, so
 * one result is shared for `ttlMs`. Coverage moves on a scale of minutes.
 */
export const createCoverageReporter = (
  analysis: Pick<AnalysisStore, "getVideoFaceAnalysisProgress">,
  { ttlMs = 60_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {},
) => {
  let cached: { at: number; value: Promise<AnalysisCoverage[]> } | null = null;

  const compute = async (): Promise<AnalysisCoverage[]> => {
    const progress = await analysis.getVideoFaceAnalysisProgress();
    return [
      {
        name: "Video faces",
        unit: "videos",
        done: progress.done,
        waiting: Math.max(0, progress.remaining - progress.coolingDown),
        retrying: progress.coolingDown,
        ...(progress.nextRetryAt !== null ? { nextRetryAt: progress.nextRetryAt } : {}),
        unreadable: progress.unreadable,
      },
    ];
  };

  return (): Promise<AnalysisCoverage[]> => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const value = compute();
    cached = { at: now(), value };
    // A failed count must not stick for the whole TTL.
    value.catch(() => {
      if (cached?.value === value) cached = null;
    });
    return value;
  };
};
