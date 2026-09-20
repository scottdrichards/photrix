/**
 * Pure review/repair logic for face clusters.
 *
 * Clustering is greedy and order-dependent, so a person's group reliably
 * accumulates a few faces that don't belong. Everything here exists to make
 * those findable and removable *in bulk* rather than one "this isn't them"
 * click at a time, and it is deliberately free of DB and engine types: every
 * function takes plain numbers and returns plain numbers, so the interesting
 * decisions are unit-testable without a database, an embedding, or a request.
 *
 * The three ideas, in the order the UI uses them:
 *
 * 1. `suggestCutoff` — a person's faces sorted by similarity to their centroid
 *    are not uniformly distributed. Genuine sightings form a dense band and
 *    intruders trail off below it, usually with a visible gap between the two.
 *    Finding that gap gives the review UI a pre-placed cut line instead of
 *    asking the user to invent a threshold out of nothing.
 * 2. `scoreAnomalies` — similarity is not the only evidence. A face shot 400 km
 *    from anywhere else this person has ever been, eleven years outside their
 *    date range, in a folder they otherwise never appear in, is suspect even at
 *    a respectable similarity. These signals are independent of the embedding,
 *    so they catch the failure mode similarity can't: a genuine look-alike.
 * 3. `planOptimization` — over the whole library, which people should be merged
 *    (two centroids that are really one person), which should be split (one
 *    cluster that is really two), and which want a radius.
 */

/** Below this many members a distribution is too small to read anything into. */
const MIN_FACES_FOR_CUTOFF = 8;

/**
 * A gap only counts as the boundary between "them" and "not them" if it is both
 * absolutely meaningful and large against the distribution's own *spread*. The
 * absolute floor stops a tight, clean cluster being cut at a 0.002 ripple; the
 * IQR multiple stops a naturally broad cluster being cut at whatever its
 * largest ordinary step happens to be.
 *
 * The scale has to be the IQR, not the median distance between neighbours.
 * Measured against the real library (55 named people, 2026-09-20): at n=17k the
 * median neighbour gap is ~1e-5, so *any* tail gap clears a multiple of it and
 * the test does nothing. The IQR is a density-robust spread — it does not
 * shrink as members are added — so the same constant means the same thing for
 * a 20-face person and a 17,000-face one.
 *
 * Tuned on that measurement: 0.75 rejects every suggestion that was visibly
 * junk (Alice gap 0.04 on IQR 0.18, Amelia 0.03/0.14, Scott 0.05/0.17, Douglas
 * 0.03/0.21, Rosie 0.05/0.36 — all sub-0.4 gap/IQR) while keeping every clean
 * one (Diane 4.7, Eric 5.0, Rachel 6.4, Nathan 4.8, Micah 3.7, Lily 2.1).
 */
const MIN_CUTOFF_GAP = 0.03;
const CUTOFF_GAP_IQR_MULTIPLE = 0.75;

/**
 * Only the lower part of the sorted list is eligible to be cut. A cut high up
 * would discard most of the person, which is never the intent of this tool —
 * that case is a split (see `planSplit`), not a cutoff.
 */
const CUTOFF_SEARCH_START_FRACTION = 0.5;

/** Linear-interpolated quantile over an *ascending* array. */
const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

export type CutoffSuggestion = {
  /**
   * Number of faces kept. Faces at this index and beyond fall below the cut —
   * so the suggestion is expressible either as a count or as `threshold`.
   */
  keepCount: number;
  /**
   * Midpoint of the gap. Using the midpoint rather than either endpoint means
   * no face sits exactly on the boundary, so "below the threshold" is
   * unambiguous however the value is later re-applied.
   */
  threshold: number;
  /** Size of the gap the cut sits in — the UI shows this as its confidence. */
  gap: number;
};

/**
 * Finds the natural break in a person's similarity distribution.
 *
 * `similarities` must be sorted descending (the caller already orders faces
 * that way for display). Returns null when there is no break worth proposing,
 * which is the common and correct answer for a clean cluster — the UI then
 * shows no pre-placed line rather than inventing one.
 */
