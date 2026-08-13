/**
 * Constants and pure math for "moment" clustering: grouping burst shots / near-
 * identical frames of the same moment so the gallery can collapse them into one
 * stack.
 *
 * Deliberately much simpler than `faceClusterEngine.ts`: face clustering has to
 * find a matching centroid *anywhere* in the whole library, so it maintains
 * persisted centroids for every cluster and searches them. Moment clustering
 * only ever needs to compare a photo against its immediate *temporal*
 * neighbors — two photos three years apart can never be the same moment no
 * matter how similar their embeddings — so the engine below is a single
 * forward pass over files in `dateTaken` order, chaining a photo onto the
 * current open cluster (or starting a new one) rather than searching anything.
 */

/**
 * Two consecutive photos more than this far apart in capture time are never
 * considered the same moment, regardless of visual similarity. Deliberately
 * looser than a true burst-mode interval (tens of milliseconds) — this is also
 * meant to catch a handful of deliberate retakes of a posed shot ("everyone
 * blinked, take it again"), which realistically span a few seconds, not
 * milliseconds. Loose enough to catch that, tight enough that two unrelated
 * photos of the same static scene taken minutes apart don't chain.
 */
export const MOMENT_WINDOW_MS = 15_000;

/**
 * Cosine similarity floor (over the CLIP image embedding already stored in
 * `fileEmbeddings.imageEmbedding` — no new embedding is computed) for two
 * photos to be considered the same moment.
 *
 * CLIP embeddings are coarse whole-scene descriptors, not a duplicate-detector,
 * so this has to sit well above typical "same subject, different photo"
 * similarity. The design intent (see task decision notes) is specifically that
 * two people photographing the same scene from different angles must NOT
 * cluster — different angles/framing change enough of the frame that CLIP
 * similarity drops measurably below true burst duplicates, which is what this
 * threshold is leaning on. Chosen conservatively pending calibration against a
 * real library (no labelled burst/non-burst sample was available to tune
 * against); if real usage shows misses or false joins, adjust here — like
 * `FACE_CLUSTER_SIMILARITY_THRESHOLD`, this is a single tunable constant.
 */
export const MOMENT_VISUAL_SIMILARITY_THRESHOLD = 0.93;

/**
 * Weight given to a photo's `photoQualityScore` (smiling/eyes-open/focus/
 * exposure aggregate, see faceDetection/photoQuality.ts) relative to its
 * min-max-normalized sharpness when ranking cluster members for the
 * representative pick. Sharpness is the primary signal (weight 1); this is
 * additive on top of it, not a replacement — a photo with no scored faces
 * (photoQualityScore null) is ranked on sharpness alone.
 */
export const REPRESENTATIVE_QUALITY_BONUS_WEIGHT = 0.5;

/** Unit vector dot product == cosine similarity (embeddingCodec's decode
 * re-normalizes to unit length, so no extra magnitude division is needed). */
export const dot = (a: Float32Array, b: Float32Array): number => {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += a[i] * b[i];
  return sum;
};

/**
 * Cosine similarity between a candidate embedding and a running (unnormalized)
 * centroid sum — same running-mean shape as `faceClusters.centroid`. Comparing
 * against the whole chain's centroid (rather than just the immediately
 * previous photo) makes the cluster resilient to one slightly-off frame in a
 * long burst without letting the chain drift arbitrarily, since the window/
 * threshold gates every join independently too.
 */
export const centroidSimilarity = (
  centroidSum: Float32Array,
  weight: number,
  candidate: Float32Array,
): number => {
  if (weight <= 0) return -1;
  let magnitudeSquared = 0;
  const length = Math.min(centroidSum.length, candidate.length);
  for (let i = 0; i < length; i += 1) {
    const v = centroidSum[i] / weight;
    magnitudeSquared += v * v;
  }
  if (!(magnitudeSquared > 0)) return -1;
  const magnitude = Math.sqrt(magnitudeSquared);
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    sum += (centroidSum[i] / weight / magnitude) * candidate[i];
  }
  return sum;
};

/** Folds a newly-joined member's unit embedding into a running centroid sum. */
export const foldIntoCentroid = (
  centroidSum: Float32Array,
  candidate: Float32Array,
): Float32Array => {
  const out = new Float32Array(Math.max(centroidSum.length, candidate.length));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (centroidSum[i] ?? 0) + (candidate[i] ?? 0);
  }
  return out;
};

export type MomentMember = {
  folder: string;
  fileName: string;
  sharpnessScore: number | null;
  photoQualityScore: number | null;
};

/**
 * Picks the representative member of a moment cluster: min-max normalize
 * sharpness across the members that have a score (members with no sharpness
 * signal — an unreadable file — are ranked last, never treated as the
 * sharpest), then add each member's `photoQualityScore` (already blends
 * smiling/eyes-open/focus/exposure — see photoQuality.ts) as a bonus.
 *
 * Returns null only when `members` is empty.
 */
export const pickRepresentative = (members: MomentMember[]): MomentMember | null => {
  if (members.length === 0) return null;
  if (members.length === 1) return members[0];

  const sharpnessValues = members
    .map((m) => m.sharpnessScore)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const minSharpness = sharpnessValues.length ? Math.min(...sharpnessValues) : 0;
  const maxSharpness = sharpnessValues.length ? Math.max(...sharpnessValues) : 0;
  const sharpnessRange = maxSharpness - minSharpness;

  const scored = members.map((member) => {
    const normalizedSharpness =
      typeof member.sharpnessScore === "number" && Number.isFinite(member.sharpnessScore)
        ? sharpnessRange > 0
          ? (member.sharpnessScore - minSharpness) / sharpnessRange
          : 1 // every scored member is equally sharp
        : 0; // unknown sharpness ranks last, not "blurriest"
    const qualityBonus =
      typeof member.photoQualityScore === "number"
        ? member.photoQualityScore * REPRESENTATIVE_QUALITY_BONUS_WEIGHT
        : 0;
    return { member, score: normalizedSharpness + qualityBonus };
  });

  return scored.reduce((best, current) => (current.score > best.score ? current : best))
    .member;
};
