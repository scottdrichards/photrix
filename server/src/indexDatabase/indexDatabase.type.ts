import { FileRecord } from "./fileRecord.type.ts";
import type {
  FaceMatchFilter,
  FileQueryExtraField,
  FilterElement as SharedFilterElement,
  RecordFilterCondition,
  SortOption,
  StringSearch,
} from "@photrix/filter-contract";
export type {
  Range,
  SortOption,
  StringSearch,
} from "@photrix/filter-contract";

type RuntimeSemanticSimilarityFilter = {
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
  /** Match files containing a face whose person has this tag (e.g. "Richards Family"). */
  personTag?: string | null;
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
   * A boundary nothing in the result may cross — a share link's filter. Unlike
   * `filter`, it also bounds what `expandToFolder` widens to and which moment
   * cluster members are counted, previewed or chosen to stand for a stack.
   */
  scope?: FilterElement;
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

type QueryResultItem<
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

type GeoCluster = {
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


export type {
  DateHistogramBucket,
  DateHistogramGrouping,
  DateHistogramResult,
  FaceClusterCentroid,
  FaceClusterDetail,
  FaceClusterDetailResult,
  FaceClusterFace,
  FaceClusterPCAPoint,
  FaceClusterPCAResult,
  FaceClusterResult,
  FaceClusterSummary,
  FaceReviewFace,
  FaceReviewResult,
} from "@photrix/api-contract";
