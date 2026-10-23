import type { ClusterFace } from "../api/types";

/**
 * Orders for a person's face grid (feedback #144). The server returns faces
 * best-match first, so "match" keeps that order and "outliers" reverses it,
 * which floats the faces most likely to be someone else to the top.
 */
export type FaceSort = "match" | "outliers" | "newest" | "oldest" | "folder";

export const FACE_SORT_LABELS: Record<FaceSort, string> = {
  match: "Best match",
  outliers: "Least alike first",
  newest: "Newest",
  oldest: "Oldest",
  folder: "Folder",
};

const faceTime = (face: ClusterFace): number | null => {
  const raw = face.photo.metadata?.dateTaken;
  const time = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(time) ? time : null;
};

export const sortFaces = (faces: ClusterFace[], sort: FaceSort): ClusterFace[] => {
  if (sort === "match") return faces;
  if (sort === "outliers") return [...faces].reverse();
  if (sort === "folder") {
    return [...faces].sort((a, b) =>
      a.photo.path.localeCompare(b.photo.path, undefined, { numeric: true }),
    );
  }
  const direction = sort === "newest" ? -1 : 1;
  // Undated faces sink to the end in either direction.
  return [...faces].sort((a, b) => {
    const ta = faceTime(a);
    const tb = faceTime(b);
    if (ta === null || tb === null) return (ta === null ? 1 : 0) - (tb === null ? 1 : 0);
    return (ta - tb) * direction;
  });
};
