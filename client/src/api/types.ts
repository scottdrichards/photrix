import type {
  BackgroundTaskStatus,
  DateRangeFilter,
  GeoBoundsLike as GeoBounds,
  MediaTypeFilter,
  RatingFilter,
  ShareScope,
  SearchSource,
  ServerStatus as SharedServerStatus,
  ApiFilterOptions,
  SortOption,
} from "../../../shared/filter-contract/src";
export type { BackgroundTaskStatus, DateRangeFilter, GeoBounds, MediaTypeFilter, RatingFilter, ShareScope, SearchSource, ApiFilterOptions, SortOption };

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
  searchSources?: SearchSource[];
  originalUrl: string;
  thumbnailUrl: string;
  microThumbnailUrl?: string;
  previewUrl: string;
  fullUrl: string;
  videoPreviewUrl?: string;
  hlsUrl?: string;
  livePhotoUrl?: string;
  metadata?: {
    mimeType?: string | null;
    sizeInBytes?: number;
    duration?: number;
    videoCodec?: string;
    dateTaken?: string | null;
    description?: string | null;
    aiDescription?: string | null;
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
  grouping: "day" | "month" | "year";
};

export type FaceBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ClusterFace = {
  photo: PhotoItem;
  box: FaceBox;
};

/**
 * A face detected in a specific photo, resolved to its People cluster. Powers
 * the clickable name labels in the fullscreen face overlay. `personId` is the
 * `person-N` cluster id used for People deep links; `name` is null when the
 * person hasn't been named.
 */
export type PhotoPersonFace = {
  box: FaceBox;
  personId: string;
  name: string | null;
};

export type PersonCluster = {
  id: string;
  count: number;
  representative: ClusterFace;
  name: string | null;
  yearRangeLabel?: string | null;
};

export type PersonClusterWithFaces = PersonCluster & {
  faces: ClusterFace[];
  centroids: PersonCentroid[];
  mergeSuggestions: PersonCluster[];
};

export type PersonCentroid = {
  id: string;
  count: number;
  representative: ClusterFace;
};

export type PeopleClustersResult = {
  clusters: PersonCluster[];
  totalFaces: number;
  totalClusters: number;
  /** Faces awaiting background clustering — non-zero means the list is still growing. */
  pendingFaces: number;
};

export type PersonClusterDetailResult = {
  cluster: PersonClusterWithFaces | null;
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
  faceClusterFilter?: ApiFilterOptions["faceClusterFilter"];
  cameraModelFilter?: ApiFilterOptions["cameraModelFilter"];
  lensFilter?: ApiFilterOptions["lensFilter"];
  expandToFolder?: boolean;
  /** Result ordering; omit for the server default (newest first). */
  sortBy?: SortOption;
}

export type FetchFoldersOptions = Omit<
  FetchPhotosOptions,
  "page" | "pageSize" | "metadata" | "expandToFolder"
>;

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
  faceClusterFilter?: ApiFilterOptions["faceClusterFilter"];
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

export type FolderSummary = {
  name: string;
  count: number;
};

export interface FetchGeotaggedPhotosOptions extends Omit<
  FetchPhotosOptions,
  "page" | "pageSize" | "metadata"
> {
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
> & {
  /** Desired number of histogram buckets; server clamps to [12, 80]. */
  buckets?: number;
};

export type FetchPeopleClustersOptions = Omit<
  FetchPhotosOptions,
  "page" | "pageSize" | "metadata"
>;

export type ProgressEntry = {
  completed: number;
  total: number;
  percent: number;
};

export type ServerStatus = SharedServerStatus;

export type SemanticSearchResult = {
  items: (ApiPhotoItem & { similarity: number; sources?: SearchSource[] })[];
  total: number;
  query: string;
};

export type FetchSemanticSearchOptions = {
  q: string;
  limit?: number;
  signal?: AbortSignal;
  /** Restrict the search to these sources; omit to use all of them. */
  searchSources?: SearchSource[];
} & Omit<FetchPhotosOptions, "page" | "pageSize" | "metadata">;

export type VideoNegotiationResult =
  | { mode: "hls"; url: string; reason: string }
  | { mode: "direct"; url: string; reason: string }
  | { mode: "error"; reason: string };

export type TranscriptSegment = { start: number; end: number; text: string };

export type FaceClusterPCAPoint = {
  id: string;
  count: number;
  name: string | null;
  representative: ClusterFace;
  x: number;
  y: number;
  z: number;
  focused: boolean;
};
