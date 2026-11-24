/**
 * The JSON shapes the server sends and the client reads: one definition, so a
 * change to a response is a type error on both sides.
 *
 * Only shapes that travel over the wire unchanged belong here. The client
 * hydrates some of them (a face's path becomes a `PhotoItem`); those client
 * types are derived from these in `client/src/api/api.type.ts`, not copied.
 * Types only: nothing here may import from the client or the server.
 */

/** A rectangle in the photo's own pixel space (or a video frame's). */
export type FaceBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** One face crop as the people endpoints send it: where the photo is and where the box sits in it. */
export type FaceClusterFace = {
  path: string;
  fileName: string;
  box: FaceBox;
  mimeType: string | null;
  dimensionWidth: number | null;
  dimensionHeight: number | null;
  regions: string | null;
  /**
   * The `faces.id` row this crop came from, so one detection can be targeted
   * for exclusion independent of its photo.
   */
  faceId: number;
  /** ISO capture time, on the person-detail faces only (sort by date). */
  dateTaken?: string | null;
  /**
   * Video faces only: which frame (ms into the video) the box belongs to. A
   * face crop of a video has to name its frame, so the client passes this back
   * as the crop request's `t`. Absent for still photos.
   */
  frameTimeMs?: number;
};

export type FaceClusterSummary = {
  id: string;
  count: number;
  representative: FaceClusterFace;
  name: string | null;
  yearRangeLabel?: string | null;
  tags: string[];
};

export type FaceClusterCentroid = {
  id: string;
  count: number;
  representative: FaceClusterFace;
};

export type FaceClusterDetail = FaceClusterSummary & {
  faces: FaceClusterFace[];
  centroids: FaceClusterCentroid[];
  mergeSuggestions: FaceClusterSummary[];
};

export type FaceClusterResult = {
  clusters: FaceClusterSummary[];
  totalFaces: number;
  totalClusters: number;
  /**
   * Faces detected but not yet assigned to a cluster by the background
   * clustering task: lets the client show clustering progress.
   */
  pendingFaces: number;
};

export type FaceClusterDetailResult = {
  cluster: FaceClusterDetail | null;
};

export type FaceClusterPCAPoint = {
  id: string;
  count: number;
  name: string | null;
  representative: FaceClusterFace;
  x: number;
  y: number;
  z: number;
  focused: boolean;
};

export type FaceClusterPCAResult = {
  points: FaceClusterPCAPoint[];
};

/** The two values a face verdict can hold. */
export type FaceVerdict = "confirmed" | "rejected";

/** Why a face looks out of place beyond the embedding. */
export type FaceAnomalyFlag = "low-similarity" | "date" | "location" | "folder";

export type FaceCutoffSuggestion = {
  /**
   * Number of faces kept. Faces at this index and beyond fall below the cut,
   * so the suggestion is expressible either as a count or as `threshold`.
   */
  keepCount: number;
  /**
   * Midpoint of the gap. Using the midpoint rather than either endpoint means
   * no face sits exactly on the boundary, so "below the threshold" is
   * unambiguous however the value is later re-applied.
   */
  threshold: number;
  /** Size of the gap the cut sits in; the UI shows this as its confidence. */
  gap: number;
};

/**
 * One face as the review UI sees it: the crop, how far it sits from the
 * person's reference point, whether the user has already ruled on it, and what
 * (if anything) looks wrong about it beyond the embedding.
 */
export type FaceReviewFace = FaceClusterFace & {
  /** Cosine similarity to the person's anchor, or centroid. Null when unscoreable. */
  similarity: number | null;
  verdict: FaceVerdict | null;
  /** 0..1, the strongest single signal. */
  anomalyScore: number;
  flags: FaceAnomalyFlag[];
  /** One readable sentence per flag, for the UI to show as evidence. */
  reasons: string[];
};

export type FaceReviewResult = {
  personId: string;
  name: string | null;
  /**
   * True when `similarity` was measured against confirmed faces rather than the
   * running centroid. The UI says so, because an un-anchored distance is
   * measured from a point the intruders have already moved.
   */
  anchored: boolean;
  anchorCount: number;
  /** The person's current similarity floor, if one has been set. */
  radius: number | null;
  /** Sorted by similarity, descending. Excludes already-rejected faces. */
  faces: FaceReviewFace[];
  /** Previously rejected faces, so the UI can show and undo them. */
  rejected: FaceReviewFace[];
  /** Where the natural break in `faces` is, if there is one worth proposing. */
  suggestedCutoff: FaceCutoffSuggestion | null;
};

export type DateHistogramBucket = {
  start: number;
  end: number;
  count: number;
};

export type DateHistogramGrouping = "day" | "month" | "year";

export type DateHistogramResult = {
  buckets: DateHistogramBucket[];
  bucketSizeMs: number;
  minDate: number | null;
  maxDate: number | null;
  grouping: DateHistogramGrouping;
};
