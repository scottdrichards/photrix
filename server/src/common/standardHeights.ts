export const standardHeights = [
  160,
  320,
  640,
  1080,
  2160,
  "original",
] as const;

export type StandardHeight = (typeof standardHeights)[number];
