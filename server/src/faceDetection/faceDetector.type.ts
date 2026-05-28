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
export type DetectedFace = {
  box: { x: number; y: number; width: number; height: number };
  confidence: number;
  embedding: Float64Array;
};

/** Returns [] when none found. */
export type DetectFaces = (imagePath: string) => Promise<DetectedFace[]>;
