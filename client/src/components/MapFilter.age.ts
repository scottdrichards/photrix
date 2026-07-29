import type { GeoPoint } from "../api";

/**
 * Sequential single-hue ramp (blue, light -> dark) used to encode photo age on
 * the map: oldest photos get the lightest step, newest the darkest.
 *
 * Why these five values: pins are drawn on OpenStreetMap raster tiles, which are
 * the same light surface in both app themes, so one ramp serves both. The steps
 * were validated against that tile surface (#f2efe9) as an ordinal ramp —
 * monotone lightness, adjacent lightness gaps >= 0.06, lightest step still
 * clearing 2:1 against the tiles, hue spread 3 degrees. Because the ramp varies
 * in lightness and holds a single hue, it stays ordered for every kind of color
 * vision; no step is distinguished by hue alone.
 */
export const AGE_RAMP = [
  "#6da7ec",
  "#3987e5",
  "#256abf",
  "#184f95",
  "#0d366b",
] as const;

/** Pins with no usable date fall back to the ramp's middle step. */
export const UNDATED_PIN_COLOR = AGE_RAMP[2];

export type AgeScale = {
  /** Epoch ms of the oldest dated pin. */
  minDate: number;
  /** Epoch ms of the newest dated pin. */
  maxDate: number;
  /** Number of ramp steps in play (1 when every pin shares a date). */
  stepCount: number;
};

export type AgeLegendStep = {
  color: string;
  /** Inclusive start of the step, epoch ms. */
  start: number;
  /** Exclusive end of the step (inclusive for the last one), epoch ms. */
  end: number;
  label: string;
};

/**
 * Representative instant for a pin: the midpoint of the bucket's date range, so
 * a cluster spanning several visits reads at its centre of mass rather than
 * being dragged to whichever end happens to be extreme.
 */
export const pointDate = (point: GeoPoint): number | undefined => {
  const { minDate, maxDate } = point;
  if (typeof minDate === "number" && typeof maxDate === "number") {
    return (minDate + maxDate) / 2;
  }
  return minDate ?? maxDate;
};

export const buildAgeScale = (points: readonly GeoPoint[]): AgeScale | null => {
  let minDate = Number.POSITIVE_INFINITY;
  let maxDate = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const date = pointDate(point);
    if (date === undefined) continue;
    if (date < minDate) minDate = date;
    if (date > maxDate) maxDate = date;
  }
  if (!Number.isFinite(minDate) || !Number.isFinite(maxDate)) {
    return null;
  }
  return {
    minDate,
    maxDate,
    stepCount: maxDate > minDate ? AGE_RAMP.length : 1,
  };
};

/** Ramp index for an instant; 0 is oldest. */
export const ageStepIndex = (scale: AgeScale | null, date: number | undefined): number => {
  if (!scale || date === undefined || scale.stepCount === 1) {
    return AGE_RAMP.length - 1;
  }
  const span = scale.maxDate - scale.minDate;
  const ratio = (date - scale.minDate) / span;
  const index = Math.floor(ratio * AGE_RAMP.length);
  return Math.min(AGE_RAMP.length - 1, Math.max(0, index));
};

export const colorForDate = (scale: AgeScale | null, date: number | undefined): string => {
  if (date === undefined) {
    return UNDATED_PIN_COLOR;
  }
  return AGE_RAMP[ageStepIndex(scale, date)];
};

const YEAR_MS = 365.2425 * 24 * 60 * 60 * 1000;

/** Year for short labels, or `Mon YYYY` when the whole range is under ~2 years. */
const formatEdge = (epochMs: number, useMonths: boolean): string => {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "";
  return useMonths
    ? date.toLocaleDateString(undefined, { month: "short", year: "numeric" })
    : String(date.getFullYear());
};

/**
 * Legend model: one entry per ramp step with the date window it stands for.
 * Rendered as a touching strip, so each swatch is read against its neighbours
 * rather than against the app surface (which differs between themes).
 */
export const buildAgeLegend = (scale: AgeScale | null): AgeLegendStep[] => {
  if (!scale) return [];
  const useMonths = scale.maxDate - scale.minDate < 2 * YEAR_MS;
  if (scale.stepCount === 1) {
    return [
      {
        color: AGE_RAMP[AGE_RAMP.length - 1],
        start: scale.minDate,
        end: scale.maxDate,
        label: formatEdge(scale.minDate, useMonths),
      },
    ];
  }
  const span = scale.maxDate - scale.minDate;
  return AGE_RAMP.map((color, index) => {
    const start = scale.minDate + (span * index) / AGE_RAMP.length;
    const end = scale.minDate + (span * (index + 1)) / AGE_RAMP.length;
    return { color, start, end, label: formatEdge(start, useMonths) };
  });
};

export const formatAgeRangeLabel = (scale: AgeScale | null): string => {
  if (!scale) return "No dates available";
  const useMonths = scale.maxDate - scale.minDate < 2 * YEAR_MS;
  const oldest = formatEdge(scale.minDate, useMonths);
  const newest = formatEdge(scale.maxDate, useMonths);
  return oldest === newest ? oldest : `${oldest} – ${newest}`;
};
