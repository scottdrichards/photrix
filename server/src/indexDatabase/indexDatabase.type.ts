import { FileRecord } from "./fileRecord.type.ts";
import type {
  FaceMatchFilter,
  FileQueryExtraField,
  FilterElement as SharedFilterElement,
  RecordFilterCondition,
  SortOption,
  StringSearch,
} from "../../../shared/filter-contract/src/index.ts";
export type {
  Range,
  SortOption,
  StringSearch,
} from "../../../shared/filter-contract/src/index.ts";

export type RuntimeSemanticSimilarityFilter = {
  queryVector: number[];
  minSimilarity: number;
};

export type FilterField =
  | keyof FileRecord
  | FileQueryExtraField
  | "semanticImage"
  | "semanticAudio"
  | "transcriptSearch";

type BaseFilterCondition = RecordFilterCondition<FileRecord, "relativePath">;

export type FilterCondition = BaseFilterCondition & {
  hasFaces?: boolean | null;
  /** Match files that contain a detected face assigned to any of these cluster ids. */
  faceCluster?: number | number[] | null;
  /**
   * Person + per-face attribute match. Supersedes `faceCluster` when the caller
   * also constrains attributes; `faceCluster` stays for existing share links and
   * URLs that only name people.
   */
  faceMatch?: FaceMatchFilter | null;
  semanticImage?: RuntimeSemanticSimilarityFilter | null;
  semanticAudio?: RuntimeSemanticSimilarityFilter | null;
  transcriptSearch?: StringSearch | null;
};

export type LogicalFilter = Extract<
  SharedFilterElement<FilterCondition>,
  { operation: "and" | "or" }
>;

export type FilterElement = SharedFilterElement<FilterCondition>;

export type QueryOptions = {
  filter: FilterElement;
  metadata: Array<keyof FileRecord>;
  pageSize?: number;
  /** 1-indexed */
  page?: number;
  /**
   * Result ordering. Defaults to newest-first by capture date. The `relevance`
   * field only applies to semantic search, so it is treated as `date` here.
   */
  sort?: SortOption;
  /**
   * When true, results include all files in every folder that contains at
   * least one file matching `filter`. Useful for location/people queries where
   * the caller wants the full folder context alongside matched items.
   */
  expandToFolder?: boolean;
  /**
   * When true (the default), a file that belongs to a moment cluster (burst /
   * near-duplicate group, see momentClusterEngine.ts) is only included when it
   * is that cluster's representative — the rest of the cluster's members are
   * dropped from the result. Set false to see every file individually
   * (e.g. when expanding a stack in the UI, or requesting a specific cluster's
   * members).
   */
  collapseMomentClusters?: boolean;
};

export type MomentClusterMember = {
  path: string;
  fileName: string;
  mimeType: string | null;
  dimensionWidth: number | null;
  dimensionHeight: number | null;
  isRepresentative: boolean;
  sharpnessScore: number | null;
  photoQualityScore: number | null;
};

export type MomentClusterDetail = {
  id: string;
  members: MomentClusterMember[];
};

export type QueryResultItem<
  TRequestedMetadata extends Array<keyof FileRecord> | undefined,
> = Pick<FileRecord, "folder" | "fileName"> & // Always include folder and fileName
  // Include requested metadata fields if specified
  (TRequestedMetadata extends Array<keyof FileRecord>
    ? Pick<FileRecord, TRequestedMetadata[number]>
    : unknown);

export type QueryResult<TRequestedMetadata extends Array<keyof FileRecord> | undefined> =
  {
    items: QueryResultItem<TRequestedMetadata>[];
    total: number;
    page: number;
    pageSize: number;
  };

export type GeoCluster = {
  latitude: number;
  longitude: number;
  count: number;
  samplePath: string | null;
  sampleName: string | null;
  /** Epoch ms of the oldest/newest item in the bucket; null when undated. */
  minDate: number | null;
  maxDate: number | null;
};

export type GeoClusterResult = {
  clusters: GeoCluster[];
  total: number;
};

export type FaceClusterBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FaceClusterFace = {
  path: string;
  fileName: string;
  box: FaceClusterBox;
  mimeType: string | null;
  dimensionWidth: number | null;
  dimensionHeight: number | null;
  regions: string | null;
  /**
   * The `faces.id` row this crop came from — needed to target a specific
   * detection for exclusion (feedback #90); previously unexposed since
   * nothing before #90 needed to address one face independent of its photo.
   */
  faceId: number;
};

export type FaceClusterSummary = {
  id: string;
  count: number;
  representative: FaceClusterFace;
  name: string | null;
  yearRangeLabel?: string | null;
};

export type FaceCluster = FaceClusterSummary & {
  faces: FaceClusterFace[];
  centroids: FaceClusterCentroid[];
  mergeSuggestions: FaceClusterSummary[];
};

export type FaceClusterCentroid = {
  id: string;
  count: number;
  representative: FaceClusterFace;
};

export type FaceClusterResult = {
  clusters: FaceClusterSummary[];
  totalFaces: number;
  totalClusters: number;
  /**
   * Faces detected but not yet assigned to a cluster by the background
   * clustering task — lets the client show clustering progress.
   */
  pendingFaces: number;
};

export type FaceClusterDetailResult = {
  cluster: FaceCluster | null;
};

export type FaceClusterPCAPoint = {
  id: string;
  count: number;
  name: string | null;
  representative: FaceClusterFace;
  x: number;
  y: number;
  z: number;
  focused: boolean;
};

export type FaceClusterPCAResult = {
  points: FaceClusterPCAPoint[];
};

export type DateHistogramBucket = {
  start: number;
  end: number;
  count: number;
};

export type DateHistogramGrouping = "day" | "month" | "year";

export type DateHistogramResult = {
  buckets: DateHistogramBucket[];
  bucketSizeMs: number;
  minDate: number | null;
  maxDate: number | null;
  grouping: DateHistogramGrouping;
};

export type GetFiles = <TQueryOptions extends QueryOptions>(
  query: TQueryOptions,
) => Promise<QueryResult<TQueryOptions["metadata"]>>;

export type UpsertFileData = (fileData: FileRecord) => Promise<void>;

export type ImageVariantTask = {
  type: "imageVariants";
  relativePath: string;
  mimeType: string;
};

export type HLSTask = {
  type: "hls";
  relativePath: string;
  mimeType: string;
  duration?: number;
};

export type BackgroundTask = ImageVariantTask | HLSTask;
