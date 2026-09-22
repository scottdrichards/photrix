import { planSplit } from "./faceReview.ts";

/**
 * The geometry of a face cluster: a centre and a distance.
 *
 * A cluster is a **spherical cap** — a centre direction plus a similarity floor,
 * where a face belongs iff `dot(face, centre) >= minSimilarity`. Embeddings are
 * unit vectors, so "distance" here is an angle on the unit sphere and a cap is
 * the sphere's equivalent of a ball.
 *
 * Note the sign convention, which is easy to trip over: `minSimilarity` is a
 * *floor on similarity*, so a **larger** value is a **smaller** cap. It matches
 * the `faceClusters.radius` column, which the assignment gate already compares
 * against directly. Internally every operation converts to angles (where bigger
 * really does mean bigger) and converts back at the end.
 *
 * Three operations, and they are meant to be used together:
 *
 * - `growCapToInclude` — take in a face that should belong, moving the centre
 *   *towards* it rather than inflating symmetrically.
 * - `shrinkCapToExclude` — push a face out, by the smallest amount that does it.
 * - `refitCaps` — recompute centre and radius from the members that survived,
 *   splitting into several caps when one cannot hold them without also
 *   swallowing faces that were rejected.
 *
 * Grow and shrink both only ever move the boundary; repeated use accumulates
 * slack the cluster never gives back. `refitCaps` is what returns it, so an
 * edit path that grows or shrinks should refit afterwards.
 */

export type Cap = {
  /** Unit-length direction. */
  centre: Float32Array;
  /** Similarity floor: a face is inside iff dot(face, centre) >= this. */
  minSimilarity: number;
};

/** Iterations for the enclosing-cap solver; converges well before this. */
const ENCLOSING_CAP_ITERATIONS = 64;

/**
 * Smallest amount by which an excluded face must fall short of the floor.
 * Large enough to survive the float32 round-trip through the centroid BLOB,
 * small enough never to evict a neighbour that was genuinely inside.
 */
const EXCLUSION_EPSILON = 1e-5;

const clampUnitRange = (value: number): number =>
  value > 1 ? 1 : value < -1 ? -1 : value;

export const dot = (a: Float32Array, b: Float32Array): number => {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += a[i] * b[i];
  return sum;
};

export const normalize = (vector: Float32Array): Float32Array => {
  let magnitudeSquared = 0;
  for (let i = 0; i < vector.length; i += 1) magnitudeSquared += vector[i] * vector[i];
  const magnitude = Math.sqrt(magnitudeSquared);
  const out = new Float32Array(vector.length);
  if (!magnitude) return out;
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / magnitude;
  return out;
};

/**
 * Spherical linear interpolation from `a` to `b`, `t` in [0, 1].
 *
 * Used rather than a straight line so the centre stays *on* the sphere while it
 * moves. A lerp would cut through the interior and, once renormalized, travel a
 * different angular distance than asked for — which would break the guarantee
 * that `growCapToInclude` moves exactly half the overshoot.
 */
export const slerp = (a: Float32Array, b: Float32Array, t: number): Float32Array => {
  const cosOmega = clampUnitRange(dot(a, b));
  const omega = Math.acos(cosOmega);
  const sinOmega = Math.sin(omega);
  // Coincident (or antipodal, where the path is undefined): nothing to rotate
  // through, so fall back to the endpoints.
  if (sinOmega < 1e-7) return t < 0.5 ? copyOf(a) : copyOf(b);

  const coefficientA = Math.sin((1 - t) * omega) / sinOmega;
  const coefficientB = Math.sin(t * omega) / sinOmega;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    out[i] = coefficientA * a[i] + coefficientB * b[i];
  }
  return normalize(out);
};

const copyOf = (vector: Float32Array): Float32Array => {
  const out = new Float32Array(vector.length);
  out.set(vector);
  return out;
};

/**
 * The smallest cap containing every supplied vector.
 *
 * Badoiu–Clarkson: start at the normalized mean and repeatedly step towards
 * whichever point is currently furthest out, with a 1/(i+1) step size. The mean
 * is a poor centre for this — it is pulled by density, and an enclosing cap
 * cares only about extremes — but it is a good starting point, and the shrinking
 * step converges on the minimax centre without needing the full exact solver.
 *
 * Returns null for an empty input.
 */
export const minimalEnclosingCap = (
  vectors: Float32Array[],
  iterations = ENCLOSING_CAP_ITERATIONS,
): Cap | null => {
  if (!vectors.length) return null;
  if (vectors.length === 1) {
    return { centre: normalize(vectors[0]), minSimilarity: 1 };
  }

  const dimension = vectors[0].length;
  const mean = new Float32Array(dimension);
  for (const vector of vectors) {
    for (let i = 0; i < dimension; i += 1) mean[i] += vector[i];
  }
  let centre = normalize(mean);

  for (let step = 1; step <= iterations; step += 1) {
    let furthest = vectors[0];
    let lowest = Infinity;
    for (const vector of vectors) {
      const similarity = dot(vector, centre);
      if (similarity < lowest) {
        lowest = similarity;
        furthest = vector;
      }
    }
    centre = slerp(centre, furthest, 1 / (step + 1));
  }

  let minSimilarity = Infinity;
  for (const vector of vectors) {
    const similarity = dot(vector, centre);
    if (similarity < minSimilarity) minSimilarity = similarity;
  }
  return { centre, minSimilarity };
};

