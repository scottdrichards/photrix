import type { EditAdj } from "./editAdj";
import { applyPixelAdj } from "./applyPixelAdj";

const PREVIEW_MAX_EDGE = 1200;

// Draws the full, uncropped, unrotated image (pixel adjustments only — tone,
// color, dehaze, clarity/sharpness convolution, vignette). Rotation, flip,
// and crop are applied afterward as CSS on the canvas element itself, so the
// canvas/frame never resizes based on the crop or rotation angle — it stays
// the one stable coordinate space the crop-box overlay's handle math expects.
export function drawEditPreview(canvas: HTMLCanvasElement, img: HTMLImageElement, adj: EditAdj) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (iw === 0 || ih === 0) return;

  const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(iw, ih));
  const pw = Math.max(1, Math.round(iw * scale));
  const ph = Math.max(1, Math.round(ih * scale));

  canvas.width = pw;
  canvas.height = ph;

  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, pw, ph);

  const imageData = ctx.getImageData(0, 0, pw, ph);
  applyPixelAdj(imageData.data, pw, ph, adj);
  ctx.putImageData(imageData, 0, 0);
}
