import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownload24Regular,
  Crop24Regular,
  Dismiss24Regular,
  Eye24Regular,
  EyeOff24Regular,
  ImageArrowCounterclockwise24Regular,
  RotateRight24Regular,
  Wand24Regular,
} from "@fluentui/react-icons";
import { getAuthHeaders } from "../auth";
import css from "./PhotoEditor.module.css";

// ─── Types ─────────────────────────────────────────────────────────────────

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

function toneTableValues(exposure: number, highlights: number, shadows: number): string {
  const expMult = 1 + (exposure / 100) * 0.7;
  const shadStr = -(shadows / 100) * 0.45;
  const hiStr = (highlights / 100) * 0.25;
  return Array.from({ length: 11 }, (_, i) => {
    const x = i / 10;
    let v = Math.max(0, x * expMult);
    v += shadStr * (1 - Math.min(1, v)) * (1 - Math.min(1, v));
    v += hiStr * v * v;
    return Math.max(0, Math.min(1, v)).toFixed(4);
  }).join(" ");
}

function colorMatrixValues(temperature: number, tint: number): string {
  const t = temperature / 100;
  const n = tint / 100;
  const r = (1 + t * 0.18).toFixed(4);
  const g = ((1 - Math.abs(t) * 0.03) * (1 - n * 0.12)).toFixed(4);
  const b = (1 - t * 0.18).toFixed(4);
  return `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`;
}

// Falloff starts this fraction of the way out from center to the farthest
// corner — everything inside stays untouched, everything beyond ramps in.
const VIGNETTE_INNER_RADIUS = 0.35;
// Darkening/lightening amount at the slider's extreme (100), applied at the
// very corner. Kept under 1 so corners still show some detail even at max.
const VIGNETTE_MAX_STRENGTH = 0.8;

function vignetteStrength(vignette: number): number {
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

function computeAlignCrop(
  rotationDeg: number,
  aspectRatio: number,
): { top: number; right: number; bottom: number; left: number } {
  const θ = Math.abs(rotationDeg * Math.PI / 180);
  if (θ < 0.001) return { top: 0, right: 0, bottom: 0, left: 0 };
  const W = aspectRatio;
  const H = 1;
  const cosT = Math.cos(θ);
  const sinT = Math.sin(θ);
  const cos2 = Math.cos(2 * θ);
  if (cos2 < 0.001) return { top: 49, right: 49, bottom: 49, left: 49 };
  const a = Math.max(0, (W * cosT - H * sinT) / cos2);
  const b = Math.max(0, (H * cosT - W * sinT) / cos2);
  const cropX = Math.max(0, Math.min(49, ((W - a) / (2 * W)) * 100));
  const cropY = Math.max(0, Math.min(49, ((H - b) / (2 * H)) * 100));
  return { top: cropY, right: cropX, bottom: cropY, left: cropX };
}

// ─── Canvas export ─────────────────────────────────────────────────────────

function separableBoxBlur(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const r = Math.max(1, Math.round(radius));
  const diam = 2 * r + 1;
  const tmp = new Float32Array(src.length);
  const out = new Uint8ClampedArray(src.length);

  for (let y = 0; y < height; y++) {
    let rS = 0, gS = 0, bS = 0;
    const base = y * width;
    for (let dx = -r; dx <= r; dx++) {
      const px = Math.max(0, Math.min(width - 1, dx));
      const i = (base + px) * 4;
      rS += src[i]; gS += src[i + 1]; bS += src[i + 2];
    }
    for (let x = 0; x < width; x++) {
      const i = (base + x) * 4;
      tmp[i] = rS / diam; tmp[i + 1] = gS / diam; tmp[i + 2] = bS / diam; tmp[i + 3] = src[i + 3];
      const aX = Math.min(width - 1, x + r + 1);
      const rX = Math.max(0, x - r);
      rS += src[(base + aX) * 4] - src[(base + rX) * 4];
      gS += src[(base + aX) * 4 + 1] - src[(base + rX) * 4 + 1];
      bS += src[(base + aX) * 4 + 2] - src[(base + rX) * 4 + 2];
    }
  }

  for (let x = 0; x < width; x++) {
    let rS = 0, gS = 0, bS = 0;
    for (let dy = -r; dy <= r; dy++) {
      const py = Math.max(0, Math.min(height - 1, dy));
      const i = (py * width + x) * 4;
      rS += tmp[i]; gS += tmp[i + 1]; bS += tmp[i + 2];
    }
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      out[i] = rS / diam; out[i + 1] = gS / diam; out[i + 2] = bS / diam; out[i + 3] = src[i + 3];
      const aY = Math.min(height - 1, y + r + 1);
      const rY = Math.max(0, y - r);
      rS += tmp[(aY * width + x) * 4] - tmp[(rY * width + x) * 4];
      gS += tmp[(aY * width + x) * 4 + 1] - tmp[(rY * width + x) * 4 + 1];
      bS += tmp[(aY * width + x) * 4 + 2] - tmp[(rY * width + x) * 4 + 2];
    }
  }

  return out;
}

function applyUnsharpMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  amount: number,
) {
  const blurred = separableBoxBlur(data, width, height, radius);
  for (let i = 0; i < data.length - 3; i += 4) {
    data[i] = Math.max(0, Math.min(255, data[i] + amount * (data[i] - blurred[i])));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + amount * (data[i + 1] - blurred[i + 1])));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + amount * (data[i + 2] - blurred[i + 2])));
  }
}

export function applyPixelAdj(data: Uint8ClampedArray, width: number, height: number, adj: EditAdj) {
  const expMult = 1 + (adj.exposure / 100) * 0.7;
  const shadStr = -(adj.shadows / 100) * 0.45;
  const hiStr = (adj.highlights / 100) * 0.25;
  const contrastFactor = 1 + (adj.contrast / 100) * 0.8;
  const satFactor = 1 + (adj.saturation / 100) * 1.5;
  const vibFactor = adj.vibrance / 100;
  const tempFactor = adj.temperature / 100;
  const tintFactor = adj.tint / 100;

  const toneLUT = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    v = Math.max(0, v * expMult);
    v += shadStr * (1 - Math.min(1, v)) * (1 - Math.min(1, v));
    v += hiStr * v * v;
    toneLUT[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }

  const dehazeAmount = adj.dehaze / 100;
  const dehazeH = Math.abs(dehazeAmount) * 0.5;
  const dehazeSatBoost = 1 + dehazeAmount * 0.4;
  let dehazeLUT: Uint8Array | null = null;
  if (dehazeAmount !== 0) {
    dehazeLUT = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      const dv = dehazeAmount > 0
        ? Math.max(0, Math.min(1, (v - dehazeH) / (1 - dehazeH)))
        : Math.max(0, Math.min(1, v * (1 - dehazeH) + dehazeH));
      dehazeLUT[i] = Math.round(dv * 255);
    }
  }

  for (let idx = 0; idx < data.length; idx += 4) {
    let r = toneLUT[data[idx]];
    let g = toneLUT[data[idx + 1]];
    let b = toneLUT[data[idx + 2]];

    if (tempFactor !== 0 || tintFactor !== 0) {
      r = Math.max(0, Math.min(255, r * (1 + tempFactor * 0.18)));
      g = Math.max(0, Math.min(255, g * (1 - Math.abs(tempFactor) * 0.03) * (1 - tintFactor * 0.12)));
      b = Math.max(0, Math.min(255, b * (1 - tempFactor * 0.18)));
    }

    if (contrastFactor !== 1) {
      r = Math.max(0, Math.min(255, 128 + (r - 128) * contrastFactor));
      g = Math.max(0, Math.min(255, 128 + (g - 128) * contrastFactor));
      b = Math.max(0, Math.min(255, 128 + (b - 128) * contrastFactor));
    }

    const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (satFactor !== 1) {
      r = Math.max(0, Math.min(255, gray + (r - gray) * satFactor));
      g = Math.max(0, Math.min(255, gray + (g - gray) * satFactor));
      b = Math.max(0, Math.min(255, gray + (b - gray) * satFactor));
    }
    if (vibFactor !== 0) {
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const curSat = maxC > 0 ? (maxC - minC) / maxC : 0;
      const boost = 1 + vibFactor * (1 - curSat) * 1.2;
      const g2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = Math.max(0, Math.min(255, g2 + (r - g2) * boost));
      g = Math.max(0, Math.min(255, g2 + (g - g2) * boost));
      b = Math.max(0, Math.min(255, g2 + (b - g2) * boost));
    }

    if (dehazeLUT) {
      r = dehazeLUT[Math.min(255, Math.max(0, Math.round(r)))];
      g = dehazeLUT[Math.min(255, Math.max(0, Math.round(g)))];
      b = dehazeLUT[Math.min(255, Math.max(0, Math.round(b)))];
      if (dehazeSatBoost !== 1) {
        const gv = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = Math.max(0, Math.min(255, gv + (r - gv) * dehazeSatBoost));
        g = Math.max(0, Math.min(255, gv + (g - gv) * dehazeSatBoost));
        b = Math.max(0, Math.min(255, gv + (b - gv) * dehazeSatBoost));
      }
    }

    data[idx] = r; data[idx + 1] = g; data[idx + 2] = b;
  }

  if (adj.clarity > 0) applyUnsharpMask(data, width, height, 8, adj.clarity / 100 * 0.6);
  if (adj.sharpness > 0) applyUnsharpMask(data, width, height, 1.5, adj.sharpness / 100 * 1.2);

  if (adj.vignette !== 0) {
    const strength = vignetteStrength(adj.vignette);
    const vr = adj.vignette > 0 ? 0 : 255;
    const vg = vr, vb = vr;
    const cx = width / 2;
    const cy = height / 2;
    for (let y = 0; y < height; y++) {
      const dy = cy > 0 ? (y - cy) / cy : 0;
      const rowBase = y * width;
      for (let x = 0; x < width; x++) {
        const dx = cx > 0 ? (x - cx) / cx : 0;
        // Normalized so the exact corner is 1 and the center is 0, matching
        // the CSS `ellipse farthest-corner` gradient used elsewhere.
        const dist = Math.sqrt(dx * dx + dy * dy) * Math.SQRT1_2;
        const t = Math.max(0, Math.min(1, (dist - VIGNETTE_INNER_RADIUS) / (1 - VIGNETTE_INNER_RADIUS)));
        const amount = t * t * strength;
        if (amount <= 0) continue;
        const idx = (rowBase + x) * 4;
        data[idx] += (vr - data[idx]) * amount;
        data[idx + 1] += (vg - data[idx + 1]) * amount;
        data[idx + 2] += (vb - data[idx + 2]) * amount;
      }
    }
  }
}

