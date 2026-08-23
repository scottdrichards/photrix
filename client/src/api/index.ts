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
  MomentClusterMember,
  MomentClusterDetail,
} from "./types";

export { buildFullShareFilter, buildShareScope } from "./filters";

export { subscribeStatusStream, fetchStatus, setBackgroundTasksEnabled, clearHlsSessions } from "./status";

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

export { createFallbackPhoto, buildMomentClusterPreviewUrl } from "./photoItem";

export {
  fetchPeopleClusters,
  fetchClusterDetail,
  fetchFaceClustersPCA,
  fetchPeopleFacesForFile,
  buildFaceCropUrl,
  renameCluster,
  mergeClusters,
  separateCluster,
  setPersonTags,
  fetchAllPersonTags,
  excludeFaceFromCluster,
} from "./people";

export {
  fetchMomentClusterDetail,
  setMomentClusterRepresentative,
  dissolveMomentCluster,
} from "./momentClusters";

export { fetchSuggestions, fetchSuggestionsWithCounts } from "./suggestions";

export { negotiateVideoPlayback, fetchTranscriptSegments } from "./video";

export { interpretSearchQuery } from "./naturalLanguageSearch";

export type { FeedbackItem, FeedbackStatus } from "./feedback";
export { fetchFeedbackItems } from "./feedback";

export { fetchPhotoCaption } from "./photoCaption";

export type { DefaultExclusionFilter } from "./settings";
export { fetchDefaultExclusionFilter, setDefaultExclusionFilter } from "./settings";
