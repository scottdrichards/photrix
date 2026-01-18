export const standardHeights = [
  160,
  320,
  640,
  1080,
  2160,
  "original",
] as const;

export type StandardHeight = (typeof standardHeights)[number];

export const parseToStandardHeight = (value: string | null): StandardHeight => {
  if (!value){
    return "original";
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)){
    return "original";
  }

  return standardHeights
    .filter(h=> typeof h === "number")
    .find((height) => height >= parsed) ?? "original";
};
