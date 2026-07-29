import { buildFilters, filtersToParam } from "./filters";
import { fetchWithDiagnostics, fetchJsonOrThrow } from "./http";
import { buildFileUrl, buildFilesQueryUrl, createPhotoItem } from "./photoItem";
import type {
  ClusterFace,
  FaceBox,
  FaceClusterPCAPoint,
  FetchPeopleClustersOptions,
  PeopleClustersResult,
  PersonClusterDetailResult,
  PhotoPersonFace,
} from "./types";

type ApiFaceRep = {
  path: string;
  fileName: string;
  box: FaceBox;
  mimeType: string | null;
  dimensionWidth: number | null;
  dimensionHeight: number | null;
  regions: string | null;
};

const toClusterFace = (face: ApiFaceRep): ClusterFace => {
  const { path: relativePath, fileName, mimeType, dimensionWidth, dimensionHeight, box, regions } = face;
  return {
    photo: createPhotoItem({
      folder: relativePath.slice(0, relativePath.length - fileName.length),
      fileName,
      mimeType,
      dimensionWidth: dimensionWidth ?? undefined,
      dimensionHeight: dimensionHeight ?? undefined,
      ...(regions != null ? { regions } : {}),
      faceTableBoxes: [box],
    }),
    box,
  };
};

export const fetchPeopleClusters = async ({
  includeSubfolders = false,
  path = "",
  ratingFilter,
  mediaTypeFilter = "all",
  locationBounds,
  dateRange,
  peopleInImageFilter,
  faceClusterFilter,
  faceAttributeFilter,
  cameraModelFilter,
  lensFilter,
  signal,
}: FetchPeopleClustersOptions = {}): Promise<PeopleClustersResult> => {
  const params = new URLSearchParams();
  params.set("aggregate", "people");
  if (includeSubfolders) params.set("includeSubfolders", "true");

  const filterParam = filtersToParam(buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    faceAttributeFilter,
    cameraModelFilter,
    lensFilter,
  }));
  if (filterParam) params.set("filter", filterParam);

  const url = buildFilesQueryUrl(path, params);
  const payload = await fetchJsonOrThrow<{
    clusters: Array<{
      id: string;
      count: number;
      representative: ApiFaceRep;
    }>;
    totalFaces: number;
    totalClusters: number;
    pendingFaces?: number;
  }>(url, "fetch people clusters", { signal });

  return {
    clusters: payload.clusters.map((cluster) => ({
      id: cluster.id,
      count: cluster.count,
      representative: toClusterFace(cluster.representative),
      name: (cluster as Record<string, unknown>).name as string | null ?? null,
    })),
    totalFaces: payload.totalFaces,
    totalClusters: payload.totalClusters,
    pendingFaces: payload.pendingFaces ?? 0,
  };
};

export const fetchClusterDetail = async (
  {
    clusterId,
    includeSubfolders = false,
    path = "",
    ratingFilter,
    mediaTypeFilter = "all",
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    faceAttributeFilter,
    cameraModelFilter,
    lensFilter,
    signal,
  }: FetchPeopleClustersOptions & { clusterId: string } = { clusterId: "" },
): Promise<PersonClusterDetailResult> => {
  const params = new URLSearchParams();
  params.set("aggregate", "peopleClusterDetail");
  params.set("clusterId", clusterId);
  if (includeSubfolders) params.set("includeSubfolders", "true");

  const filterParam = filtersToParam(buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    faceAttributeFilter,
    cameraModelFilter,
    lensFilter,
  }));
  if (filterParam) params.set("filter", filterParam);

  const url = buildFilesQueryUrl(path, params);
  const payload = await fetchJsonOrThrow<{
    cluster: {
      id: string;
      count: number;
      representative: ApiFaceRep;
      faces: ApiFaceRep[];
      centroids?: Array<{ id: string; count: number; representative: ApiFaceRep }>;
      mergeSuggestions?: Array<{
        id: string;
        count: number;
        name: string | null;
        representative: ApiFaceRep;
      }>;
    } | null;
  }>(url, "fetch cluster detail", { signal });

  if (!payload.cluster) return { cluster: null };

  return {
    cluster: {
      id: payload.cluster.id,
      count: payload.cluster.count,
      representative: toClusterFace(payload.cluster.representative),
      faces: payload.cluster.faces.map(toClusterFace),
      name: (payload.cluster as Record<string, unknown>).name as string | null ?? null,
      centroids: (payload.cluster.centroids ?? []).map((centroid) => ({
        id: centroid.id,
        count: centroid.count,
        representative: toClusterFace(centroid.representative),
      })),
      mergeSuggestions: (payload.cluster.mergeSuggestions ?? []).map((cluster) => ({
        id: cluster.id,
        count: cluster.count,
        name: cluster.name,
        yearRangeLabel:
          (cluster as Record<string, unknown>).yearRangeLabel as string | null | undefined,
        representative: toClusterFace(cluster.representative),
      })),
    },
  };
};

