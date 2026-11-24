import sharp from "sharp";
import { FaceIdentifyInputError } from "./inputError.ts";

export type CropRect = { left: number; top: number; width: number; height: number };

/**
 * Default padding added around a supplied crop box, as a fraction of the box.
 *
 * A caller's box bounds the *subject* (a person), and it is usually the box
 * from one moment of a moving subject. Padding covers the drift and, more
 * importantly, gives the detector context around the head — a box cut tight to
 * a torso can clip the very face we are looking for.
 */
export const DEFAULT_CROP_PAD = 0.3;

/**
 * Crops to a normalized [x, y, width, height] box, padded.
 *
 * This exists because of how InsightFace sizes its input: the detector runs at
 * 640x640, so handing it a 2560x1920 frame downscales a distant face to a
 * dozen pixels and finds nothing at all — measured on this doorbell, the
 * full-resolution frame yielded zero detections while the same frame cropped to
 * the person yielded a 180x290px face. Cropping is what converts "more
 * megapixels" into "more face pixels".
 *
 * Face boxes in the response are normalized against the *cropped* image, not
 * the original frame; the crop rect is reported per frame so a caller that
 * needs original-frame coordinates can map back.
 */
export const cropToBox = async (
  bytes: Buffer,
  box: readonly number[],
  pad: number,
): Promise<{ bytes: Buffer; rect: CropRect }> => {
  const [bx, by, bw, bh] = box;
  const { width, height } = await sharp(bytes).metadata();
  if (!width || !height) throw new FaceIdentifyInputError("Could not read frame dimensions to crop");

  const left = Math.max(0, Math.round((bx - bw * pad) * width));
  const top = Math.max(0, Math.round((by - bh * pad) * height));
  const right = Math.min(width, Math.round((bx + bw * (1 + pad)) * width));
  const bottom = Math.min(height, Math.round((by + bh * (1 + pad)) * height));
  const rect = { left, top, width: right - left, height: bottom - top };
  if (rect.width < 1 || rect.height < 1) {
    throw new FaceIdentifyInputError(`Crop box ${JSON.stringify(box)} is empty for this frame`);
  }
  // Rotation is baked in first: an EXIF-rotated frame would otherwise have its
  // crop applied to the unrotated pixels.
  return { bytes: await sharp(bytes).rotate().extract(rect).toBuffer(), rect };
};

/**
 * Long edge the Python worker caps its decode at (`MAX_DECODE_EDGE` there).
 * Face boxes come back normalized, so turning one into a pixel size means
 * knowing the size the worker actually decoded at, not the size on disk.
 */
const WORKER_MAX_DECODE_EDGE = 2048;

/** Size the worker will have decoded this image at, for the face-size gate. */
export const decodedSizeOf = async (
  bytes: Buffer,
): Promise<{ width: number; height: number } | undefined> => {
  try {
    const { width, height } = await sharp(bytes).metadata();
    if (!width || !height) return undefined;
    const scale = Math.min(1, WORKER_MAX_DECODE_EDGE / Math.max(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  } catch {
    // Unreadable header is not fatal: the detector may still cope, and the
    // caller gets a face with no size gate rather than no answer at all.
    return undefined;
  }
};