async function exportEdited(fullUrl: string, photoName: string, adj: EditAdj) {
  const resp = await fetch(fullUrl, { headers: getAuthHeaders() });
  if (!resp.ok) throw new Error("Failed to load image");
  const blob = await resp.blob();
  const blobUrl = URL.createObjectURL(blob);
  const img = new Image();
  img.src = blobUrl;
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("Load failed")); });

  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const cropL = Math.round(iw * (adj.cropLeft / 100));
  const cropR = Math.round(iw * (adj.cropRight / 100));
  const cropT = Math.round(ih * (adj.cropTop / 100));
  const cropB = Math.round(ih * (adj.cropBottom / 100));
  const cw = Math.max(1, iw - cropL - cropR);
  const ch = Math.max(1, ih - cropT - cropB);

  const totalDeg = ((adj.rotation + adj.rotate90 * 90) % 360 + 360) % 360;
  const rad = (totalDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const outW = Math.round(cw * cos + ch * sin);
  const outH = Math.round(cw * sin + ch * cos);

  const canvas = document.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, outW, outH);
  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  if (adj.flipH) ctx.scale(-1, 1);
  if (adj.flipV) ctx.scale(1, -1);
  if (totalDeg !== 0) ctx.rotate(rad);
  ctx.translate(-cw / 2, -ch / 2);
  ctx.drawImage(img, cropL, cropT, cw, ch, 0, 0, cw, ch);
  ctx.restore();
  URL.revokeObjectURL(blobUrl);

  const imageData = ctx.getImageData(0, 0, outW, outH);
  applyPixelAdj(imageData.data, outW, outH, adj);
  ctx.putImageData(imageData, 0, 0);

  const baseName = photoName.replace(/\.[^.]+$/, "");
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/jpeg", 0.92);
  a.download = `${baseName}_edited.jpg`;
  a.click();
}

