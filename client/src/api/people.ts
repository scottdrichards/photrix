import { buildFilters, filtersToParam } from "./filters";
import { fetchWithDiagnostics, fetchJsonOrThrow } from "./http";
import { buildFileUrl, buildFilesQueryUrl, createPhotoItem } from "./photoItem";
import type {
  ClusterFace,
  FaceBox,
  FaceClusterPCAPoint,
  FaceVerdict,
  FetchPeopleClustersOptions,
  NamedPerson,
  OptimizeProposal,
  PeopleClustersResult,
  PersonClusterDetailResult,
  PersonReview,
  PhotoPersonFace,
  ReviewFace,
} from "./types";

type ApiFaceRep = {
  path: string;
  fileName: string;
  box: FaceBox;
  mimeType: string | null;
  dimensionWidth: number | null;
  dimensionHeight: number | null;
  regions: string | null;
  faceId: number;
};

const toClusterFace = (face: ApiFaceRep): ClusterFace => {
  const { path: relativePath, fileName, mimeType, dimensionWidth, dimensionHeight, box, regions, faceId } = face;
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
    faceId,
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
  faceClusterMatchMode,
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
    faceClusterMatchMode,
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
      tags?: string[];
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
      tags: cluster.tags ?? [],
    })),
    totalFaces: payload.totalFaces,
    totalClusters: payload.totalClusters,
    pendingFaces: payload.pendingFaces ?? 0,
  };
};