/**
 * Fetches the detected faces for a single file, resolved to their People
 * clusters, so the fullscreen viewer can label each face with its person's
 * name and link to the person page. Returns an empty array for files with no
 * clustered faces.
 */
export const fetchPeopleFacesForFile = async (
  path: string,
  signal?: AbortSignal,
): Promise<PhotoPersonFace[]> => {
  const params = new URLSearchParams();
  params.set("aggregate", "facesForFile");
  params.set("path", path);
  const url = buildFilesQueryUrl("", params);
  const payload = await fetchJsonOrThrow<{ faces?: PhotoPersonFace[] }>(
    url,
    "fetch faces for file",
    { signal },
  );
  return Array.isArray(payload.faces) ? payload.faces : [];
};

export const fetchFaceClustersPCA = async ({
  clusterId,
  signal,
}: {
  clusterId?: string;
  signal?: AbortSignal;
} = {}): Promise<FaceClusterPCAPoint[]> => {
  const params = new URLSearchParams();
  params.set("aggregate", "faceCentroidsPCA");
  if (clusterId) params.set("clusterId", clusterId);
  const url = buildFilesQueryUrl("", params);
  const payload = await fetchJsonOrThrow<{
    points: Array<{
      id: string;
      count: number;
      name: string | null;
      representative: ApiFaceRep;
      x: number;
      y: number;
      z: number;
      focused: boolean;
    }>;
  }>(url, "fetch face cluster PCA", { signal });

  if (!Array.isArray(payload.points)) {
    throw new Error("Server returned unexpected response — try restarting the server to pick up the new faceCentroidsPCA endpoint");
  }

  return payload.points.map((p) => ({
    id: p.id,
    count: p.count,
    name: p.name,
    representative: {
      photo: createPhotoItem({
        folder: p.representative.path.slice(0, p.representative.path.length - p.representative.fileName.length),
        fileName: p.representative.fileName,
        mimeType: p.representative.mimeType,
        dimensionWidth: p.representative.dimensionWidth ?? undefined,
        dimensionHeight: p.representative.dimensionHeight ?? undefined,
      }),
      box: p.representative.box,
    },
    x: p.x,
    y: p.y,
    z: p.z,
    focused: p.focused,
  }));
};

// How much context to include around the detected face, as a fraction of the
// face's own size added on every side. 0.6 → the crop is ~2.2× the face box, so
// there's headroom for hair/chin without shrinking the face too far.
const FACE_CROP_PADDING = 0.6;

export const buildFaceCropUrl = (face: ClusterFace, size = 320): string => {
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const grow = 1 + 2 * FACE_CROP_PADDING;
  const w = clamp01(face.box.width * grow);
  const h = clamp01(face.box.height * grow);
  const x = clamp01(Math.min(Math.max(face.box.x - w / 2, 0), 1 - w));
  const y = clamp01(Math.min(Math.max(face.box.y - h / 2, 0), 1 - h));
  return buildFileUrl(face.photo.path, {
    crop: `${x},${y},${w},${h}`,
    height: String(size),
  });
};

export const renameCluster = async (
  clusterId: string,
  name: string | null,
): Promise<void> => {
  const response = await fetchWithDiagnostics("/api/people/rename", "rename cluster", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clusterId, name }),
  });
  if (!response.ok) throw new Error(`Failed to rename cluster (status ${response.status})`);
};

export const mergeClusters = async (
  sourceClusterIds: string[],
  targetClusterId: string,
): Promise<void> => {
  const response = await fetchWithDiagnostics("/api/people/merge", "merge clusters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceClusterIds, targetClusterId }),
  });
  if (!response.ok) throw new Error(`Failed to merge clusters (status ${response.status})`);
};

export const separateCluster = async (clusterId: string): Promise<void> => {
  const response = await fetchWithDiagnostics("/api/people/separate", "separate cluster", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clusterId }),
  });
  if (!response.ok) throw new Error(`Failed to separate cluster (status ${response.status})`);
};
