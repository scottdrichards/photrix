/**
 * Public face detection interface used by the background task runner.
 *
 * Boxes are normalized 0..1 against the original image dimensions so they can
 * be compared directly with EXIF `Regions` data and rendered by the existing
 * client `FaceOverlay` without knowing the source resolution.
 *
 * Embeddings are stored as Float64Array so they line up with the existing
 * `cosine_similarity` SQLite function (which expects Float64Array-backed
 * BLOBs).
 */
/**
 * "Photo ready" attributes for a single face, each 0..1. Every field is
 * optional: an absent field means *unknown* (the attribute could not be judged
 * for this face), which is stored as NULL and must never be treated as a low
 * score. See `server/python/face_attributes.py` for how each is derived.
 */
export type FaceAttributes = {
  smile?: number;
  eyesOpen?: number;
  focus?: number;
  exposure?: number;
};

export type DetectedFace = {
  box: { x: number; y: number; width: number; height: number };
  confidence: number;
  embedding: Float64Array;
  attributes?: FaceAttributes;
};

/** Returns [] when none found. */
export type DetectFaces = (imagePath: string) => Promise<DetectedFace[]>;
