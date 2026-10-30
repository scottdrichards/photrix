import { getAuthHeaders } from "../../../auth";
import { type EditAdj } from "./editAdj";

// Auto-levels/white-balance only needs a representative sample of the tone
// and color distribution, not every pixel — sampling a small downscale keeps
// this fast even for very large source photos.
const AUTO_SAMPLE_MAX_EDGE = 200;
function sampleImagePixels(img: HTMLImageElement): { data: Uint8ClampedArray; count: number } {
  const iw = img.naturalWidth || 1;
  const ih = img.naturalHeight || 1;
  const scale = Math.min(1, AUTO_SAMPLE_MAX_EDGE / Math.max(iw, ih));
  const sw = Math.max(1, Math.round(iw * scale));
  const sh = Math.max(1, Math.round(ih * scale));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, sw, sh);
  const { data } = ctx.getImageData(0, 0, sw, sh);
  return { data, count: sw * sh };
}
/**
 * Classical auto-levels + gray-world white balance, computed from a sampled
 * ImageData (see sampleImagePixels for how the sample is produced) and
 * mapped onto the existing exposure/contrast/temperature/tint/vibrance
 * sliders — this doesn't add a separate rendering path, the result is just
 * slider values applied the same way a manual edit would be. Pulled out from
 * computeAutoAdjustments as a pure function so the math is unit-testable
 * without mocking fetch/Image/canvas.
 *
 * White balance: solves for the temperature/tint values that make the
 * sampled channel averages neutral gray, by inverting the same linear model
 * applyPixelAdj/computeStyle use to apply temperature/tint.
 *
 * Levels: nudges exposure so mean luminance sits near mid-gray, and contrast
 * so a percentile-clipped tonal range (ignoring the most extreme 1% of
 * outlier pixels on each end) covers close to the full 0-255 range.
 */
export function deriveAutoAdjFromSample(data: Uint8ClampedArray, count: number): Partial<EditAdj> {
  if (count === 0) return {};

  let sumR = 0, sumG = 0, sumB = 0, sumSat = 0;
  const lum = new Float32Array(count);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    sumR += r; sumG += g; sumB += b;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    sumSat += maxC > 0 ? (maxC - minC) / maxC : 0;
    lum[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const avgR = sumR / count;
  const avgG = sumG / count;
  const avgB = sumB / count;
  const avgSat = sumSat / count;

  // Gray-world white balance (see colorMatrixValues / applyPixelAdj for the
  // forward model this inverts): r' = r*(1+t*0.18), b' = b*(1-t*0.18),
  // g' = g*(1-|t|*0.03)*(1-n*0.12). Solve t so r'==b', then n so g'==avg(r',b').
  //
  // A *full* gray-world solve (WB_CORRECTION_STRENGTH = 1) assumes the
  // average pixel in every photo should be neutral gray, which is false for
  // a huge fraction of real photos — warm skin tones, sunsets, foliage, etc.
  // all skew the average color on purpose. Divisors of 0.18/0.12 in the
  // model above mean even an ordinary, mild color cast (e.g. avgR 150 /
  // avgB 100) solves to well past +/-100 and gets clamped there, so nearly
  // every non-neutral photo was getting the maximum-strength correction
  // slammed on — reported as "auto edit maxes out tint and temperature and
  // makes it look awful" (feedback #55). Damping the solved correction
  // before clamping fixes it: still leans the photo toward neutral, but
  // only partway, so intentional color character survives.
  const WB_CORRECTION_STRENGTH = 0.4;
  let temperature = 0;
  if (avgR + avgB > 0) {
    temperature = (100 * (avgB - avgR)) / (0.18 * (avgR + avgB));
  }
  temperature = Math.max(-100, Math.min(100, temperature * WB_CORRECTION_STRENGTH));
  const t = temperature / 100;
  const avgRB = (avgR * (1 + t * 0.18) + avgB * (1 - t * 0.18)) / 2;
  const gTempAdjusted = avgG * (1 - Math.abs(t) * 0.03);
  let tint = 0;
  if (gTempAdjusted > 0) {
    tint = (100 * (1 - avgRB / gTempAdjusted)) / 0.12;
  }
  tint = Math.max(-100, Math.min(100, tint * WB_CORRECTION_STRENGTH));

  // Auto-levels from the luminance histogram of the sample.
  const sorted = lum.slice().sort();
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  const low = pct(0.01);
  const high = pct(0.99);
  let meanLum = 0;
  for (let i = 0; i < sorted.length; i++) meanLum += sorted[i];
  meanLum /= sorted.length;

  const targetMean = 128;
  let exposure = 0;
  if (meanLum > 1) {
    const expMult = Math.max(0.5, Math.min(2, targetMean / meanLum));
    exposure = Math.max(-100, Math.min(100, ((expMult - 1) / 0.7) * 100));
  }

  const spread = Math.max(1, high - low);
  const targetSpread = 180;
  const contrastFactor = Math.max(0.6, Math.min(1.8, targetSpread / spread));
  const contrast = Math.max(-100, Math.min(100, ((contrastFactor - 1) / 0.8) * 100));

  // Gentle vibrance lift for washed-out/low-saturation photos; leave
  // already-vivid images alone.
  const vibrance = Math.max(0, Math.min(40, (0.35 - avgSat) * 160));

  return {
    exposure: Math.round(exposure),
    contrast: Math.round(contrast),
    // Reset highlights/shadows: the exposure/contrast solve above assumes a
    // neutral tone curve (matching the untouched original we sampled), and
    // stale highlight/shadow tweaks from an earlier manual edit would throw
    // that off.
    highlights: 0,
    shadows: 0,
    temperature: Math.round(temperature),
    tint: Math.round(tint),
    vibrance: Math.round(vibrance),
  };
}

export async function computeAutoAdjustments(fullUrl: string): Promise<Partial<EditAdj>> {
  const resp = await fetch(fullUrl, { headers: getAuthHeaders() });
  if (!resp.ok) throw new Error("Failed to load image");
  const blob = await resp.blob();
  const blobUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = blobUrl;
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("Load failed")); });

    const { data, count } = sampleImagePixels(img);
    return deriveAutoAdjFromSample(data, count);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

// ─── SVG filter component ──────────────────────────────────────────────────
