import { FileRecord } from "./fileRecord.type.ts";
import type {
  RecordFilterCondition,
  RecordFilterElement,
} from "../../../shared/filter-contract/src/index.ts";
export type { Range, StringSearch } from "../../../shared/filter-contract/src/index.ts";

export type FilterField = keyof FileRecord | "relativePath";

export type FilterCondition = RecordFilterCondition<FileRecord, "relativePath">;

export type LogicalFilter = Extract<
  RecordFilterElement<FileRecord, "relativePath">,
  { operation: "and" | "or" }
>;

export type FilterElement = RecordFilterElement<FileRecord, "relativePath">;

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
