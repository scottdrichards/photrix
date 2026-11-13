/**
 * How much context to include around the detected face, as a fraction of the
 * face's own size added on every side. 0.6 → the crop is ~2.2× the face box, so
 * there's headroom for hair/chin without shrinking the face too far.
 */
export const FACE_CROP_PADDING = 0.6;

/** The pixel height the People list and the face filter ask for. */
export const FACE_CROP_HEIGHT = 320;

/** A detected face: its centre and size, as fractions of the photo. */
export type FaceBox = { x: number; y: number; width: number; height: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The padded face region a face crop shows: top-left and size, as fractions of the photo. */
export const faceCropRegion = (box: FaceBox) => {
  const grow = 1 + 2 * FACE_CROP_PADDING;
  const w = clamp01(box.width * grow);
  const h = clamp01(box.height * grow);
  const x = clamp01(Math.min(Math.max(box.x - w / 2, 0), 1 - w));
  const y = clamp01(Math.min(Math.max(box.y - h / 2, 0), 1 - h));
  return { x, y, w, h };
};
