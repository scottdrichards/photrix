import type {
  BackgroundTaskStatus,
  DateRangeFilter,
  FaceAttributeFilter,
  GeoBoundsLike as GeoBounds,
  MediaTypeFilter,
  RatingFilter,
  ShareScope,
  SearchSource,
  ServerStatus as SharedServerStatus,
  ApiFilterOptions,
  SortOption,
} from "../../../shared/filter-contract/src";
export type { BackgroundTaskStatus, DateRangeFilter, FaceAttributeFilter, GeoBounds, MediaTypeFilter, RatingFilter, ShareScope, SearchSource, ApiFilterOptions, SortOption };

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
    /** Derived whole-photo quality aggregate, 0..1; see server's
     * photoQuality.ts. Absent until at least one detected face is scored. */
    photoQualityScore?: number;
    /** Moment (burst/near-duplicate) cluster id; absent if not grouped. */
    momentClusterId?: number;
    /** True when this photo is its cluster's chosen representative. */
    momentClusterRepresentative?: boolean;
    /** Member count of this photo's moment cluster (only present on the
     * representative row a collapsed gallery query returns). */
    momentClusterSize?: number;
    /** Relative paths of up to 2 other members of this photo's moment
     * cluster, for rendering real thumbnails peeking out behind the
     * collapsed representative tile (only present on the representative
     * row). */
    momentClusterPreviewPaths?: string[];
    [key: string]: unknown;
  };
}

export type GeoPoint = {
  path: string;
  name: string;
  latitude: number;
  longitude: number;
  count?: number;
  /**
   * Epoch ms of the oldest/newest item at this pin. Drives the map's age color
   * ramp and the chronological movement path; undefined when nothing in the
   * bucket carries a usable date.
   */
  minDate?: number;
  maxDate?: number;
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
  faceAttributeFilter?: FaceAttributeFilter | null;
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
  faceAttributeFilter?: FaceAttributeFilter | null;
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
  /**
   * `previewMaxSeconds` is only present for grid-preview negotiations. It is the
   * point the preview must loop at — for a cached HLS source it is the end of
   * the segments that already exist, so playing past it would make the server
   * start encoding.
   */
  | { mode: "hls"; url: string; reason: string; previewMaxSeconds?: number }
  | { mode: "direct"; url: string; reason: string; previewMaxSeconds?: number }
  | { mode: "error"; reason: string };

export type TranscriptSegment = { start: number; end: number; text: string };

/**
 * One photo inside a moment cluster (burst/near-duplicate group) — the
 * expanded stack view's per-member data. See the server's
 * indexDatabase.type.ts MomentClusterMember for the source shape.
 */
export type MomentClusterMember = {
  photo: PhotoItem;
  isRepresentative: boolean;
  sharpnessScore: number | null;
  photoQualityScore: number | null;
};

export type MomentClusterDetail = {
  id: string;
  members: MomentClusterMember[];
};

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