export const fetchClusterDetail = async (
  {
    clusterId,
    // Feedback #105: pass true when viewing a "Match Group"/merged
    // sub-cluster on its own — otherwise the server resolves the request
    // back up to the whole merged person, and "View" shows the exact same
    // faces you already had open.
    exactCluster = false,
    includeSubfolders = false,
    path = "",
    ratingFilter,
    mediaTypeFilter = "all",
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    faceClusterMatchMode,
    faceAttributeFilter,
    cameraModelFilter,
    lensFilter,
    signal,
  }: FetchPeopleClustersOptions & { clusterId: string; exactCluster?: boolean } = {
    clusterId: "",
  },
): Promise<PersonClusterDetailResult> => {
  const params = new URLSearchParams();
  params.set("aggregate", "peopleClusterDetail");
  params.set("clusterId", clusterId);
  if (exactCluster) params.set("exactCluster", "true");
  if (includeSubfolders) params.set("includeSubfolders", "true");

  const filterParam = filtersToParam(buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    faceClusterMatchMode,
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
      tags?: string[];
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
      tags: payload.cluster.tags ?? [],
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
        tags: [],
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

/** Every named person, for the face-assign panel's existing-name autocomplete. */
export const fetchNamedPeople = async (signal?: AbortSignal): Promise<NamedPerson[]> => {
  const payload = await fetchJsonOrThrow<{ people?: NamedPerson[] }>(
    "/api/people/named",
    "fetch named people",
    { signal },
  );
  return Array.isArray(payload.people) ? payload.people : [];
};

/**
 * A few other sightings of one cluster's person — the fullscreen face-assign
 * panel's "does this look right?" preview before naming/merging. Pass the
 * face already on screen as `excludeFaceId` so the preview doesn't just show
 * the same photo back.
 */
export const fetchClusterFacePreview = async ({
  clusterId,
  excludeFaceId,
  limit,
  signal,
}: {
  clusterId: string;
  excludeFaceId?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<ClusterFace[]> => {
  const params = new URLSearchParams();
  params.set("clusterId", clusterId);
  if (excludeFaceId != null) params.set("excludeFaceId", String(excludeFaceId));
  if (limit != null) params.set("limit", String(limit));
  const payload = await fetchJsonOrThrow<{ faces?: ApiFaceRep[] }>(
    `/api/people/cluster-preview?${params.toString()}`,
    "fetch cluster face preview",
    { signal },
  );
  return Array.isArray(payload.faces) ? payload.faces.map(toClusterFace) : [];
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
      faceId: p.representative.faceId,
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

export const setPersonTags = async (clusterId: string, tags: string[]): Promise<void> => {
  const response = await fetchWithDiagnostics("/api/people/tags", "set person tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clusterId, tags }),
  });
  if (!response.ok) throw new Error(`Failed to set person tags (status ${response.status})`);
};

/** Distinct tags across every person, for a tag-input's autocomplete. */
export const fetchAllPersonTags = async (): Promise<string[]> => {
  const response = await fetchWithDiagnostics("/api/people/tags", "list person tags", {
    method: "GET",
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { tags?: string[] };
  return data.tags ?? [];
};

/** Removes one outlier detection from its cluster (feedback #90). */
export const excludeFaceFromCluster = async (faceId: number): Promise<void> => {
  const response = await fetchWithDiagnostics(
    "/api/people/exclude-face",
    "exclude face from cluster",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ faceId }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to exclude face (status ${response.status})`);
  }
};


/**
 * One person's faces ordered by how far they sit from that person's reference
 * point, each with its verdict and anomaly evidence, plus a suggested cut line.
 *
 * The server returns the face crops in the same `ApiFaceRep` shape everything
 * else here uses, so the extra review fields are grafted onto the usual
 * `ClusterFace` rather than given a parallel photo model.
 */
export const fetchPersonReview = async (
  clusterId: string,
  signal?: AbortSignal,
): Promise<PersonReview> => {
  type ApiReviewFace = ApiFaceRep & {
    similarity: number | null;
    verdict: FaceVerdict | null;
    anomalyScore: number;
    flags: ReviewFace["flags"];
    reasons: string[];
  };
  const payload = await fetchJsonOrThrow<{
    personId: string;
    name: string | null;
    anchored: boolean;
    anchorCount: number;
    radius: number | null;
    faces: ApiReviewFace[];
    rejected: ApiReviewFace[];
    suggestedCutoff: PersonReview["suggestedCutoff"];
  }>(
    `/api/people/review?clusterId=${encodeURIComponent(clusterId)}`,
    "fetch person review",
    { signal },
  );

  const toReviewFace = (face: ApiReviewFace): ReviewFace => ({
    ...toClusterFace(face),
    similarity: face.similarity,
    verdict: face.verdict,
    anomalyScore: face.anomalyScore,
    flags: face.flags ?? [],
    reasons: face.reasons ?? [],
  });

  return {
    personId: payload.personId,
    name: payload.name,
    anchored: payload.anchored,
    anchorCount: payload.anchorCount,
    radius: payload.radius,
    faces: (payload.faces ?? []).map(toReviewFace),
    rejected: (payload.rejected ?? []).map(toReviewFace),
    suggestedCutoff: payload.suggestedCutoff,
  };
};

/**
 * Applies (or previews, with `dryRun`) a cut line: every face below `threshold`
 * leaves the person, and the threshold sticks as their radius. Pass
 * `threshold: null` to clear an existing radius instead.
 */
export const applyPersonCutoff = async ({
  clusterId,
  threshold,
  dryRun,
}: {
  clusterId: string;
  threshold: number | null;
  dryRun?: boolean;
}): Promise<{ affected: number }> => {
  const response = await fetchWithDiagnostics("/api/people/cutoff", "apply person cutoff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clusterId, threshold, ...(dryRun ? { dryRun } : {}) }),
  });
  if (!response.ok) {
    throw new Error(`Failed to apply cutoff (status ${response.status})`);
  }
  const data = (await response.json()) as { affected?: number };
  return { affected: data.affected ?? 0 };
};

/**
 * Records the user's judgement on specific faces — or withdraws it with
 * `verdict: null`, which returns them to the clustering engine's opinion.
 */
export const setFaceVerdicts = async (
  faceIds: number[],
  verdict: FaceVerdict | null,
): Promise<number> => {
  const response = await fetchWithDiagnostics("/api/people/verdict", "set face verdicts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ faceIds, verdict }),
  });
  if (!response.ok) {
    throw new Error(`Failed to set face verdict (status ${response.status})`);
  }
  const data = (await response.json()) as { applied?: number };
  return data.applied ?? 0;
};

/** A dry-run library-wide repair plan. Nothing is applied until the user acts on a row. */
export const fetchOptimizePlan = async (
  signal?: AbortSignal,
): Promise<OptimizeProposal[]> => {
  const payload = await fetchJsonOrThrow<{ proposals?: OptimizeProposal[] }>(
    "/api/people/optimize",
    "fetch optimize plan",
    { signal },
  );
  return payload.proposals ?? [];
};


/**
 * Re-derives a cluster's centre and radius from its current members, splitting
 * it when one cap cannot hold them without also covering a rejected face.
 */
export const refitCluster = async (
  clusterId: string,
): Promise<{ caps: number; uncovered: number }> => {
  const response = await fetchWithDiagnostics("/api/people/refit", "refit cluster", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clusterId }),
  });
  if (!response.ok) throw new Error(`Failed to refit (status ${response.status})`);
  const data = (await response.json()) as { caps?: number; uncovered?: number };
  return { caps: data.caps ?? 0, uncovered: data.uncovered ?? 0 };
};

export type CapChange = {
  /** How many faces the change moves. Includes the one you clicked. */
  affected: number;
  /** A handful of them, for a "this is what you're about to do" preview. */
  sample: ClusterFace[];
  faceIds: number[];
  /**
   * Only on shrink: false when the face sits closer to the centre than members
   * being kept, so no radius removes it and a per-face rejection is the tool.
   */
  excludable?: boolean;
};

const toCapChange = (payload: {
  affected?: number;
  sample?: ApiFaceRep[];
  faceIds?: number[];
  excludable?: boolean;
}): CapChange => ({
  affected: payload.affected ?? 0,
  sample: (payload.sample ?? []).map(toClusterFace),
  faceIds: payload.faceIds ?? [],
  ...(payload.excludable !== undefined ? { excludable: payload.excludable } : {}),
});

/** Tightens the radius until `faceId` falls outside. `dryRun` previews the cost. */
export const shrinkToExcludeFace = async ({
  clusterId,
  faceId,
  dryRun,
}: {
  clusterId: string;
  faceId: number;
  dryRun?: boolean;
}): Promise<CapChange> => {
  const response = await fetchWithDiagnostics(
    "/api/people/shrink-exclude",
    "shrink to exclude face",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clusterId, faceId, ...(dryRun ? { dryRun } : {}) }),
    },
  );
  if (!response.ok) throw new Error(`Failed to exclude (status ${response.status})`);
  return toCapChange(await response.json());
};

/** Widens a cluster towards `faceId`. `dryRun` lists who else the cap would cover. */
export const growToIncludeFace = async ({
  clusterId,
  faceId,
  dryRun,
  includeCollateral,
}: {
  clusterId: string;
  faceId: number;
  dryRun?: boolean;
  includeCollateral?: boolean;
}): Promise<CapChange> => {
  const response = await fetchWithDiagnostics(
    "/api/people/grow-include",
    "grow to include face",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clusterId,
        faceId,
        ...(dryRun ? { dryRun } : {}),
        ...(includeCollateral ? { includeCollateral } : {}),
      }),
    },
  );
  if (!response.ok) throw new Error(`Failed to include face (status ${response.status})`);
  return toCapChange(await response.json());
};

/** Gives a face its own cluster under the same person. */
export const startClusterForFace = async ({
  clusterId,
  faceId,
}: {
  clusterId: string;
  faceId: number;
}): Promise<{ clusterId: string }> => {
  const response = await fetchWithDiagnostics(
    "/api/people/new-cluster",
    "start cluster for face",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clusterId, faceId }),
    },
  );
  if (!response.ok) throw new Error(`Failed to start cluster (status ${response.status})`);
  const data = (await response.json()) as { clusterId: string };
  return { clusterId: data.clusterId };
};
