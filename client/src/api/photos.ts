import { serializeSort } from "../../../shared/filter-contract/src";
import { buildFilters, filtersToParam } from "./filters";
import { fetchJsonOrThrow } from "./http";
import { buildFilesQueryUrl, buildFileUrl, createPhotoItem, DEFAULT_METADATA_KEYS } from "./photoItem";
import type {
  ApiPhotoResponse,
  FetchDateHistogramOptions,
  FetchDateRangeOptions,
  FetchGeotaggedPhotosOptions,
  FetchPhotosOptions,
  FetchPhotosResult,
  FetchSemanticSearchOptions,
  FolderSummary,
  DateHistogramResult,
  GeoPoint,
} from "./types";

export const fetchFolders = async ({
  path = "",
  signal,
  ratingFilter,
  mediaTypeFilter = "all",
  locationBounds,
  dateRange,
  peopleInImageFilter,
  faceClusterFilter,
  cameraModelFilter,
  lensFilter,
}: FetchPhotosOptions = {}): Promise<FolderSummary[]> => {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const params = new URLSearchParams();
  const filters = buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    cameraModelFilter,
    lensFilter,
  });

  const filterParam = filtersToParam(filters);
  if (filterParam) params.set("filter", filterParam);

  const querySuffix = params.size > 0 ? `?${params.toString()}` : "";
  // Encode per segment: a folder named "#2 Dessert Night" would otherwise be cut
  // off at the '#' as a URL fragment and never reach the server.
  const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
  const data = await fetchJsonOrThrow<{ folders: FolderSummary[] }>(
    `/api/folders/${encodedPath}${querySuffix}`,
    "fetch folders",
    { signal },
  );
  return data.folders;
};

export const fetchPhotos = async ({
  page = 1,
  pageSize = 200,
  metadata = DEFAULT_METADATA_KEYS,
  includeSubfolders = false,
  path = "",
  signal,
  ratingFilter,
  mediaTypeFilter = "all",
  locationBounds,
  dateRange,
  peopleInImageFilter,
  faceClusterFilter,
  cameraModelFilter,
  lensFilter,
  expandToFolder,
  sortBy,
}: FetchPhotosOptions = {}): Promise<FetchPhotosResult> => {
  const params = new URLSearchParams();
  params.set("metadata", Array.from(metadata).join(","));
  params.set("page", page.toString());
  params.set("pageSize", pageSize.toString());
  if (includeSubfolders) params.set("includeSubfolders", "true");
  if (expandToFolder) params.set("expandToFolder", "true");
  if (sortBy) params.set("sort", serializeSort(sortBy));

  const filterParam = filtersToParam(buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    cameraModelFilter,
    lensFilter,
  }));
  if (filterParam) params.set("filter", filterParam);

  const url = buildFilesQueryUrl(path, params);
  const payload = await fetchJsonOrThrow<ApiPhotoResponse>(url, "fetch photos", { signal });
  return {
    items: payload.items.map(createPhotoItem),
    total: payload.total,
    page: payload.page,
    pageSize: payload.pageSize,
  };
};

export const fetchGeotaggedPhotos = async ({
  pageSize = 1_000,
  locationBounds,
  clusterSize,
  includeSubfolders = false,
  path = "",
  ratingFilter,
  mediaTypeFilter = "all",
  dateRange,
  peopleInImageFilter,
  faceClusterFilter,
  cameraModelFilter,
  lensFilter,
  signal,
}: FetchGeotaggedPhotosOptions = {}): Promise<{
  points: GeoPoint[];
  total: number;
  truncated: boolean;
}> => {
  const params = new URLSearchParams();
  params.set("cluster", "true");
  params.set("pageSize", pageSize.toString());
  if (includeSubfolders) params.set("includeSubfolders", "true");
  if (typeof clusterSize === "number" && Number.isFinite(clusterSize) && clusterSize > 0) {
    params.set("clusterSize", clusterSize.toString());
  }

  const filterParam = filtersToParam(buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    cameraModelFilter,
    lensFilter,
  }));
  if (filterParam) params.set("filter", filterParam);

  if (locationBounds) {
    params.set("west", locationBounds.west.toString());
    params.set("east", locationBounds.east.toString());
    params.set("north", locationBounds.north.toString());
    params.set("south", locationBounds.south.toString());
  }

  const url = buildFilesQueryUrl(path, params);
  const payload = await fetchJsonOrThrow<{
    clusters: Array<{
      latitude: number;
      longitude: number;
      count: number;
      samplePath?: string;
      sampleName?: string;
    }>;
    total: number;
  }>(url, "fetch geotagged photos", { signal });

  const coveredCount = payload.clusters.reduce(
    (sum, cluster) => sum + (cluster.count ?? 0),
    0,
  );
  const points: GeoPoint[] = payload.clusters.map((cluster) => ({
    path: cluster.samplePath ?? "",
    name: cluster.sampleName ?? `${cluster.count} items`,
    latitude: cluster.latitude,
    longitude: cluster.longitude,
    count: cluster.count,
  }));

  return { points, total: payload.total, truncated: payload.total > coveredCount };
};