export const suggestCutoff = (similarities: number[]): CutoffSuggestion | null => {
  if (similarities.length < MIN_FACES_FOR_CUTOFF) return null;

  // `similarities` arrives descending; quantile() wants ascending.
  const ascending = [...similarities].reverse();
  const iqr = quantile(ascending, 0.75) - quantile(ascending, 0.25);

  const searchStart = Math.max(
    1,
    Math.ceil(similarities.length * CUTOFF_SEARCH_START_FRACTION),
  );

  let bestIndex = -1;
  let bestGap = 0;
  for (let i = searchStart; i < similarities.length; i += 1) {
    const gap = similarities[i - 1] - similarities[i];
    if (gap > bestGap) {
      bestGap = gap;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) return null;

  const required = Math.max(MIN_CUTOFF_GAP, iqr * CUTOFF_GAP_IQR_MULTIPLE);
  if (bestGap < required) return null;

  return {
    keepCount: bestIndex,
    threshold: (similarities[bestIndex - 1] + similarities[bestIndex]) / 2,
    gap: bestGap,
  };
};

export type AnomalyInput = {
  faceId: number;
  /** Cosine similarity to the person's centroid. */
  similarity: number;
  /** Capture time in epoch ms; null when the photo carries no usable date. */
  takenAt: number | null;
  latitude: number | null;
  longitude: number | null;
  /** The containing folder, used as a weak "was this person ever here" signal. */
  folder: string;
};

export type AnomalyFlag = "low-similarity" | "date" | "location" | "folder";

export type AnomalyResult = {
  faceId: number;
  /** 0..1; the strongest single signal, not a sum — see `scoreAnomalies`. */
  score: number;
  flags: AnomalyFlag[];
  /** Human-readable evidence for each flag, for the UI's tooltip. */
  reasons: string[];
};

/**
 * Faces more than this far (km) from the nearest *other* geotagged sighting of
 * the same person are flagged. A day trip is well inside it; a different
 * continent is not. Scaled to 1.0 at ten times the distance, so "wrong country"
 * and "wrong city" are distinguishable rather than both pinning at maximum.
 */
const GEO_OUTLIER_KM = 150;

/**
 * The date signal uses a Tukey fence on the person's own capture times, so a
 * person photographed across twenty years has a correspondingly wide fence and
 * nothing is flagged merely for being old.
 */
const DATE_FENCE_MULTIPLE = 1.5;

/** Similarity that maps to a full-strength low-similarity flag. */
const SIMILARITY_FLOOR = 0.45;
const SIMILARITY_FLAG_BELOW = 0.6;

/**
 * Per-signal ceilings, and the reason the context signals sit below 1.0.
 *
 * Similarity measures identity directly, so it is allowed the full range. Date,
 * location and folder measure *circumstance*, and circumstance has an innocent
 * explanation far more often than not: a holiday is simultaneously a new place,
 * a new folder and often the edge of a date range, and it is still the right
 * person. Capping them keeps a suspicious context below a face the embedding
 * itself disowns, which is the ordering the review queue needs. They stay high
 * enough to outrank a merely *slightly* low similarity, because a face on
 * another continent genuinely does deserve a look.
 */
const SIGNAL_CEILING = {
  similarity: 1,
  location: 0.8,
  date: 0.7,
  folder: 0.3,
} as const;

/** Great-circle distance in km. Shares the haversine form used for share descriptions. */
export const haversineKm = (
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number => {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const formatKm = (km: number): string =>
  km >= 100 ? `${Math.round(km)}` : km.toFixed(1);

const formatYear = (epochMs: number): string =>
  new Date(epochMs).toISOString().slice(0, 10);

/**
 * Scores every face of one person against the *rest of that person's own*
 * photos — a face is only anomalous relative to its peers, never against some
 * library-wide constant.
 *
 * The score is the **maximum** of the individual signals rather than their sum.
 * Summing would let three mild, mutually-correlated signals (a holiday abroad
 * is simultaneously a new place, a new folder and often a date edge) outrank
 * one damning one, which inverts the ordering exactly where it matters. The max
 * keeps the queue ordered by "strongest single reason to doubt this".
 */
export const scoreAnomalies = (faces: AnomalyInput[]): AnomalyResult[] => {
  const dated = faces
    .map((face) => face.takenAt)
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  const q1 = quantile(dated, 0.25);
  const q3 = quantile(dated, 0.75);
  const iqr = q3 - q1;
  // A person photographed on essentially one day has a zero-width fence; every
  // other day would then be infinitely anomalous, which is useless. Require a
  // real spread before the date signal is allowed to fire at all.
  const dateUsable = dated.length >= MIN_FACES_FOR_CUTOFF && iqr > 0;

  const geotagged = faces.filter(
    (face) => face.latitude != null && face.longitude != null,
  );
  const geoUsable = geotagged.length >= 3;

  const folderCounts = new Map<string, number>();
  for (const face of faces) {
    folderCounts.set(face.folder, (folderCounts.get(face.folder) ?? 0) + 1);
  }
  // The folder signal only means anything once the person is well represented;
  // for someone with nine faces, "only one in this folder" is just ordinary.
  const folderUsable = faces.length >= 20 && folderCounts.size >= 3;

  return faces.map((face) => {
    const flags: AnomalyFlag[] = [];
    const reasons: string[] = [];
    let score = 0;

    if (face.similarity < SIMILARITY_FLAG_BELOW) {
      const strength = clamp01(
        (SIMILARITY_FLAG_BELOW - face.similarity) /
          (SIMILARITY_FLAG_BELOW - SIMILARITY_FLOOR),
      );
      flags.push("low-similarity");
      reasons.push(`similarity ${face.similarity.toFixed(2)} to this person's centre`);
      score = Math.max(score, strength * SIGNAL_CEILING.similarity);
    }

    if (dateUsable && face.takenAt != null) {
      const low = q1 - iqr * DATE_FENCE_MULTIPLE;
      const high = q3 + iqr * DATE_FENCE_MULTIPLE;
      const outside =
        face.takenAt < low ? low - face.takenAt : face.takenAt > high ? face.takenAt - high : 0;
      if (outside > 0) {
        flags.push("date");
        reasons.push(
          `taken ${formatYear(face.takenAt)}, outside this person's usual ${formatYear(q1)}–${formatYear(q3)}`,
        );
        // Full strength once it is an entire IQR beyond the fence.
        score = Math.max(score, clamp01(outside / iqr) * SIGNAL_CEILING.date);
      }
    }

    if (geoUsable && face.latitude != null && face.longitude != null) {
      let nearest = Infinity;
      for (const other of geotagged) {
        if (other.faceId === face.faceId) continue;
        nearest = Math.min(
          nearest,
          haversineKm(face.latitude, face.longitude, other.latitude!, other.longitude!),
        );
      }
      if (Number.isFinite(nearest) && nearest > GEO_OUTLIER_KM) {
        flags.push("location");
        reasons.push(
          `${formatKm(nearest)} km from the nearest other photo of this person`,
        );
        score = Math.max(
          score,
          clamp01(nearest / (GEO_OUTLIER_KM * 10)) * SIGNAL_CEILING.location,
        );
      }
    }

    if (folderUsable && folderCounts.get(face.folder) === 1) {
      flags.push("folder");
      reasons.push(`the only sighting of this person in ${face.folder || "/"}`);
      // Deliberately weak: a lone appearance in a folder is suggestive at most,
      // and on its own must never outrank a real similarity or location signal.
      score = Math.max(score, SIGNAL_CEILING.folder);
    }

    return { faceId: face.faceId, score, flags, reasons };
  });
};

export type OptimizeCluster = {
  /** Person-level id (the canonical root when centroids have been merged). */
  id: string;
  name: string | null;
  count: number;
  /** Unit-length centroid. */
  vector: Float32Array;
  /** Member similarities to this centroid, sorted descending. */
  similarities: number[];
};

export type MergeProposal = {
  kind: "merge";
  targetId: string;
  sourceId: string;
  similarity: number;
  targetName: string | null;
  sourceName: string | null;
  /**
   * True when both sides already carry *different* names. The pair still gets
   * reported — near-identical centroids under two names is worth a human look
   * either way — but it must never be applied in bulk, because the usual cause
   * is two genuinely similar relatives rather than a duplicate.
   */
  nameConflict: boolean;
};

export type TightenProposal = {
  kind: "tighten";
  clusterId: string;
  name: string | null;
  threshold: number;
  /** How many members fall below the proposed radius. */
  affected: number;
  gap: number;
};

export type OptimizeProposal = MergeProposal | TightenProposal;

/**
 * Two person centroids at least this similar are proposed as one person. It
 * sits *above* the clustering threshold on purpose: at the clustering
 * threshold the two would already have been one cluster, so anything that
 * survived as separate needs stronger evidence than the engine itself uses.
 */
export const MERGE_PROPOSAL_THRESHOLD = 0.75;

/** Outer-loop rows between event-loop yields; a power of two so the test is a mask. */
const YIELD_EVERY_ROWS = 64;

const dot = (a: Float32Array, b: Float32Array): number => {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += a[i] * b[i];
  return sum;
};

/**
 * Produces a dry-run repair plan for the whole library: which people to merge,
 * and which to tighten with a radius.
 *
 * Async only to yield the event loop — it does no I/O and stays deterministic.
 *
 * Every proposal is evidence plus an action, never an applied change — the
 * caller applies them one at a time. Merges are ordered by similarity so the
 * most obvious duplicates are decided first, and each source appears at most
 * once so applying the list top-down can't try to move a cluster twice.
 */
export const planOptimization = async (
  clusters: OptimizeCluster[],
  options: { mergeThreshold?: number; maxProposals?: number } = {},
): Promise<OptimizeProposal[]> => {
  const mergeThreshold = options.mergeThreshold ?? MERGE_PROPOSAL_THRESHOLD;
  const maxProposals = options.maxProposals ?? 50;

  // Group first, then choose one target per group.
  //
  // Pairwise proposals alone produce chains — A absorbs B while B absorbs C —
  // so applying the list top-down moves a cluster that has already moved. Union
  // -find collapses each connected set of near-identical centroids into one
  // group with a single destination, which makes every proposal independent of
  // every other and safe to apply (or skip) in any order.
  const parent = new Map<string, string>(clusters.map((c) => [c.id, c.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression, so a long chain doesn't re-walk on every lookup.
    let walk = id;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };

  for (let i = 0; i < clusters.length; i += 1) {
    // Cooperative yield. This loop is quadratic in the number of people and the
    // server is single-threaded, so without it a plan stalls every other
    // request on the box for its whole duration. Measured on the real library
    // (2026-09-20): 3684 person-level candidates, 6.8M pairs of 512-dim
    // vectors, ~15 s of CPU. That is tolerable for an explicit, dry-run action
    // *because* it yields; it would not be as a blocking call. If it ever needs
    // to be faster, prefilter pairs on a low-dimensional random projection
    // before spending a full dot product on them.
    if ((i & (YIELD_EVERY_ROWS - 1)) === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (let j = i + 1; j < clusters.length; j += 1) {
      if (dot(clusters[i].vector, clusters[j].vector) < mergeThreshold) continue;
      const rootA = find(clusters[i].id);
      const rootB = find(clusters[j].id);
      if (rootA !== rootB) parent.set(rootB, rootA);
    }
  }

  const byId = new Map(clusters.map((c) => [c.id, c]));
  const groups = new Map<string, OptimizeCluster[]>();
  for (const cluster of clusters) {
    const root = find(cluster.id);
    const group = groups.get(root);
    if (group) group.push(cluster);
    else groups.set(root, [cluster]);
  }

  const dedupedMerges: MergeProposal[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // A named cluster outranks an unnamed one whatever the count — the name is
    // the thing the user cares about keeping — and among equals the largest
    // wins, since it has the best-supported centroid.
    const target = [...group].sort((a, b) =>
      Boolean(a.name) !== Boolean(b.name) ? (a.name ? -1 : 1) : b.count - a.count,
    )[0];
    for (const source of group) {
      if (source.id === target.id) continue;
      dedupedMerges.push({
        kind: "merge",
        targetId: target.id,
        sourceId: source.id,
        similarity: dot(byId.get(target.id)!.vector, source.vector),
        targetName: target.name,
        sourceName: source.name,
        nameConflict: Boolean(target.name && source.name && target.name !== source.name),
      });
    }
  }
  dedupedMerges.sort((x, y) => y.similarity - x.similarity);

  const tightens: TightenProposal[] = [];
  for (const cluster of clusters) {
    const cutoff = suggestCutoff(cluster.similarities);
    if (!cutoff) continue;
    tightens.push({
      kind: "tighten",
      clusterId: cluster.id,
      name: cluster.name,
      threshold: cutoff.threshold,
      affected: cluster.similarities.length - cutoff.keepCount,
      gap: cutoff.gap,
    });
  }
  tightens.sort((x, y) => y.affected - x.affected);

  return [...dedupedMerges, ...tightens].slice(0, maxProposals);
};

export type SplitLobe = {
  faceIds: number[];
  centroid: Float32Array;
};

export type SplitPlan = {
  lobes: [SplitLobe, SplitLobe];
  /** Cosine similarity between the two lobe centroids — lower means a cleaner split. */
  crossSimilarity: number;
};

/**
 * Two-means over one cluster's member vectors, used to answer "is this group
 * actually two people?".
 *
 * Seeded with the two *least* similar members rather than at random, so the
 * result is deterministic — a repair tool that proposes a different split each
 * time it is asked is not usable. Returns null when either lobe would be too
 * small to be a person.
 */
export const planSplit = (
  members: Array<{ faceId: number; vector: Float32Array }>,
  options: { minLobe?: number; iterations?: number } = {},
): SplitPlan | null => {
  const minLobe = options.minLobe ?? 4;
  const iterations = options.iterations ?? 8;
  if (members.length < minLobe * 2) return null;

  let seedA = 0;
  let seedB = 1;
  let worst = Infinity;
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const similarity = dot(members[i].vector, members[j].vector);
      if (similarity < worst) {
        worst = similarity;
        seedA = i;
        seedB = j;
      }
    }
  }

  const dimension = members[0].vector.length;
  // Copied into freshly-allocated arrays rather than aliasing the seeds: the
  // loop below replaces them anyway, and a copy keeps the buffer type concrete.
  let centroidA = copyOf(members[seedA].vector);
  let centroidB = copyOf(members[seedB].vector);
  let assignment: number[] = [];

  for (let pass = 0; pass < iterations; pass += 1) {
    const next = members.map((member) =>
      dot(member.vector, centroidA) >= dot(member.vector, centroidB) ? 0 : 1,
    );
    const changed =
      assignment.length !== next.length || next.some((value, i) => value !== assignment[i]);
    assignment = next;
    if (!changed) break;

    const sums = [new Float32Array(dimension), new Float32Array(dimension)];
    const counts = [0, 0];
    for (let i = 0; i < members.length; i += 1) {
      const lobe = assignment[i];
      counts[lobe] += 1;
      const vector = members[i].vector;
      for (let d = 0; d < dimension; d += 1) sums[lobe][d] += vector[d];
    }
    if (!counts[0] || !counts[1]) return null;
    centroidA = normalize(sums[0]);
    centroidB = normalize(sums[1]);
  }

  const lobeA = members.filter((_, i) => assignment[i] === 0).map((m) => m.faceId);
  const lobeB = members.filter((_, i) => assignment[i] === 1).map((m) => m.faceId);
  if (lobeA.length < minLobe || lobeB.length < minLobe) return null;

  return {
    lobes: [
      { faceIds: lobeA, centroid: centroidA },
      { faceIds: lobeB, centroid: centroidB },
    ],
    crossSimilarity: dot(centroidA, centroidB),
  };
};

const copyOf = (vector: Float32Array): Float32Array => {
  const out = new Float32Array(vector.length);
  out.set(vector);
  return out;
};

const normalize = (vector: Float32Array): Float32Array => {
  let magnitudeSquared = 0;
  for (let i = 0; i < vector.length; i += 1) magnitudeSquared += vector[i] * vector[i];
  const magnitude = Math.sqrt(magnitudeSquared);
  if (!magnitude) return copyOf(vector);
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / magnitude;
  return out;
};