// ─── Auto enhance ──────────────────────────────────────────────────────────

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

async function computeAutoAdjustments(fullUrl: string): Promise<Partial<EditAdj>> {
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

export function EditSvgDefs({ adj, filterId }: { adj: EditAdj; filterId: string }) {
  const toneVals = toneTableValues(adj.exposure, adj.highlights, adj.shadows);
  const colorMat = colorMatrixValues(adj.temperature, adj.tint);
  const sharpAmt = (adj.sharpness / 100 * 1.2).toFixed(3);
  const sharpK2 = (1 + adj.sharpness / 100 * 1.2).toFixed(3);
  const clarAmt = (adj.clarity / 100 * 0.6).toFixed(3);
  const clarK2 = (1 + adj.clarity / 100 * 0.6).toFixed(3);
  const needsSharp = adj.sharpness > 0;
  const needsClarity = adj.clarity > 0;
  const needsDehaze = adj.dehaze !== 0;
  const dehazeH = Math.abs(adj.dehaze / 100) * 0.5;
  const dehazeSlope = adj.dehaze > 0 ? 1 / (1 - dehazeH) : 1 - dehazeH;
  const dehazeIntercept = adj.dehaze > 0 ? -dehazeH / (1 - dehazeH) : dehazeH;
  const postToneResult = needsDehaze ? "dehazed" : "toned";

  return (
    <svg
      width="0"
      height="0"
      aria-hidden="true"
      style={{ position: "absolute", overflow: "hidden", pointerEvents: "none" }}
    >
      <defs>
        <filter
          id={filterId}
          x="-10%"
          y="-10%"
          width="120%"
          height="120%"
          colorInterpolationFilters="sRGB"
        >
          <feColorMatrix type="matrix" values={colorMat} result="colored" />
          <feComponentTransfer in="colored" result="toned">
            <feFuncR type="table" tableValues={toneVals} />
            <feFuncG type="table" tableValues={toneVals} />
            <feFuncB type="table" tableValues={toneVals} />
          </feComponentTransfer>
          {needsDehaze && (
            <feComponentTransfer in="toned" result="dehazed">
              <feFuncR type="linear" slope={dehazeSlope.toFixed(4)} intercept={dehazeIntercept.toFixed(4)} />
              <feFuncG type="linear" slope={dehazeSlope.toFixed(4)} intercept={dehazeIntercept.toFixed(4)} />
              <feFuncB type="linear" slope={dehazeSlope.toFixed(4)} intercept={dehazeIntercept.toFixed(4)} />
            </feComponentTransfer>
          )}
          {needsSharp && (
            <>
              <feGaussianBlur in={postToneResult} stdDeviation="1.2" result="sharpBlur" />
              <feComposite
                in={postToneResult}
                in2="sharpBlur"
                operator="arithmetic"
                k1="0"
                k2={sharpK2}
                k3={`-${sharpAmt}`}
                k4="0"
                result={needsClarity ? "sharpened" : undefined}
              />
            </>
          )}
          {needsClarity && (
            <>
              <feGaussianBlur
                in={needsSharp ? "sharpened" : postToneResult}
                stdDeviation="8"
                result="clarBlur"
              />
              <feComposite
                in={needsSharp ? "sharpened" : postToneResult}
                in2="clarBlur"
                operator="arithmetic"
                k1="0"
                k2={clarK2}
                k3={`-${clarAmt}`}
                k4="0"
              />
            </>
          )}
        </filter>
      </defs>
    </svg>
  );
}

// ─── Slider ────────────────────────────────────────────────────────────────

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultVal?: number;
  onChange: (v: number) => void;
}

