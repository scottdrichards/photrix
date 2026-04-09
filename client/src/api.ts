import type {
  ApiFilterOptions,
  DateRangeFilter,
  GeoBoundsLike as GeoBounds,
  MediaTypeFilter,
  RatingFilter,
} from "../../shared/filter-contract/src";
export type { DateRangeFilter, GeoBounds };

export interface ApiPhotoItem {
  folder: string;
  fileName: string;
  mimeType?: string | null;
  dateTaken?: string | null;
  dimensionWidth?: number;
  dimensionHeight?: number;
  sizeInBytes?: number;
  created?: string;
  modified?: string;
  [key: string]: unknown;
}

export interface PhotoItem {
  path: string;
  name: string;
  mediaType: "photo" | "video";
  originalUrl: string;
  thumbnailUrl: string;
  previewUrl: string;
  fullUrl: string;
  videoPreviewUrl?: string;
  hlsUrl?: string;
  metadata?: {
    mimeType?: string | null;
    sizeInBytes?: number;
    duration?: number;
    videoCodec?: string;
    dateTaken?: string | null;
    dimensionWidth?: number;
    dimensionHeight?: number;
    locationLatitude?: number;
    locationLongitude?: number;
    [key: string]: unknown;
  };
}

export type GeoPoint = {
  path: string;
  name: string;
  latitude: number;
  longitude: number;
  count?: number;
};

export type DateHistogramBucket = {
  start: number;
  end: number;
  count: number;
};

export type DateHistogramResult = {
  buckets: DateHistogramBucket[];
  bucketSizeMs: number;
  minDate: number | null;
  maxDate: number | null;
  grouping: "day" | "month";
};