/**
 * Grows a cap just enough to admit `vector`, moving the centre *towards* it.
 *
 * This is the minimal enclosing cap of "the old cap plus the new point". In
 * angular terms, with the old cap at radius a and the new face at angle b > a,
 * the result has radius (a + b) / 2 and its centre sits (b − a) / 2 along the
 * geodesic from the old centre towards the face — so the near edge reaches the
 * new face and the far edge does not move outwards at all.
 *
 * Inflating symmetrically instead (keeping the centre, raising the radius to b)
 * would sweep the *entire* far side of the cluster outwards by the full
 * overshoot, pulling in unrelated faces on the opposite side of the person for
 * no reason. This costs half the growth and none of that far-side sweep.
 *
 * A vector already inside is returned unchanged.
 */
export const growCapToInclude = (cap: Cap, vector: Float32Array): Cap => {
  const similarity = dot(vector, cap.centre);
  if (similarity >= cap.minSimilarity) return cap;

  const capAngle = Math.acos(clampUnitRange(cap.minSimilarity));
  const faceAngle = Math.acos(clampUnitRange(similarity));
  const grownAngle = (capAngle + faceAngle) / 2;

  // Fraction of the way along the geodesic from centre to face.
  const travel = (faceAngle - capAngle) / 2;
  const t = faceAngle > 0 ? travel / faceAngle : 0;

  return {
    centre: slerp(cap.centre, vector, t),
    minSimilarity: Math.cos(grownAngle),
  };
};

/**
 * The tightest `minSimilarity` that puts `vector` outside the cap, leaving the
 * centre alone.
 *
 * Shrinking is the only move available here: a cap can only ever exclude from
 * the outside in. A face that sits *closer* to the centre than members you want
 * to keep cannot be removed this way at any radius — the caller has to fall
 * back to an explicit per-face exception. `collateralOf` exists to make that
 * situation visible before it is applied rather than after.
 */
export const shrinkCapToExclude = (cap: Cap, vector: Float32Array): number =>
  dot(vector, cap.centre) + EXCLUSION_EPSILON;

/** Members of `vectors` that a cap with this floor would no longer hold. */
export const collateralOf = <T extends { vector: Float32Array }>(
  cap: Cap,
  minSimilarity: number,
  members: T[],
): T[] =>
  members.filter((member) => {
    const similarity = dot(member.vector, cap.centre);
    return similarity >= cap.minSimilarity && similarity < minSimilarity;
  });

export type RefitMember = { faceId: number; vector: Float32Array };

export type FittedCap = {
  cap: Cap;
  faceIds: number[];
};

export type RefitResult = {
  /** One or more caps covering as many `keep` members as possible. */
  caps: FittedCap[];
  /**
   * Members no cap could take without also admitting something from `avoid`.
   * The caller decides what happens to these — usually their own singleton
   * clusters, or back to unassigned.
   */
  uncovered: number[];
};

/** Below this a lobe is too small to be worth its own cluster. */
const DEFAULT_MIN_CAP_SIZE = 3;
/** Hard stop on recursion, so a pathological set cannot fragment endlessly. */
const DEFAULT_MAX_CAPS = 8;

/**
 * Recomputes the geometry of a cluster from the members that survived an edit.
 *
 * Grow and shrink only move the boundary outward or inward around a centre that
 * was fixed long ago; after a few edits the centre describes the cluster's
 * history rather than its contents. Refitting re-derives both from what is
 * actually in there, which is what keeps the stored radius meaningful.
 *
 * `avoid` carries the vectors that must stay *out* — the faces just rejected.
 * If the enclosing cap of the kept members would also swallow one of them, the
 * kept set is split in two (reusing the same deterministic 2-means as the
 * split-suggestion path) and each half refitted independently. That is the
 * "one ball cannot describe this person" case: a childhood and an adult face
 * genuinely are two regions, and the cap between them contains strangers.
 *
 * Best-effort by design. When splitting bottoms out — a lobe too small to
 * divide, or the cap budget spent — the remaining members are returned as
 * `uncovered` rather than forcing a cap that is known to be contaminated.
 */
export const refitCaps = (
  keep: RefitMember[],
  avoid: Float32Array[] = [],
  options: { minCapSize?: number; maxCaps?: number } = {},
): RefitResult => {
  const minCapSize = options.minCapSize ?? DEFAULT_MIN_CAP_SIZE;
  const maxCaps = options.maxCaps ?? DEFAULT_MAX_CAPS;

  const caps: FittedCap[] = [];
  const uncovered: number[] = [];
  // Explicit stack rather than recursion: the budget is global across the whole
  // tree, not per branch, so the traversal has to be able to see it.
  const pending: RefitMember[][] = keep.length ? [keep] : [];

  while (pending.length) {
    const group = pending.shift()!;
    const cap = minimalEnclosingCap(group.map((member) => member.vector));
    if (!cap) continue;

    const contaminated = avoid.some(
      (vector) => dot(vector, cap.centre) >= cap.minSimilarity,
    );
    const budgetLeft = caps.length + pending.length + 1 < maxCaps;

    if (!contaminated || !budgetLeft || group.length < minCapSize * 2) {
      if (contaminated && group.length < minCapSize * 2) {
        // Too small to divide and still dirty: hand it back rather than
        // publishing a cap that is known to contain someone else's face.
        uncovered.push(...group.map((member) => member.faceId));
        continue;
      }
      caps.push({ cap, faceIds: group.map((member) => member.faceId) });
      continue;
    }

    const split = planSplit(group, { minLobe: minCapSize });
    if (!split) {
      uncovered.push(...group.map((member) => member.faceId));
      continue;
    }

    const byId = new Map(group.map((member) => [member.faceId, member]));
    for (const lobe of split.lobes) {
      pending.push(
        lobe.faceIds
          .map((faceId) => byId.get(faceId))
          .filter((member): member is RefitMember => Boolean(member)),
      );
    }
  }

  return { caps, uncovered };
};