function Slider({ label, value, min, max, step = 1, defaultVal = 0, onChange }: SliderProps) {
  return (
    <div className={css.sliderRow}>
      <div className={css.sliderHeader}>
        <span className={css.sliderLabel}>{label}</span>
        {value !== defaultVal && (
          <button
            type="button"
            className={css.sliderReset}
            onClick={() => onChange(defaultVal)}
            aria-label={`Reset ${label}`}
            title="Reset"
          >
            ↺
          </button>
        )}
        <span className={css.sliderValue}>{value > 0 ? `+${value}` : String(value)}</span>
      </div>
      <input
        type="range"
        className={css.sliderInput}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(defaultVal)}
      />
    </div>
  );
}

// ─── CropBox ───────────────────────────────────────────────────────────────

interface CropBoxProps {
  top: number;
  right: number;
  bottom: number;
  left: number;
  rotationDeg: number;
  minCrop: { top: number; right: number; bottom: number; left: number };
  onChange: (crop: { top: number; right: number; bottom: number; left: number }) => void;
}

function CropBox({ top, right, bottom, left, rotationDeg, minCrop, onChange }: CropBoxProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    handle: string;
    startX: number;
    startY: number;
    startTop: number;
    startRight: number;
    startBottom: number;
    startLeft: number;
    containerW: number;
    containerH: number;
  } | null>(null);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, handle: string) => {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const container = containerRef.current;
      if (!container) return;
      dragRef.current = {
        handle,
        startX: e.clientX,
        startY: e.clientY,
        startTop: top,
        startRight: right,
        startBottom: bottom,
        startLeft: left,
        containerW: container.clientWidth,
        containerH: container.clientHeight,
      };
    },
    [top, right, bottom, left],
  );

  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const ds = dragRef.current;
      if (!ds) return;
      e.preventDefault();

      const screenDx = e.clientX - ds.startX;
      const screenDy = e.clientY - ds.startY;

      // Inverse-rotate mouse delta to local (pre-rotation) image space
      const θ = -rotationDeg * Math.PI / 180;
      const ldx = screenDx * Math.cos(θ) - screenDy * Math.sin(θ);
      const ldy = screenDx * Math.sin(θ) + screenDy * Math.cos(θ);

      const pctX = (ldx / ds.containerW) * 100;
      const pctY = (ldy / ds.containerH) * 100;

      const h = ds.handle;
      let newTop = ds.startTop;
      let newRight = ds.startRight;
      let newBottom = ds.startBottom;
      let newLeft = ds.startLeft;

      if (h.includes("t")) newTop = Math.max(minCrop.top, Math.min(49, ds.startTop + pctY));
      if (h.includes("b")) newBottom = Math.max(minCrop.bottom, Math.min(49, ds.startBottom - pctY));
      if (h.includes("l")) newLeft = Math.max(minCrop.left, Math.min(49, ds.startLeft + pctX));
      if (h.includes("r")) newRight = Math.max(minCrop.right, Math.min(49, ds.startRight - pctX));

      onChange({ top: newTop, right: newRight, bottom: newBottom, left: newLeft });
    },
    [rotationDeg, minCrop, onChange],
  );

  const onHandlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const makeHandle = (pos: string, style: React.CSSProperties) => (
    <div
      key={pos}
      className={css.cropHandle}
      style={style}
      onPointerDown={(e) => onHandlePointerDown(e, pos)}
      onPointerMove={onHandlePointerMove}
      onPointerUp={onHandlePointerUp}
    />
  );

  // Derived positions (from-left / from-top in %) for handles
  const tPct = top;
  const bPct = 100 - bottom;
  const lPct = left;
  const rPct = 100 - right;
  const midX = (lPct + rPct) / 2;
  const midY = (tPct + bPct) / 2;

  return (
    <div
      ref={containerRef}
      className={css.cropOverlay}
      style={rotationDeg !== 0 ? { transform: `rotate(${rotationDeg}deg)` } : undefined}
    >
      {/* Shadow over cropped areas */}
      <div className={css.cropShadow} style={{ top: 0, left: 0, right: 0, height: `${tPct}%` }} />
      <div className={css.cropShadow} style={{ bottom: 0, left: 0, right: 0, height: `${100 - bPct}%` }} />
      <div className={css.cropShadow} style={{ top: `${tPct}%`, bottom: `${100 - bPct}%`, left: 0, width: `${lPct}%` }} />
      <div className={css.cropShadow} style={{ top: `${tPct}%`, bottom: `${100 - bPct}%`, right: 0, width: `${100 - rPct}%` }} />
      {/* Crop border */}
      <div
        className={css.cropBorder}
        style={{ top: `${tPct}%`, left: `${lPct}%`, width: `${rPct - lPct}%`, height: `${bPct - tPct}%` }}
      />
      {/* Corner handles */}
      {makeHandle("tl", { top: `${tPct}%`, left: `${lPct}%`, cursor: "nwse-resize" })}
      {makeHandle("tr", { top: `${tPct}%`, left: `${rPct}%`, cursor: "nesw-resize" })}
      {makeHandle("bl", { top: `${bPct}%`, left: `${lPct}%`, cursor: "nesw-resize" })}
      {makeHandle("br", { top: `${bPct}%`, left: `${rPct}%`, cursor: "nwse-resize" })}
      {/* Edge handles */}
      {makeHandle("t", { top: `${tPct}%`, left: `${midX}%`, cursor: "ns-resize" })}
      {makeHandle("b", { top: `${bPct}%`, left: `${midX}%`, cursor: "ns-resize" })}
      {makeHandle("l", { top: `${midY}%`, left: `${lPct}%`, cursor: "ew-resize" })}
      {makeHandle("r", { top: `${midY}%`, left: `${rPct}%`, cursor: "ew-resize" })}
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────

interface PhotoEditorProps {
  photoName: string;
  photoFullUrl: string;
  imageAspectRatio?: number;
  cropContainerEl?: HTMLElement | null;
  initialAdj?: EditAdj;
  onAdjChange: (adj: EditAdj) => void;
  onClose: () => void;
  onCropActiveChange?: (active: boolean) => void;
}

export function PhotoEditor({
  photoName,
  photoFullUrl,
  imageAspectRatio = 1,
  cropContainerEl,
  initialAdj,
  onAdjChange,
  onClose,
  onCropActiveChange,
}: PhotoEditorProps) {
  const [adj, setAdj] = useState<EditAdj>(initialAdj ?? DEFAULT_ADJ);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [hideEdits, setHideEdits] = useState(false);
  const [cropActive, setCropActive] = useState(false);
  const [autoApplying, setAutoApplying] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);

  const update = useCallback(<K extends keyof EditAdj>(key: K, val: EditAdj[K]) => {
    setAdj((prev) => ({ ...prev, [key]: val }));
  }, []);

  // Auto-crop when rotation changes to prevent empty corners
  useEffect(() => {
    const effectiveAR = adj.rotate90 % 2 !== 0 ? 1 / imageAspectRatio : imageAspectRatio;
    const crop = computeAlignCrop(adj.rotation, effectiveAR);
    setAdj((prev) => ({
      ...prev,
      cropTop: crop.top,
      cropRight: crop.right,
      cropBottom: crop.bottom,
      cropLeft: crop.left,
    }));
  }, [adj.rotation, adj.rotate90, imageAspectRatio]);

  useEffect(() => {
    onAdjChange(hideEdits ? DEFAULT_ADJ : adj);
  }, [adj, onAdjChange, hideEdits]);

  useEffect(() => {
    onCropActiveChange?.(cropActive);
  }, [cropActive, onCropActiveChange]);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await exportEdited(photoFullUrl, photoName, adj);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const handleAuto = async () => {
    setAutoApplying(true);
    setAutoError(null);
    try {
      const auto = await computeAutoAdjustments(photoFullUrl);
      setAdj((prev) => ({ ...prev, ...auto }));
    } catch (e) {
      setAutoError(e instanceof Error ? e.message : "Auto enhance failed");
    } finally {
      setAutoApplying(false);
    }
  };

  const dirty = isDirty(adj);
  const hasCrop = adj.cropTop > 0 || adj.cropRight > 0 || adj.cropBottom > 0 || adj.cropLeft > 0;
  const showCropBox = cropActive && !!cropContainerEl;

  const effectiveAR = adj.rotate90 % 2 !== 0 ? 1 / imageAspectRatio : imageAspectRatio;
  const minCrop = computeAlignCrop(adj.rotation, effectiveAR);
  const totalRotationDeg = adj.rotation + adj.rotate90 * 90;

  const resetCrop = () => {
    setAdj((prev) => ({
      ...prev,
      cropTop: minCrop.top,
      cropRight: minCrop.right,
      cropBottom: minCrop.bottom,
      cropLeft: minCrop.left,
    }));
  };

  return (
    <>
      {showCropBox && cropContainerEl &&
        createPortal(
          <CropBox
            top={adj.cropTop}
            right={adj.cropRight}
            bottom={adj.cropBottom}
            left={adj.cropLeft}
            rotationDeg={totalRotationDeg}
            minCrop={minCrop}
            onChange={(crop) =>
              setAdj((prev) => ({
                ...prev,
                cropTop: crop.top,
                cropRight: crop.right,
                cropBottom: crop.bottom,
                cropLeft: crop.left,
              }))
            }
          />,
          cropContainerEl,
        )}

      <aside className={css.editorPanel} aria-label="Photo editor">
        <div className={css.editorHeader}>
          <span className={css.editorTitle}>Edit Photo</span>
          <div className={css.headerActions}>
            {dirty && (
              <button
                type="button"
                className={css.hideEditsBtn}
                title={hideEdits ? "Show edits" : "Compare with original"}
                onClick={() => setHideEdits((v) => !v)}
              >
                {hideEdits ? <EyeOff24Regular /> : <Eye24Regular />}
              </button>
            )}
            {dirty && (
              <button
                type="button"
                className={css.resetAllBtn}
                onClick={() => { setAdj(DEFAULT_ADJ); setHideEdits(false); }}
                title="Reset all adjustments"
              >
                <ImageArrowCounterclockwise24Regular />
                Reset
              </button>
            )}
            <button
              type="button"
              className={css.closeBtn}
              onClick={onClose}
              aria-label="Close editor"
              title="Done editing"
            >
              <Dismiss24Regular />
            </button>
          </div>
        </div>

        <div className={css.editorBody}>
          <div className={css.autoRow}>
            <button
              type="button"
              className={css.autoBtn}
              onClick={handleAuto}
              disabled={autoApplying}
              title="Automatically balance color and tone (white balance, exposure, contrast, vibrance)"
            >
              <Wand24Regular />
              {autoApplying ? "Analyzing…" : "Auto"}
            </button>
            {autoError && <p className={css.autoError}>{autoError}</p>}
          </div>

          <section className={css.section}>
            <h4 className={css.sectionTitle}>Light</h4>
            <Slider label="Exposure" value={adj.exposure} min={-100} max={100} onChange={(v) => update("exposure", v)} />
            <Slider label="Contrast" value={adj.contrast} min={-100} max={100} onChange={(v) => update("contrast", v)} />
            <Slider label="Highlights" value={adj.highlights} min={-100} max={100} onChange={(v) => update("highlights", v)} />
            <Slider label="Shadows" value={adj.shadows} min={-100} max={100} onChange={(v) => update("shadows", v)} />
          </section>

          <section className={css.section}>
            <h4 className={css.sectionTitle}>Color</h4>
            <Slider label="Saturation" value={adj.saturation} min={-100} max={100} onChange={(v) => update("saturation", v)} />
            <Slider label="Vibrance" value={adj.vibrance} min={-100} max={100} onChange={(v) => update("vibrance", v)} />
            <Slider label="Temperature" value={adj.temperature} min={-100} max={100} onChange={(v) => update("temperature", v)} />
            <Slider label="Tint" value={adj.tint} min={-100} max={100} onChange={(v) => update("tint", v)} />
          </section>

          <section className={css.section}>
            <h4 className={css.sectionTitle}>Detail</h4>
            <Slider label="Clarity" value={adj.clarity} min={0} max={100} onChange={(v) => update("clarity", v)} />
            <Slider label="Dehaze" value={adj.dehaze} min={-100} max={100} onChange={(v) => update("dehaze", v)} />
            <Slider label="Sharpness" value={adj.sharpness} min={0} max={100} onChange={(v) => update("sharpness", v)} />
          </section>

          <section className={css.section}>
            <h4 className={css.sectionTitle}>Effects</h4>
            <Slider
              label="Vignette"
              value={adj.vignette}
              min={-100}
              max={100}
              onChange={(v) => update("vignette", v)}
            />
          </section>

          <section className={css.section}>
            <h4 className={css.sectionTitle}>Transform</h4>
            <Slider
              label="Align"
              value={adj.rotation}
              min={-45}
              max={45}
              step={0.5}
              onChange={(v) => update("rotation", v)}
            />
            <div className={css.buttonRow}>
              <button
                type="button"
                className={css.transformBtn}
                onClick={() => update("rotate90", (adj.rotate90 + 1) % 4)}
                title="Rotate 90° clockwise"
              >
                <RotateRight24Regular /> Rotate CW
              </button>
            </div>
          </section>

          <section className={css.section}>
            <h4 className={css.sectionTitle}>
              <Crop24Regular style={{ verticalAlign: "middle", marginRight: 4 }} />
              Crop
              <button
                type="button"
                className={`${css.cropToggleBtn} ${cropActive ? css.cropToggleBtnActive : ""}`}
                onClick={() => setCropActive((v) => !v)}
                title={cropActive ? "Hide crop box" : "Show crop box"}
              >
                {cropActive ? "Done" : "Edit"}
              </button>
            </h4>
            {showCropBox ? (
              <p className={css.cropHint}>Drag the handles on the image to adjust crop.</p>
            ) : (
              <p className={css.cropHint}>
                {cropContainerEl
                  ? "Click Edit to adjust crop, or use Align to auto-crop."
                  : "Crop box appears on the image when editing."}
              </p>
            )}
            {hasCrop && (
              <button
                type="button"
                className={css.resetCropBtn}
                onClick={resetCrop}
                title="Reset to minimum crop required by alignment"
              >
                Reset crop
              </button>
            )}
          </section>
        </div>

        <div className={css.editorFooter}>
          {exportError && <p className={css.exportError}>{exportError}</p>}
          <button
            type="button"
            className={css.exportBtn}
            onClick={handleExport}
            disabled={exporting || !dirty}
            title={dirty ? "Download edited JPEG at full resolution" : "Make adjustments first"}
          >
            <ArrowDownload24Regular />
            {exporting ? "Exporting…" : "Download Edited"}
          </button>
        </div>
      </aside>
    </>
  );
}