export interface ApiPhotoResponse {
  items: ApiPhotoItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FetchPhotosOptions {
  page?: number;
  pageSize?: number;
  metadata?: ReadonlyArray<string>;
  includeSubfolders?: boolean;
  path?: string;
  signal?: AbortSignal;
  ratingFilter?: RatingFilter | null;
  mediaTypeFilter?: MediaTypeFilter;
  locationBounds?: GeoBounds | null;
  dateRange?: DateRangeFilter | null;
  peopleInImageFilter?: ApiFilterOptions["peopleInImageFilter"];
  cameraModelFilter?: ApiFilterOptions["cameraModelFilter"];
  lensFilter?: ApiFilterOptions["lensFilter"];
}

export type SuggestionsField =
  | "personInImage"
  | "tags"
  | "aiTags"
  | "cameraMake"
  | "cameraModel"
  | "lens"
  | "rating";

export type FetchSuggestionsOptions = {
  field: SuggestionsField;
  q: string;
  allowBlankQuery?: boolean;
  includeCounts?: boolean;
  limit?: number;
  includeSubfolders?: boolean;
  path?: string;
  ratingFilter?: RatingFilter | null;
  mediaTypeFilter?: MediaTypeFilter;
  locationBounds?: GeoBounds | null;
  dateRange?: DateRangeFilter | null;
  peopleInImageFilter?: ApiFilterOptions["peopleInImageFilter"];
  cameraModelFilter?: ApiFilterOptions["cameraModelFilter"];
  lensFilter?: ApiFilterOptions["lensFilter"];
  signal?: AbortSignal;
};

export interface FetchPhotosResult {
  items: PhotoItem[];
  total: number;
  page: number;
  pageSize: number;
}

export type SuggestionWithCount = {
  value: string;
  count: number;
};

export type FaceQueueStatus = "unverified" | "confirmed" | "rejected";

export type FaceQueueItem = {
  faceId: string;
  relativePath: string;
  fileName: string;
  dateTaken?: number;
  dimensions: { x: number; y: number; width: number; height: number };
  person: { id: string; name?: string } | null;
  status: FaceQueueStatus;
  source?: "seed-known" | "auto-detected";
  suggestion?: {
    personId: string;
    confidence: number;
    modelVersion?: string;
    suggestedAt?: string;
  };
  quality?: {
    overall?: number;
    sharpness?: number;
    effectiveResolution?: number;
  };
  thumbnail?: {
    preferredHeight?: number;
    cropVersion?: string;
  };
};

export type FaceQueueResult = {
  items: FaceQueueItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type FaceMatchItem = {
  faceId: string;
  relativePath: string;
  fileName: string;
  dimensions: { x: number; y: number; width: number; height: number };
  confidence: number;
  thumbnail?: {
    preferredHeight?: number;
    cropVersion?: string;
  };
  person: { id: string; name?: string } | null;
  status: FaceQueueStatus;
};

export type FacePerson = {
  id: string;
  name?: string;
  count: number;
  representativeFace?: {
    faceId: string;
    relativePath: string;
    fileName: string;
    dimensions: { x: number; y: number; width: number; height: number };
    thumbnail?: {
      preferredHeight?: number;
      cropVersion?: string;
    };
  };
};

export interface FetchGeotaggedPhotosOptions
  extends Omit<FetchPhotosOptions, "page" | "pageSize" | "metadata"> {
  pageSize?: number;
  locationBounds?: GeoBounds | null;
  clusterSize?: number;
}

export type FetchDateRangeOptions = Omit<
  FetchPhotosOptions,
  "page" | "pageSize" | "metadata" | "dateRange"
>;

export type FetchDateHistogramOptions = Omit<
  FetchPhotosOptions,
  "page" | "pageSize" | "metadata"
>;

export type FetchFaceQueueOptions = {
  status?: FaceQueueStatus;
  personId?: string;
  minConfidence?: number;
  page?: number;
  pageSize?: number;
  path?: string;
  includeSubfolders?: boolean;
  signal?: AbortSignal;
};

export interface ProgressEntry {
  completed: number;
  total: number;
  percent: number;
}

export interface RecentMaintenance {
  folder: string;
  fileName: string;
  completedAt: string;
}

export interface ServerStatus {
  databaseSize: number;
  scannedFilesCount: number;
  queues: {
    pending: number;
    processing: number;
  };
  queueSummary: {
    completed: QueueSummaryByMedia;
    active: QueueSummaryByMedia;
    userBlocked: QueueSummaryByMedia;
    userImplicit: QueueSummaryByMedia;
    background: QueueSummaryByMedia;
  };
  pending: {
    info: number;
    exif: number;
  };
  maintenance: {
    exifActive: boolean;
    faceActive?: boolean;
    backgroundTasksEnabled?: boolean;
  };
  faceProcessing?: {
    processed: number;
    workerSuccess: number;
    fallbackCount: number;
    workerFailures: number;
  };
  progress: {
    overall: ProgressEntry;
    scanned: ProgressEntry;
    info: ProgressEntry;
    exif: ProgressEntry;
  };
  recent: {
    exif: RecentMaintenance | null;
  };
}

type QueueSummaryByMedia = {
  image: {
    count: number;
    sizeBytes: number;
  };
  video: {
    count: number;
    sizeBytes: number;
    durationMilliseconds: number;
  };
};

export const subscribeStatusStream = (
  onUpdate: (status: ServerStatus) => void,
  onError?: (error: unknown) => void,
) => {
  const source = new EventSource("/api/status/stream", { withCredentials: true });

  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as ServerStatus;
      onUpdate(data);
    } catch (error) {
      onError?.(error);
    }
  };

  source.onerror = (error) => {
    onError?.(error);
  };

  return () => source.close();
};

