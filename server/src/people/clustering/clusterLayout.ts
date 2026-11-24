import type { FaceClusterFace, FaceClusterPCAResult } from "../../indexDatabase/indexDatabase.type.ts";
import { computePCA3D } from "./pca.ts";

/** Pure steps behind the People-tab layout and merge suggestions: no SQL. */

export const normalizeFaceClusterCentroid = (
  vector: Float32Array<ArrayBuffer>,
): Float32Array<ArrayBuffer> => {
  let magnitude = 0;
  for (let i = 0; i < vector.length; i++) magnitude += vector[i] * vector[i];
  magnitude = Math.sqrt(magnitude);
  if (magnitude < 1e-10) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / magnitude;
  return out;
};

export const dotFaceClusterVectors = (
  a: Float32Array<ArrayBuffer>,
  b: Float32Array<ArrayBuffer>,
): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

export const formatYearRangeLabel = (
  minDate: number | null,
  maxDate: number | null,
): string | null => {
  if (
    minDate === null ||
    maxDate === null ||
    !Number.isFinite(minDate) ||
    !Number.isFinite(maxDate)
  ) {
    return null;
  }

  const startYear = new Date(minDate).getUTCFullYear();
  const endYear = new Date(maxDate).getUTCFullYear();
  return startYear === endYear ? String(startYear) : `${startYear}-${endYear}`;
};

export type FaceClusterPCASeed = {
  id: string;
  clusterId: number;
  personId: number | null;
  count: number;
  name: string | null;
  representative: FaceClusterFace;
  vector: Float32Array<ArrayBuffer>;
};

export const buildFaceClustersPCAResult = (
  seeds: FaceClusterPCASeed[],
  focusedClusterId: string | null = null,
): FaceClusterPCAResult => {
  if (seeds.length === 0) return { points: [] };

  const coords = computePCA3D(seeds.map((seed) => seed.vector));
  const focusedIndex = focusedClusterId
    ? seeds.findIndex((seed) => seed.id === focusedClusterId)
    : -1;
  const focusOrigin = focusedIndex >= 0 ? coords[focusedIndex] : null;

  return {
    points: seeds.map((seed, index) => ({
      id: seed.id,
      count: seed.count,
      name: seed.name,
      representative: seed.representative,
      x: coords[index][0] - (focusOrigin?.[0] ?? 0),
      y: coords[index][1] - (focusOrigin?.[1] ?? 0),
      z: coords[index][2] - (focusOrigin?.[2] ?? 0),
      focused: seed.id === focusedClusterId,
    })),
  };
};
