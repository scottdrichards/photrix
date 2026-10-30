import { getAuthHeaders } from "../../../auth";
import { type EditAdj, VIGNETTE_INNER_RADIUS, vignetteStrength } from "./editAdj";

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

export async function exportEdited(fullUrl: string, photoName: string, adj: EditAdj) {
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