const DEFAULT_METADATA_KEYS = [
  "mimeType",
  "dimensionWidth",
  "dimensionHeight",
  "dateTaken",
  "sizeInBytes",
  "created",
  "modified",
  "cameraMake",
  "cameraModel",
  "exposureTime",
  "aperture",
  "iso",
  "focalLength",
  "lens",
  "rating",
  "tags",
  "locationLatitude",
  "locationLongitude",
  "orientation",
  "duration",
  "framerate",
  "videoCodec",
] as const;

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const normalizeBounds = (bounds: GeoBounds): GeoBounds => ({
  west: clampNumber(bounds.west, -180, 180),
  east: clampNumber(bounds.east, -180, 180),
  north: clampNumber(bounds.north, -90, 90),
  south: clampNumber(bounds.south, -90, 90),
});

const locationBoundsToFilter = (bounds: GeoBounds) => {
  const normalized = normalizeBounds(bounds);
  const north = Math.max(normalized.north, normalized.south);
  const south = Math.min(normalized.north, normalized.south);
  const east = normalized.east;
  const west = normalized.west;

  const latitudeRange = { locationLatitude: { min: south, max: north } };
  if (west <= east) {
    return {
      ...latitudeRange,
      locationLongitude: { min: west, max: east },
    };
  }

  // View crosses the international date line. Split into two longitude ranges.
  return {
    operation: "and",
    conditions: [
      latitudeRange,
      {
        operation: "or",
        conditions: [
          { locationLongitude: { min: west, max: 180 } },
          { locationLongitude: { min: -180, max: east } },
        ],
      },
    ],
  };
};

const dateRangeToFilter = (dateRange?: DateRangeFilter | null) => {
  if (!dateRange) {
    return null;
  }

  const { start, end } = dateRange;
  const hasStart = typeof start === "number" && Number.isFinite(start);
  const hasEnd = typeof end === "number" && Number.isFinite(end);

  if (!hasStart && !hasEnd) {
    return null;
  }

  return {
    dateTaken: {
      ...(hasStart ? { min: start } : {}),
      ...(hasEnd ? { max: end } : {}),
    },
  };
};

type BuildFiltersInput = {
  ratingFilter?: RatingFilter | null;
  mediaTypeFilter?: MediaTypeFilter;
  locationBounds?: GeoBounds | null;
  dateRange?: DateRangeFilter | null;
  peopleInImageFilter?: ApiFilterOptions["peopleInImageFilter"];
  cameraModelFilter?: ApiFilterOptions["cameraModelFilter"];
  lensFilter?: ApiFilterOptions["lensFilter"];
};

const normalizeDistinctNonEmpty = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));

const toStringIncludesFilter = (value: string) => {
  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? { includes: normalizedValue } : null;
};

const toStringArrayFilter = (value: string[] | string | null | undefined) => {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalizedValues = normalizeDistinctNonEmpty(value);
  return normalizedValues.length > 0 ? normalizedValues : null;
};

const addStringFilter = (
  filters: Record<string, unknown>[],
  field: "cameraModel" | "lens",
  value: string[] | string | null | undefined,
) => {
  const arrayFilter = toStringArrayFilter(value);
  if (arrayFilter) {
    filters.push({ [field]: arrayFilter });
    return;
  }

  if (typeof value !== "string") {
    return;
  }

  const includesFilter = toStringIncludesFilter(value);
  if (includesFilter) {
    filters.push({ [field]: includesFilter });
  }
};

