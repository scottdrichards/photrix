import { FileRecord } from "./fileRecord.type.ts";
import type {
  FileQueryExtraField,
  FilterElement as SharedFilterElement,
  RecordFilterCondition,
} from "../../../shared/filter-contract/src/index.ts";
export type { Range, StringSearch } from "../../../shared/filter-contract/src/index.ts";

export type FilterField = keyof FileRecord | FileQueryExtraField;

type BaseFilterCondition = RecordFilterCondition<FileRecord, "relativePath">;

export type FilterCondition = BaseFilterCondition & {
  hasFaces?: boolean | null;
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
};

export type FaceClusterSummary = {
  id: string;
  count: number;
  representative: FaceClusterFace;
};

export type FaceCluster = FaceClusterSummary & {
  faces: FaceClusterFace[];
};

export type FaceClusterResult = {
  clusters: FaceClusterSummary[];
  totalFaces: number;
  totalClusters: number;
};

export type FaceClusterDetailResult = {
  cluster: FaceCluster | null;
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