export const fetchDateRange = async ({
  includeSubfolders = false,
  path = "",
  ratingFilter,
  mediaTypeFilter = "all",
  locationBounds,
  peopleInImageFilter,
  faceClusterFilter,
  cameraModelFilter,
  lensFilter,
  signal,
}: FetchDateRangeOptions = {}): Promise<{
  minDate: number | null;
  maxDate: number | null;
}> => {
  const params = new URLSearchParams();
  params.set("aggregate", "dateRange");
  if (includeSubfolders) params.set("includeSubfolders", "true");

  const filterParam = filtersToParam(buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange: null,
    peopleInImageFilter,
    faceClusterFilter,
    cameraModelFilter,
    lensFilter,
  }));
  if (filterParam) params.set("filter", filterParam);

  const url = buildFilesQueryUrl(path, params);
  return await fetchJsonOrThrow<{ minDate: number | null; maxDate: number | null }>(
    url,
    "fetch date range",
    { signal },
  );
};

export const fetchDateHistogram = async ({
  includeSubfolders = false,
  path = "",
  ratingFilter,
  mediaTypeFilter = "all",
  locationBounds,
  dateRange,
  peopleInImageFilter,
  faceClusterFilter,
  cameraModelFilter,
  lensFilter,
  buckets,
  signal,
}: FetchDateHistogramOptions = {}): Promise<DateHistogramResult> => {
  const params = new URLSearchParams();
  params.set("aggregate", "dateHistogram");
  if (includeSubfolders) params.set("includeSubfolders", "true");
  if (typeof buckets === "number" && Number.isFinite(buckets)) {
    params.set("buckets", String(Math.round(buckets)));
  }

  const filterParam = filtersToParam(buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    cameraModelFilter,
    lensFilter,
  }));
  if (filterParam) params.set("filter", filterParam);

  const url = buildFilesQueryUrl(path, params);
  return await fetchJsonOrThrow<DateHistogramResult>(url, "fetch date histogram", { signal });
};

export const fetchSemanticSearch = async ({
  q,
  limit = 50,
  signal,
  searchSources,
  includeSubfolders = false,
  path = "",
  ratingFilter,
  mediaTypeFilter = "all",
  locationBounds,
  dateRange,
  peopleInImageFilter,
  faceClusterFilter,
  cameraModelFilter,
  lensFilter,
  sortBy,
}: FetchSemanticSearchOptions): Promise<FetchPhotosResult & { query: string }> => {
  const params = new URLSearchParams();
  params.set("q", q.trim());
  params.set("limit", String(limit));
  if (includeSubfolders) params.set("includeSubfolders", "true");
  if (path) params.set("path", path);
  // Only send `sources` when a subset is selected; absent means "all sources".
  if (searchSources) params.set("sources", searchSources.join(","));
  if (sortBy) params.set("sort", serializeSort(sortBy));

  const filterParam = filtersToParam(buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    cameraModelFilter,
    lensFilter,
  }));
  if (filterParam) params.set("filter", filterParam);

  type SemanticSearchResult = {
    items: (import("./types").ApiPhotoItem & { similarity: number; sources?: import("./types").SearchSource[] })[];
    total: number;
    query: string;
  };
  const payload = await fetchJsonOrThrow<SemanticSearchResult>(
    `/api/search?${params.toString()}`,
    "semantic search",
    { signal },
  );

  return {
    items: payload.items.map((item) => ({
      ...createPhotoItem(item),
      searchSources: item.sources,
    })),
    total: payload.total,
    page: 1,
    pageSize: limit,
    query: payload.query,
  };
};

export const fetchFileUrl = (path: string, params: Record<string, string>): string =>
  buildFileUrl(path, params);

export type PhotoMetadataPatch = {
  /** 1–5, or null/0 to clear the rating. */
  rating?: number | null;
  /** Freeform labels; replaces the existing set. */
  tags?: string[];
  /** JSON-serialized EditAdj, or null to clear all edits. */
  editAdj?: string | null;
};

/**
 * Persists user tagging (star rating and/or labels) for a single file.
 * Sends a PATCH to /api/files/{path}; leading slash is stripped to match the
 * file-serving path shape.
 */
export const updatePhotoMetadata = async (
  path: string,
  patch: PhotoMetadataPatch,
): Promise<void> => {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`/api/files/${encodedPath}`, window.location.origin);
  await fetchJsonOrThrow<{ ok: true }>(url.toString(), "update photo metadata", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
};