const buildFilters = ({
  ratingFilter,
  mediaTypeFilter,
  locationBounds,
  dateRange,
  peopleInImageFilter,
  cameraModelFilter,
  lensFilter,
}: BuildFiltersInput) => {
  const filters: Record<string, unknown>[] = [];

  if (ratingFilter) {
    const ratingFilterObj = ratingFilter.atLeast
      ? { rating: { min: ratingFilter.rating } }
      : { rating: ratingFilter.rating };
    filters.push(ratingFilterObj);
  }

  if (mediaTypeFilter === "photo") {
    filters.push({ mimeType: { startsWith: "image/" } });
  } else if (mediaTypeFilter === "video") {
    filters.push({ mimeType: { startsWith: "video/" } });
  } else if (mediaTypeFilter === "other") {
    // Files that are neither images nor videos (null mimeType or other types like application/pdf)
    filters.push({
      operation: "and",
      conditions: [
        {
          operation: "or",
          conditions: [{ mimeType: null }, { mimeType: { notStartsWith: "image/" } }],
        },
        {
          operation: "or",
          conditions: [{ mimeType: null }, { mimeType: { notStartsWith: "video/" } }],
        },
      ],
    });
  }

  if (locationBounds) {
    filters.push(locationBoundsToFilter(locationBounds));
  }

  const dateFilter = dateRangeToFilter(dateRange);
  if (dateFilter) {
    filters.push(dateFilter);
  }

  const peopleFilter = toStringArrayFilter(peopleInImageFilter);
  if (peopleFilter) {
    filters.push({ personInImage: peopleFilter });
  } else if (typeof peopleInImageFilter === "string") {
    const includesFilter = toStringIncludesFilter(peopleInImageFilter);
    if (includesFilter) {
      filters.push({ personInImage: includesFilter });
    }
  }

  addStringFilter(filters, "cameraModel", cameraModelFilter);
  addStringFilter(filters, "lens", lensFilter);

  return filters;
};

const fetchJsonOrThrow = async <T>(
  url: string,
  errorLabel: string,
  init?: RequestInit,
): Promise<T> => {
  const response = await fetch(url, { ...init, credentials: "include" });
  if (!response.ok) {
    throw new Error(`Failed to ${errorLabel} (status ${response.status})`);
  }
  return (await response.json()) as T;
};

const buildFilesQueryUrl = (path: string, params: URLSearchParams) =>
  path ? `/api/files/${path}?${params.toString()}` : `/api/files/?${params.toString()}`;

const buildSuggestionParams = ({
  field,
  q,
  includeCounts,
  limit,
  includeSubfolders,
  path,
  ratingFilter,
  mediaTypeFilter,
  locationBounds,
  dateRange,
  peopleInImageFilter,
  cameraModelFilter,
  lensFilter,
}: {
  field: SuggestionsField;
  q: string;
  includeCounts: boolean;
  limit: number;
  includeSubfolders: boolean;
  path: string;
  ratingFilter?: RatingFilter | null;
  mediaTypeFilter?: MediaTypeFilter;
  locationBounds?: GeoBounds | null;
  dateRange?: DateRangeFilter | null;
  peopleInImageFilter?: ApiFilterOptions["peopleInImageFilter"];
  cameraModelFilter?: ApiFilterOptions["cameraModelFilter"];
  lensFilter?: ApiFilterOptions["lensFilter"];
}) => {
  const params = new URLSearchParams();
  params.set("field", field);
  params.set("q", q.trim());
  params.set("limit", String(limit));

  if (includeCounts) {
    params.set("includeCounts", "true");
  }
  if (includeSubfolders) {
    params.set("includeSubfolders", "true");
  }
  if (path) {
    params.set("path", path);
  }

  const filters = buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    cameraModelFilter,
    lensFilter,
  });
  if (filters.length > 0) {
    const filterObj =
      filters.length === 1 ? filters[0] : { operation: "and", conditions: filters };
    params.set("filter", JSON.stringify(filterObj));
  }

  return params;
};

export const fetchStatus = async (): Promise<ServerStatus> => {
  return await fetchJsonOrThrow<ServerStatus>("/api/status", "fetch status");
};

export const setBackgroundTasksEnabled = async (
  enabled: boolean,
): Promise<{ enabled: boolean }> => {
  return await fetchJsonOrThrow<{ enabled: boolean }>(
    "/api/status/background-tasks",
    "update background task setting",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ enabled }),
    },
  );
};

export const fetchFolders = async (path: string = "", signal?: AbortSignal): Promise<string[]> => {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const data = await fetchJsonOrThrow<{ folders: string[] }>(
    `/api/folders/${normalizedPath}`,
    "fetch folders",
    { signal },
  );
  return data.folders;
};

