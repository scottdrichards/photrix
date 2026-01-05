import { FileRecord } from "./fileRecord.type.ts";

export type StringSearch =
    | string
    | string[]
    | {
        includes?: string;
        glob?: string;
        regex?: string;
        /** Index-friendly prefix match. Use `folder` for folder matches */
        startsWith?: string;
    }

/**
 * Inclusive of min/max
 */
export type Range<T extends Date | number> = { min?: T; max?: T };

export type FilterCondition = {
    [K in keyof FileRecord]?:
        null | (
            K extends 'folder' ? (StringSearch | {
                /** `true` to grab grandchildren as well */
                recursive?: boolean;
                folder: string;
            }) :
            NonNullable<FileRecord[K]> extends number ? number[] | Range<number> :
            NonNullable<FileRecord[K]> extends Record<string, number> ? 
                { [P in keyof NonNullable<FileRecord[K]>]?: number[] |Range<number> } :
            NonNullable<FileRecord[K]> extends string | string[] ? StringSearch :
            NonNullable<FileRecord[K]> extends Date ? Range<Date> :
            NonNullable<FileRecord[K]> extends boolean ? NonNullable<FileRecord[K]> :
            FileRecord[K]
        );
}

export type LogicalFilter = {
    operation: 'and' | 'or';
    conditions: FilterElement[];
}

export type FilterElement = FilterCondition | LogicalFilter;

export type QueryOptions = {
    filter: FilterElement;
    metadata: Array<keyof FileRecord>;
    pageSize?: number;
    /** 1-indexed */
    page?: number;
};

export type QueryResultItem<TRequestedMetadata extends Array<keyof FileRecord> | undefined> =
    Pick<FileRecord, 'folder' | 'fileName'> & // Always include folder and fileName
    (
        // Include requested metadata fields if specified
        TRequestedMetadata extends Array<keyof FileRecord> ?
            Pick<FileRecord, TRequestedMetadata[number]> :
            unknown
    );

export type QueryResult<TRequestedMetadata extends Array<keyof FileRecord> | undefined> = {
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

export type GetFiles = <TQueryOptions extends QueryOptions>(query: TQueryOptions) => 
    Promise<QueryResult<TQueryOptions['metadata']>>;

export type UpsertFileData = (fileData: FileRecord) => Promise<void>;