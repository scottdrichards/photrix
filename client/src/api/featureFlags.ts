import type { FeatureFlagName, FeatureFlagState } from "../../../shared/feature-flags/src/featureFlags";
import { fetchJsonOrThrow } from "./http";

export const fetchFeatureFlags = async (): Promise<FeatureFlagState[]> =>
  (await fetchJsonOrThrow<{ flags: FeatureFlagState[] }>("/api/feature-flags", "get feature flags"))
    .flags;

/** Overrides a flag at runtime, or clears the override with `null`. Returns every flag's new state. */
export const setFeatureFlagOverride = async (
  name: FeatureFlagName,
  enabled: boolean | null,
): Promise<FeatureFlagState[]> =>
  (
    await fetchJsonOrThrow<{ flags: FeatureFlagState[] }>(
      `/api/feature-flags/${encodeURIComponent(name)}`,
      `set feature flag ${name}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      },
    )
  ).flags;