const buildFileUrl = (path: string, params: Record<string, string>): string => {
  // Use /api/files/{path} for individual file access (no trailing slash)
  // Strip leading slash from path since folder paths start with /
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(`/api/files/${normalizedPath}`, window.location.origin);
  // Add any transformation params (for future use)
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
};

const buildFallbackUrl = (path: string): string => {
  const url = new URL(`/api/uploads/${path}`, window.location.origin);
  return url.toString();
};

const createPhotoItem = (item: ApiPhotoItem): PhotoItem => {
  const relativePath = item.folder + item.fileName;
  const name = item.fileName;
  const mediaType = inferMediaType(item);
  const originalUrl = buildFileUrl(relativePath, {});
  const thumbnailUrl = buildFileUrl(relativePath, {
    representation: "webSafe",
    height: "320",
  });
  const previewUrl =
    mediaType === "video"
      ? thumbnailUrl
      : buildFileUrl(relativePath, {
          representation: "webSafe",
          height: "2160",
        });
  const fullUrl =
    mediaType === "video"
      ? buildFileUrl(relativePath, { representation: "webSafe", height: "2160" })
      : previewUrl;
  const videoPreviewUrl =
    mediaType === "video"
      ? buildFileUrl(relativePath, { representation: "preview" })
      : undefined;
  const hlsUrl =
    mediaType === "video"
      ? buildFileUrl(relativePath, { representation: "hls", height: "original" })
      : undefined;

  const metadata = Object.fromEntries(
    Object.entries(item).filter(([key]) => key !== "folder" && key !== "fileName"),
  );

  return {
    path: relativePath,
    name,
    mediaType,
    originalUrl,
    thumbnailUrl,
    previewUrl,
    fullUrl,
    videoPreviewUrl,
    hlsUrl,
    metadata,
  };
};

const inferMediaType = (item: ApiPhotoItem): "photo" | "video" => {
  const mime = item.mimeType ?? null;
  if (typeof mime === "string" && mime.toLowerCase().startsWith("video/")) {
    return "video";
  }
  const lowerName = item.fileName.toLowerCase();
  if (VIDEO_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
    return "video";
  }
  return "photo";
};

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".wmv"];

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
  cameraModelFilter,
  lensFilter,
}: FetchPhotosOptions = {}): Promise<FetchPhotosResult> => {
  const params = new URLSearchParams();
  params.set("metadata", Array.from(metadata).join(","));
  params.set("page", page.toString());
  params.set("pageSize", pageSize.toString());
  if (includeSubfolders) {
    params.set("includeSubfolders", "true");
  }

  const filters = buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    cameraModelFilter,
    lensFilter,
  });

  if (filters.length > 0) {
    const filterObj =
      filters.length === 1 ? filters[0] : { operation: "and", conditions: filters };
    params.set("filter", JSON.stringify(filterObj));
  }

  // Use /api/files/ with trailing slash to query for multiple files
  const url = buildFilesQueryUrl(path, params);
  const payload = await fetchJsonOrThrow<ApiPhotoResponse>(url, "fetch photos", {
    signal,
  });
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
  if (includeSubfolders) {
    params.set("includeSubfolders", "true");
  }
  if (
    typeof clusterSize === "number" &&
    Number.isFinite(clusterSize) &&
    clusterSize > 0
  ) {
    params.set("clusterSize", clusterSize.toString());
  }

  const filters = buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    cameraModelFilter,
    lensFilter,
  });

  if (filters.length > 0) {
    const filterObj =
      filters.length === 1 ? filters[0] : { operation: "and", conditions: filters };
    params.set("filter", JSON.stringify(filterObj));
  }

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

  const truncated = payload.total > coveredCount;

  return { points, total: payload.total, truncated };
};

