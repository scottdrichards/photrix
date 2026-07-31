import { dotProduct, toAlignedFloat32 } from "../indexDatabase/faceClusterEngine.ts";
import type { DetectedFace } from "./faceDetector.type.ts";

/**
 * Matching a *live* face (doorbell frame, phone snap) against the named people
 * already clustered out of the photo library.
 *
 * This is deliberately NOT the clustering path. Clustering asks "do these two
 * library faces belong together", answered at
 * `FACE_CLUSTER_SIMILARITY_THRESHOLD` (0.62) against a centroid the face is
 * about to join. Identification asks "which of ~30 known people is this",
 * against a centroid built from hundreds of well-lit library photos, using a
 * face pulled off an outdoor camera at whatever angle the person happened to
 * walk in at. Cross-domain pairs score far lower than library-to-library ones,
 * so the two questions need different operating points — see the constants
 * below for what the doorbell footage actually measured.
 */

/**
 * Cosine similarity floor for reporting a name.
 *
 * Measured over doorbell footage against this library: correct matches scored
 * 0.216-0.364 and strangers 0.108-0.170 — nothing like the 0.62 that library
 * faces reach against each other, because a 4 MP outdoor frame at 10 m is a
 * different imaging domain than a phone photo. This sits under the true matches
 * and above most strangers, but it is deliberately NOT the main defence: a
 * 6x9-pixel junk detection in the same sample scored 0.252, higher than a real
 * match. `MIN_MARGIN` is what actually separates signal from noise.
 */
export const DEFAULT_IDENTIFY_THRESHOLD = 0.2;

/**
 * How far the best candidate must beat the runner-up, for a *moderate* match.
 *
 * A face the model has no real opinion about — too small, too blurred, turned
 * away — lands near-equidistant from everybody, so its top scores bunch
 * together no matter how high they are in absolute terms. Measured junk
 * detections sat at 0.004-0.018 margin; moderate true matches at 0.085-0.098.
 *
 * On its own this over-rejects, which is why `DEFAULT_STRONG_THRESHOLD` exists:
 * the runner-up is usually a sibling or parent, so a genuinely good match
 * against one family member is *expected* to score close against the others.
 * A measured true match at 0.381 similarity had a margin of only 0.034 — the
 * right answer, nearly rejected for resembling its own relatives.
 */
export const DEFAULT_MIN_MARGIN = 0.05;

/**
 * Similarity that stands on its own, no margin required.
 *
 * The two gates guard different failure modes and neither subsumes the other,
 * which the measurements show plainly:
 *
 * | sample | similarity | margin | truth |
 * |---|---|---|---|
 * | known person, close up | 0.381 | 0.034 | correct — margin alone rejects it |
 * | known person, mid range | 0.266-0.284 | 0.085-0.098 | correct |
 * | stranger | 0.192 | 0.075 | wrong — margin alone *accepts* it |
 * | stranger | 0.114 | 0.030 | wrong |
 * | junk detection | 0.252 | 0.006 | wrong — similarity alone accepts it |
 *
 * So a name is reported when the match is strong outright, or moderate *and*
 * clearly ahead of the runner-up. That rule classifies every sample above
 * correctly; either gate used alone misclassifies at least one.
 */
export const DEFAULT_STRONG_THRESHOLD = 0.3;

/**
 * InsightFace `det_score` below which a detection is not treated as a face at
 * all.
 *
 * Lower than the 0.7 the clustering path uses. Clustering can afford to be
 * picky because it sees the same person across thousands of library photos and
 * only needs the good ones; a doorbell gets one visit and a handful of frames,
 * and a correct match measured here sat at det 0.66. The similarity and margin
 * gates below are what reject nonsense, so this floor only has to exclude the
 * detections that are plainly not faces (measured junk: 0.57-0.58).
 */
export const DEFAULT_MIN_FACE_CONFIDENCE = 0.6;

/**
 * Smallest face, in decoded pixels on the shorter side, worth scoring.
 *
 * A cheap prefilter rather than a precise one — the margin gate already rejects
 * what these produce. Real matches in the doorbell sample measured 42-290 px
 * while the detections that were plainly not faces measured 6-23 px, so this
 * cuts the obvious junk before it reaches the ranking and keeps the logs
 * readable.
 */
export const DEFAULT_MIN_FACE_PIXELS = 32;

/** Candidates returned per face, best first. */
const MAX_CANDIDATES = 5;

export type NamedCentroid = {
  clusterId: number;
  name: string;
  /** Raw `faceClusters.centroid` BLOB: Float32, unnormalized running mean. */
  centroid: Buffer | Uint8Array;
};

/** A centroid with its magnitude precomputed, ready for the hot loop. */
export type PreparedCentroid = {
  clusterId: number;
  name: string;
  mean: Float32Array;
  magnitude: number;
};

export type Candidate = { name: string; similarity: number; clusterId: number };

/** Why a face that was scored did not get a name. */
export type Rejection = "threshold" | "margin" | "tooSmall" | null;

export type IdentifiedFace = {
  /** Normalized 0..1 against the source image, same convention as DetectedFace. */
  box: DetectedFace["box"];
  /** Detector's is-this-a-face score. */
  confidence: number;
  /** Best match that cleared every gate, else null ("a face, but nobody known"). */
  name: string | null;
  /** Cosine similarity of the best candidate, whether or not it cleared the bar. */
  similarity: number;
  /** Best minus runner-up. Infinity when only one person is known. */
  margin: number;
  /** Which gate turned a candidate away, or null when `name` is set. */
  rejectedFor: Rejection;
  /** Face size in decoded pixels, when the image dimensions were known. */
  facePixels?: { width: number; height: number };
  candidates: Candidate[];
};

