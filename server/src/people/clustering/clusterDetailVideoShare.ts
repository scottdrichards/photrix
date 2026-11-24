/** One face row of a person's detail page, as `getFaceClusterDetail` reads it. */
export type ClusterDetailRow = {
  id: number;
  folder: string;
  fileName: string;
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
  frameTimeMs: number | null;
  clusterSimilarity: number | null;
  mimeType: string | null;
  dimensionWidth: number | null;
  dimensionHeight: number | null;
  regions: string | null;
  dateTaken: number | null;
};

/**
 * How many of a capped person's `cap` faces should come from videos: their
 * share of the person's faces, and at least one when there are any. Under the
 * cap every face is shown already, so the quota is all of them.
 */
export const videoFaceQuota = (cap: number, total: number, videoTotal: number): number => {
  if (videoTotal <= 0) return 0;
  if (total <= cap) return videoTotal;
  return Math.min(videoTotal, cap, Math.max(1, Math.round((cap * videoTotal) / total)));
};

const bySimilarity = (a: ClusterDetailRow, b: ClusterDetailRow): number =>
  (b.clusterSimilarity ?? Number.NEGATIVE_INFINITY) -
    (a.clusterSimilarity ?? Number.NEGATIVE_INFINITY) || a.id - b.id;

/**
 * Swaps the weakest photo faces of `rows` (best-match-first, at most `cap`)
 * for `videoRows`, the person's best video faces, keeping `cap` faces in
 * best-match order. `videoRows` already includes any video faces `rows` had,
 * because both are ranked the same way.
 */
export const withVideoFaceShare = (
  rows: ClusterDetailRow[],
  videoRows: ClusterDetailRow[],
  cap: number,
): ClusterDetailRow[] => {
  const videos = videoRows.slice(0, cap);
  const videoIds = new Set(videos.map((row) => row.id));
  const photos = rows
    .filter((row) => row.frameTimeMs === null && !videoIds.has(row.id))
    .slice(0, Math.max(0, cap - videos.length));
  return [...photos, ...videos].sort(bySimilarity);
};
