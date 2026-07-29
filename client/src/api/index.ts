// Public API surface — all consumers import from 'api' or 'api/index'.
// Internal modules (http, filters, photoItem) are not re-exported; only
// the public-facing types and functions appear here.

export type {
  BackgroundTaskStatus,
  DateRangeFilter,
  GeoBounds,
  SearchSource,
  ApiPhotoItem,
  PhotoItem,
  GeoPoint,
  DateHistogramBucket,
  DateHistogramResult,
  FaceBox,
  ClusterFace,
  PersonCluster,
  PersonClusterWithFaces,
  PersonCentroid,
  PeopleClustersResult,
  PersonClusterDetailResult,
  ApiPhotoResponse,
  FetchPhotosOptions,
  FetchFoldersOptions,
  SuggestionsField,
  FetchSuggestionsOptions,
  FetchPhotosResult,
  SuggestionWithCount,
  FolderSummary,
  FetchGeotaggedPhotosOptions,
  FetchDateRangeOptions,
  FetchDateHistogramOptions,
  FetchPeopleClustersOptions,
  ProgressEntry,
  ServerStatus,
  SemanticSearchResult,
  FetchSemanticSearchOptions,
  VideoNegotiationResult,
  TranscriptSegment,
  FaceClusterPCAPoint,
} from "./types";

export { buildFullShareFilter, buildShareScope } from "./filters";

export { subscribeStatusStream, fetchStatus, setBackgroundTasksEnabled } from "./status";

export {
  fetchFolders,
  fetchPhotos,
  fetchGeotaggedPhotos,
  buildGeoPointThumbnailUrl,
  fetchDateRange,
  fetchDateHistogram,
  fetchSemanticSearch,
  updatePhotoMetadata,
} from "./photos";

export type { PhotoMetadataPatch } from "./photos";

export { createFallbackPhoto } from "./photoItem";

export {
  fetchPeopleClusters,
  fetchClusterDetail,
  fetchFaceClustersPCA,
  fetchPeopleFacesForFile,
  buildFaceCropUrl,
  renameCluster,
  mergeClusters,
  separateCluster,
} from "./people";

export { fetchSuggestions, fetchSuggestionsWithCounts } from "./suggestions";

export { negotiateVideoPlayback, fetchTranscriptSegments } from "./video";

export { interpretSearchQuery } from "./naturalLanguageSearch";