export type IdentifyOptions = {
  threshold?: number;
  strongThreshold?: number;
  minMargin?: number;
  minFaceConfidence?: number;
  minFacePixels?: number;
  /**
   * Dimensions of the image as the worker decoded it. Supplied, faces are
   * measured in pixels and the size gate applies; omitted, the size gate is
   * skipped rather than guessed at.
   */
  decodedSize?: { width: number; height: number };
};

/**
 * Normalizes the raw centroid BLOBs once per refresh so a burst of requests
 * doesn't recompute magnitudes for every face it scores.
 */
export const prepareCentroids = (rows: NamedCentroid[]): PreparedCentroid[] => {
  const prepared: PreparedCentroid[] = [];
  for (const row of rows) {
    if (row.centroid.byteLength === 0 || row.centroid.byteLength % 4 !== 0) continue;
    const mean = toAlignedFloat32(row.centroid);
    let magnitudeSquared = 0;
    for (let i = 0; i < mean.length; i += 1) magnitudeSquared += mean[i] * mean[i];
    // A cluster whose member vectors cancelled to ~zero has no usable direction;
    // scoring against it yields NaN, so drop it rather than poison the ranking.
    if (magnitudeSquared <= 0) continue;
    prepared.push({
      clusterId: row.clusterId,
      name: row.name,
      mean,
      magnitude: Math.sqrt(magnitudeSquared),
    });
  }
  return prepared;
};

/** Float64 detection embedding -> Float32 unit vector, or null if degenerate. */
const toUnitVector = (embedding: Float64Array): Float32Array | null => {
  let magnitudeSquared = 0;
  for (let i = 0; i < embedding.length; i += 1) {
    magnitudeSquared += embedding[i] * embedding[i];
  }
  if (magnitudeSquared <= 0) return null;
  const magnitude = Math.sqrt(magnitudeSquared);
  const unit = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i += 1) unit[i] = embedding[i] / magnitude;
  return unit;
};

/**
 * Scores every detected face against every known person.
 *
 * People, not clusters, are the unit of the answer: a person who was built by
 * merging several clusters has several centroids (a beard year, a childhood),
 * and a live face only has to resemble *one* of them. So per-cluster scores are
 * collapsed by name taking the max before ranking.
 */
export const identifyFaces = (
  faces: DetectedFace[],
  centroids: PreparedCentroid[],
  options: IdentifyOptions = {},
): IdentifiedFace[] => {
  const threshold = options.threshold ?? DEFAULT_IDENTIFY_THRESHOLD;
  const strongThreshold = options.strongThreshold ?? DEFAULT_STRONG_THRESHOLD;
  const minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN;
  const minFaceConfidence = options.minFaceConfidence ?? DEFAULT_MIN_FACE_CONFIDENCE;
  const minFacePixels = options.minFacePixels ?? DEFAULT_MIN_FACE_PIXELS;
  const decoded = options.decodedSize;

  const results: IdentifiedFace[] = [];
  for (const face of faces) {
    if (face.confidence < minFaceConfidence) continue;
    const unit = toUnitVector(face.embedding);
    if (!unit) continue;

    const facePixels = decoded
      ? {
          width: Math.round(face.box.width * decoded.width),
          height: Math.round(face.box.height * decoded.height),
        }
      : undefined;
    const tooSmall =
      facePixels !== undefined &&
      Math.min(facePixels.width, facePixels.height) < minFacePixels;

    const bestByName = new Map<string, Candidate>();
    for (const centroid of centroids) {
      const similarity = dotProduct(unit, centroid.mean) / centroid.magnitude;
      const existing = bestByName.get(centroid.name);
      if (!existing || similarity > existing.similarity) {
        bestByName.set(centroid.name, {
          name: centroid.name,
          similarity,
          clusterId: centroid.clusterId,
        });
      }
    }

    const ranked = [...bestByName.values()].sort((a, b) => b.similarity - a.similarity);
    const best = ranked[0];
    const runnerUp = ranked[1];
    const similarity = best?.similarity ?? 0;
    const margin = best && runnerUp ? best.similarity - runnerUp.similarity : Infinity;

    // Gates are ordered cheapest-excuse-first so `rejectedFor` names the most
    // fundamental reason: a 9-pixel face is "too small", not "below threshold".
    // A strong-enough similarity skips the margin check outright — see
    // DEFAULT_STRONG_THRESHOLD for why resembling your own relatives must not
    // count against you.
    let rejectedFor: Rejection = null;
    if (!best) rejectedFor = "threshold";
    else if (tooSmall) rejectedFor = "tooSmall";
    else if (similarity < threshold) rejectedFor = "threshold";
    else if (similarity < strongThreshold && margin < minMargin) rejectedFor = "margin";

    results.push({
      box: face.box,
      confidence: face.confidence,
      name: rejectedFor === null && best ? best.name : null,
      similarity,
      margin,
      rejectedFor,
      ...(facePixels ? { facePixels } : {}),
      candidates: ranked.slice(0, MAX_CANDIDATES),
    });
  }

  // Biggest face first: for a doorbell the subject is the near face, and a
  // caller that only looks at the first result should get the person at the
  // door rather than whoever is on the sidewalk behind them.
  results.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
  return results;
};
