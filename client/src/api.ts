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
  thumbnailUrl: string;
  previewUrl: string;
  fullUrl: string;
  videoPreviewUrl?: string;
  hlsUrl?: string;
  metadata?: {
    mimeType?: string | null;
    dateTaken?: string | null;
    dimensionWidth?: number;
    dimensionHeight?: number;
    locationLatitude?: number;
    locationLongitude?: number;
    [key: string]: unknown;
  };
}

export type GeoBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type GeoPoint = {
  path: string;
  name: string;
  latitude: number;
  longitude: number;
  count?: number;
};

export type DateRangeFilter = {
  start?: number;
  end?: number;
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
  ratingFilter?: { rating: number; atLeast: boolean } | null;
  mediaTypeFilter?: "all" | "photo" | "video" | "other";
  locationBounds?: GeoBounds | null;
  dateRange?: DateRangeFilter | null;
}

export interface FetchPhotosResult {
  items: PhotoItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FetchGeotaggedPhotosOptions extends Omit<FetchPhotosOptions, "page" | "pageSize" | "metadata"> {
  pageSize?: number;
  locationBounds?: GeoBounds | null;
  clusterSize?: number;
}

export interface FetchDateRangeOptions extends Omit<FetchPhotosOptions, "page" | "pageSize" | "metadata" | "dateRange"> {}

export interface FetchDateHistogramOptions extends Omit<FetchPhotosOptions, "page" | "pageSize" | "metadata"> {}

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
  pending: {
    info: number;
    exif: number;
  };
  maintenance: {
    exifActive: boolean;
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

export const subscribeStatusStream = (
  onUpdate: (status: ServerStatus) => void,
  onError?: (error: unknown) => void,
) => {
  const source = new EventSource("/api/status/stream");

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
] as const;

const clampNumber = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

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
  ratingFilter?: { rating: number; atLeast: boolean } | null;
  mediaTypeFilter?: "all" | "photo" | "video" | "other";
  locationBounds?: GeoBounds | null;
  dateRange?: DateRangeFilter | null;
};

const buildFilters = ({ ratingFilter, mediaTypeFilter, locationBounds, dateRange }: BuildFiltersInput) => {
  const filters: any[] = [];

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
          conditions: [
            { mimeType: null },
            { mimeType: { notStartsWith: "image/" } },
          ],
        },
        {
          operation: "or",
          conditions: [
            { mimeType: null },
            { mimeType: { notStartsWith: "video/" } },
          ],
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

  return filters;
};

export const fetchStatus = async (): Promise<ServerStatus> => {
  const response = await fetch("/api/status");
  if (!response.ok) {
    throw new Error(`Failed to fetch status (status ${response.status})`);
  }
  return await response.json();
};

export const fetchFolders = async (path: string = ""): Promise<string[]> => {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const response = await fetch(`/api/folders/${normalizedPath}`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch folders (status ${response.status})`);
  }
  
  const data = await response.json() as { folders: string[] };
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

  // Include all metadata from the API response
  const { folder, fileName, ...metadata } = item;
  
  return {
    path: relativePath,
    name,
    mediaType,
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
}: FetchPhotosOptions = {}): Promise<FetchPhotosResult> => {
  const params = new URLSearchParams();
  params.set("metadata", Array.from(metadata).join(","));
  params.set("page", page.toString());
  params.set("pageSize", pageSize.toString());
  if (includeSubfolders) {
    params.set("includeSubfolders", "true");
  }
  
  const filters = buildFilters({ ratingFilter, mediaTypeFilter, locationBounds, dateRange });
  
  if (filters.length > 0) {
    const filterObj = filters.length === 1 ? filters[0] : { operation: "and", conditions: filters };
    params.set("filter", JSON.stringify(filterObj));
  }

  // Use /api/files/ with trailing slash to query for multiple files
  const url = path ? `/api/files/${path}?${params.toString()}` : `/api/files/?${params.toString()}`;
  const response = await fetch(url, { signal });

  if (!response.ok) {
    throw new Error(`Failed to fetch photos (status ${response.status})`);
  }

  const payload = (await response.json()) as ApiPhotoResponse;
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
  signal,
}: FetchGeotaggedPhotosOptions = {}): Promise<{ points: GeoPoint[]; total: number; truncated: boolean }> => {
  const params = new URLSearchParams();
  params.set("cluster", "true");
  params.set("pageSize", pageSize.toString());
  if (includeSubfolders) {
    params.set("includeSubfolders", "true");
  }
  if (typeof clusterSize === "number" && Number.isFinite(clusterSize) && clusterSize > 0) {
    params.set("clusterSize", clusterSize.toString());
  }

  const filters = buildFilters({ ratingFilter, mediaTypeFilter, locationBounds, dateRange });

  if (filters.length > 0) {
    const filterObj = filters.length === 1 ? filters[0] : { operation: "and", conditions: filters };
    params.set("filter", JSON.stringify(filterObj));
  }

  if (locationBounds) {
    params.set("west", locationBounds.west.toString());
    params.set("east", locationBounds.east.toString());
    params.set("north", locationBounds.north.toString());
    params.set("south", locationBounds.south.toString());
  }

  const url = path ? `/api/files/${path}?${params.toString()}` : `/api/files/?${params.toString()}`;
  const response = await fetch(url, { signal });

  if (!response.ok) {
    throw new Error(`Failed to fetch geotagged photos (status ${response.status})`);
  }

  const payload = await response.json() as {
    clusters: Array<{ latitude: number; longitude: number; count: number; samplePath?: string; sampleName?: string }>;
    total: number;
  };

  const coveredCount = payload.clusters.reduce((sum, cluster) => sum + (cluster.count ?? 0), 0);
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
  signal,
}: FetchDateRangeOptions = {}): Promise<{ minDate: number | null; maxDate: number | null }> => {
  const params = new URLSearchParams();
  params.set("aggregate", "dateRange");
  if (includeSubfolders) {
    params.set("includeSubfolders", "true");
  }

  const filters = buildFilters({ ratingFilter, mediaTypeFilter, locationBounds, dateRange: null });

  if (filters.length > 0) {
    const filterObj = filters.length === 1 ? filters[0] : { operation: "and", conditions: filters };
    params.set("filter", JSON.stringify(filterObj));
  }

  const url = path ? `/api/files/${path}?${params.toString()}` : `/api/files/?${params.toString()}`;
  const response = await fetch(url, { signal });

  if (!response.ok) {
    throw new Error(`Failed to fetch date range (status ${response.status})`);
  }

  return await response.json() as { minDate: number | null; maxDate: number | null };
};

export const fetchDateHistogram = async ({
  includeSubfolders = false,
  path = "",
  ratingFilter,
  mediaTypeFilter = "all",
  locationBounds,
  dateRange,
  signal,
}: FetchDateHistogramOptions = {}): Promise<DateHistogramResult> => {
  const params = new URLSearchParams();
  params.set("aggregate", "dateHistogram");
  if (includeSubfolders) {
    params.set("includeSubfolders", "true");
  }

  const filters = buildFilters({ ratingFilter, mediaTypeFilter, locationBounds, dateRange });

  if (filters.length > 0) {
    const filterObj = filters.length === 1 ? filters[0] : { operation: "and", conditions: filters };
    params.set("filter", JSON.stringify(filterObj));
  }

  const url = path ? `/api/files/${path}?${params.toString()}` : `/api/files/?${params.toString()}`;
  const response = await fetch(url, { signal });

  if (!response.ok) {
    throw new Error(`Failed to fetch date histogram (status ${response.status})`);
  }

  return await response.json() as DateHistogramResult;
};

export const createFallbackPhoto = (path: string): PhotoItem => {
  const name = path.split("/").pop() ?? path;
  return {
    path,
    name,
    mediaType: "photo",
    thumbnailUrl: buildFallbackUrl(path),
    previewUrl: buildFallbackUrl(path),
    fullUrl: buildFallbackUrl(path),
  };
};
