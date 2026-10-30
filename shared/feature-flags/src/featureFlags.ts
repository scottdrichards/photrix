/**
 * Every feature flag, with its default and what it controls. This object is
 * the registry: client and server derive their types and lists from it.
 */
export const featureFlags = {
  thumbnailBackfill: {
    default: true,
    description:
      "Pre-generate grid thumbnails for the whole library in the background, newest first.",
  },
} as const satisfies Record<string, { default: boolean; description: string }>;

export type FeatureFlagName = keyof typeof featureFlags;

type FeatureFlagSource = "default" | "override" | "environment";

export type FeatureFlagState = {
  name: FeatureFlagName;
  enabled: boolean;
  source: FeatureFlagSource;
  description: string;
};

export const isFeatureFlagName = (value: string): value is FeatureFlagName =>
  Object.hasOwn(featureFlags, value);

/** `thumbnailBackfill` → `PHOTRIX_FLAG_THUMBNAIL_BACKFILL`. */
export const featureFlagEnvironmentVariable = (name: FeatureFlagName): string =>
  `PHOTRIX_FLAG_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
