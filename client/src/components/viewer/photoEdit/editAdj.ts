
export interface EditAdj {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  saturation: number;
  vibrance: number;
  temperature: number;
  tint: number;
  clarity: number;
  dehaze: number;
  sharpness: number;
  /** Radial edge darkening/lightening. Positive darkens toward the edges,
   * negative lightens (whitens) toward the edges. 0 disables it entirely. */
  vignette: number;
  rotation: number;
  rotate90: number;
  flipH: boolean;
  flipV: boolean;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  cropLeft: number;
}
export interface EditStyle {
  filter: string;
  transform: string;
  clipPath: string;
  /** CSS `background` value for a radial-gradient vignette overlay, or
   * undefined when no vignette is applied. A vignette can't be expressed as a
   * single CSS `filter` function (it needs spatial variation), so callers that
   * render via `filter`/`transform`/`clipPath` must additionally paint an
   * absolutely-positioned overlay element with this as its background. */
  vignetteBackground?: string;
}
export const DEFAULT_ADJ: EditAdj = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  saturation: 0, vibrance: 0, temperature: 0, tint: 0,
  clarity: 0, dehaze: 0, sharpness: 0, vignette: 0,
  rotation: 0, rotate90: 0, flipH: false, flipV: false,
  cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0,
};
export function isDirty(adj: EditAdj): boolean {
  return JSON.stringify(adj) !== JSON.stringify(DEFAULT_ADJ);
}

// ─── Filter math ───────────────────────────────────────────────────────────
// Falloff starts this fraction of the way out from center to the farthest
// corner — everything inside stays untouched, everything beyond ramps in.
export const VIGNETTE_INNER_RADIUS = 0.35;
// Darkening/lightening amount at the slider's extreme (100), applied at the
// very corner. Kept under 1 so corners still show some detail even at max.
const VIGNETTE_MAX_STRENGTH = 0.8;
export function vignetteStrength(vignette: number): number {
  return Math.min(1, Math.abs(vignette) / 100) * VIGNETTE_MAX_STRENGTH;
}
// CSS radial-gradient background for the vignette overlay used by the
// CSS-filter-based rendering paths (saved-edit display outside the live
// canvas preview). `ellipse farthest-corner` (the CSS default) matches the
// per-pixel corner-normalized falloff used in applyPixelAdj below, so the two
// rendering paths look the same.
function vignetteCssBackground(vignette: number): string | undefined {
  if (vignette === 0) return undefined;
  const strength = vignetteStrength(vignette);
  const color = vignette > 0 ? "0, 0, 0" : "255, 255, 255";
  const innerPct = (VIGNETTE_INNER_RADIUS * 100).toFixed(1);
  return `radial-gradient(ellipse at center, rgba(${color}, 0) ${innerPct}%, rgba(${color}, ${strength.toFixed(3)}) 100%)`;
}
export function computeStyle(adj: EditAdj, svgId: string): EditStyle {
  const needsSvg =
    adj.exposure !== 0 || adj.highlights !== 0 || adj.shadows !== 0 ||
    adj.temperature !== 0 || adj.tint !== 0 ||
    adj.sharpness !== 0 || adj.clarity !== 0 ||
    adj.dehaze !== 0;
  const contrast = Math.max(0, 1 + (adj.contrast / 100) * 0.8).toFixed(3);
  const sat = Math.max(0, 1 + (adj.saturation / 100) * 1.5);
  const vib = Math.max(0, 1 + (adj.vibrance / 100) * 0.7);
  const dehazeSatBoost = Math.max(0, 1 + (adj.dehaze / 100) * 0.4);
  const totalSat = (sat * vib * dehazeSatBoost).toFixed(3);

  const filterParts: string[] = [];
  if (needsSvg) filterParts.push(`url(#${svgId})`);
  if (contrast !== "1.000") filterParts.push(`contrast(${contrast})`);
  if (totalSat !== "1.000") filterParts.push(`saturate(${totalSat})`);
  const filter = filterParts.join(" ");

  const totalDeg = adj.rotation + adj.rotate90 * 90;
  const xformParts: string[] = [];
  if (totalDeg !== 0) xformParts.push(`rotate(${totalDeg}deg)`);
  if (adj.flipH) xformParts.push("scaleX(-1)");
  if (adj.flipV) xformParts.push("scaleY(-1)");
  const transform = xformParts.join(" ");

  const clipPath =
    adj.cropTop === 0 && adj.cropRight === 0 && adj.cropBottom === 0 && adj.cropLeft === 0
      ? ""
      : `inset(${adj.cropTop}% ${adj.cropRight}% ${adj.cropBottom}% ${adj.cropLeft}%)`;

  return { filter, transform, clipPath, vignetteBackground: vignetteCssBackground(adj.vignette) };
}

// ─── Crop math ─────────────────────────────────────────────────────────────