export const fetchDateRange = async ({
  includeSubfolders = false,
  path = "",
  ratingFilter,
  mediaTypeFilter = "all",
  locationBounds,
  peopleInImageFilter,
  cameraModelFilter,
  lensFilter,
  signal,
}: FetchDateRangeOptions = {}): Promise<{
  minDate: number | null;
  maxDate: number | null;
}> => {
  const params = new URLSearchParams();
  params.set("aggregate", "dateRange");
  if (includeSubfolders) {
    params.set("includeSubfolders", "true");
  }

  const filters = buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange: null,
    peopleInImageFilter,
    cameraModelFilter,
    lensFilter,
  });

  if (filters.length > 0) {
    const filterObj =
      filters.length === 1 ? filters[0] : { operation: "and", conditions: filters };
    params.set("filter", JSON.stringify(filterObj));
  }

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
  cameraModelFilter,
  lensFilter,
  signal,
}: FetchDateHistogramOptions = {}): Promise<DateHistogramResult> => {
  const params = new URLSearchParams();
  params.set("aggregate", "dateHistogram");
  if (includeSubfolders) {
    params.set("includeSubfolders", "true");
  }

  const filters = buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    cameraModelFilter,
    lensFilter,
  });

  if (filters.length > 0) {
    const filterObj =
      filters.length === 1 ? filters[0] : { operation: "and", conditions: filters };
    params.set("filter", JSON.stringify(filterObj));
  }

  const url = buildFilesQueryUrl(path, params);
  return await fetchJsonOrThrow<DateHistogramResult>(url, "fetch date histogram", {
    signal,
  });
};

export const createFallbackPhoto = (path: string): PhotoItem => {
  const name = path.split("/").pop() ?? path;
  return {
    path,
    name,
    mediaType: "photo",
    originalUrl: buildFallbackUrl(path),
    thumbnailUrl: buildFallbackUrl(path),
    previewUrl: buildFallbackUrl(path),
    fullUrl: buildFallbackUrl(path),
  };
};

export const fetchSuggestions = async ({
  field,
  q,
  allowBlankQuery = false,
  includeCounts = false,
  limit = 8,
  includeSubfolders = false,
  path = "",
  ratingFilter,
  mediaTypeFilter = "all",
  locationBounds,
  dateRange,
  peopleInImageFilter,
  cameraModelFilter,
  lensFilter,
  signal,
}: FetchSuggestionsOptions): Promise<string[]> => {
  const normalizedQuery = q.trim();
  if (!allowBlankQuery && normalizedQuery.length === 0) {
    return [];
  }
  const params = buildSuggestionParams({
    field,
    q: normalizedQuery,
    includeCounts,
    limit,
    includeSubfolders,
    path,
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    cameraModelFilter,
    lensFilter,
  });

  const payload = await fetchJsonOrThrow<{ suggestions: string[] }>(
    `/api/suggestions?${params.toString()}`,
    "fetch suggestions",
    { signal },
  );
  return payload.suggestions;
};

export const fetchSuggestionsWithCounts = async ({
  field,
  q,
  allowBlankQuery = false,
  includeCounts = true,
  limit = 8,
  includeSubfolders = false,
  path = "",
  ratingFilter,
  mediaTypeFilter = "all",
  locationBounds,
  dateRange,
  peopleInImageFilter,
  cameraModelFilter,
  lensFilter,
  signal,
}: FetchSuggestionsOptions): Promise<SuggestionWithCount[]> => {
  const normalizedQuery = q.trim();
  if (!allowBlankQuery && normalizedQuery.length === 0) {
    return [];
  }
  const params = buildSuggestionParams({
    field,
    q: normalizedQuery,
    includeCounts,
    limit,
    includeSubfolders,
    path,
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    cameraModelFilter,
    lensFilter,
  });

  const payload = await fetchJsonOrThrow<{ suggestions: SuggestionWithCount[] }>(
    `/api/suggestions?${params.toString()}`,
    "fetch suggestions",
    { signal },
  );
  return payload.suggestions;
};

export const fetchFaceQueue = async ({
  status,
  personId,
  minConfidence,
  page = 1,
  pageSize = 100,
  path,
  includeSubfolders,
  signal,
}: FetchFaceQueueOptions = {}): Promise<FaceQueueResult> => {
  const params = new URLSearchParams();
  params.set("page", page.toString());
  params.set("pageSize", pageSize.toString());
  if (status) {
    params.set("status", status);
  }
  if (personId) {
    params.set("personId", personId);
  }
  if (typeof minConfidence === "number" && Number.isFinite(minConfidence)) {
    params.set("minConfidence", minConfidence.toString());
  }
  if (path) {
    params.set("path", path);
  }
  if (typeof includeSubfolders === "boolean") {
    params.set("includeSubfolders", includeSubfolders.toString());
  }

  return await fetchJsonOrThrow<FaceQueueResult>(
    `/api/faces/queue?${params.toString()}`,
    "fetch face queue",
    { signal },
  );
};

export const fetchFacePeople = async (options: {
  path?: string;
  includeSubfolders?: boolean;
  signal?: AbortSignal;
} = {}): Promise<FacePerson[]> => {
  const { path, includeSubfolders, signal } = options;
  const params = new URLSearchParams();
  if (path) {
    params.set("path", path);
  }
  if (typeof includeSubfolders === "boolean") {
    params.set("includeSubfolders", includeSubfolders.toString());
  }
  const query = params.toString() ? `?${params.toString()}` : "";
  const payload = await fetchJsonOrThrow<{ people: FacePerson[] }>(
    `/api/faces/people${query}`,
    "fetch face people",
    { signal },
  );
  return payload.people;
};

export const fetchFaceMatches = async (options: {
  faceId: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FaceMatchItem[]> => {
  const { faceId, limit = 8, signal } = options;
  const params = new URLSearchParams({ limit: String(limit) });

  const payload = await fetchJsonOrThrow<{ items: FaceMatchItem[] }>(
    `/api/faces/${encodeURIComponent(faceId)}/matches?${params.toString()}`,
    "fetch face matches",
    { signal },
  );
  return payload.items;
};

export const fetchFacePersonSuggestions = async (options: {
  personId: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<FaceMatchItem[]> => {
  const { personId, limit = 200, signal } = options;
  const params = new URLSearchParams({ limit: String(limit) });

  const payload = await fetchJsonOrThrow<{ items: FaceMatchItem[] }>(
    `/api/faces/people/${encodeURIComponent(personId)}/suggestions?${params.toString()}`,
    "fetch person face suggestions",
    { signal },
  );
  return payload.items;
};

export const acceptFaceSuggestion = async (options: {
  faceId: string;
  personId?: string;
  personName?: string;
  reviewer?: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; action: "accept"; faceId: string }> => {
  const { faceId, personId, personName, reviewer, signal } = options;

  return await fetchJsonOrThrow<{ ok: true; action: "accept"; faceId: string }>(
    `/api/faces/${encodeURIComponent(faceId)}/accept`,
    "accept face suggestion",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(personId ? { personId } : {}),
        ...(personName ? { personName } : {}),
        ...(reviewer ? { reviewer } : {}),
      }),
      signal,
    },
  );
};

export const rejectFaceSuggestion = async (options: {
  faceId: string;
  personId?: string;
  reviewer?: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; action: "reject"; faceId: string }> => {
  const { faceId, personId, reviewer, signal } = options;

  return await fetchJsonOrThrow<{ ok: true; action: "reject"; faceId: string }>(
    `/api/faces/${encodeURIComponent(faceId)}/reject`,
    "reject face suggestion",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(personId ? { personId } : {}),
        ...(reviewer ? { reviewer } : {}),
      }),
      signal,
    },
  );
};
