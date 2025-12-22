import { UnionToIntersection } from "../utils.ts";
import { BaseFileRecord, DatabaseFileEntry, MetadataGroups } from "./fileRecord.type.ts";


/**
 * How a file is represented when sent out - same as DatabaseFileEntry
 */
export type FileRecord = DatabaseFileEntry;

/**
 * String [] matching to string means OR - string[] matching to string[] means AND
 */
export type StringSearch =
    | string
    | string[]
    | {
        includes?: string;
        glob?: string;
        regex?: string;
        /** Index-friendly prefix match. For folder paths, include the trailing '/'. */
        startsWith?: string;
        /** Matches direct children of a folder (e.g. "2024" matches "2024/a.jpg" but not "2024/vacation/a.jpg"). */
        directChildOf?: string;
        /** Matches only root-level paths (no '/'). */
        rootOnly?: boolean;
    };

/**
 * Inclusive of min/max
 */
export type Range<T extends Date | number> = { min?: T; max?: T };

/**
 * `null` means the field must be missing/undefined
 */
export type FilterCondition = {
    [K in keyof FileRecord]?:
        null | (
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
    Pick<FileRecord, 'relativePath'> & // Always include relativePath
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

export type GetFiles = <TQueryOptions extends QueryOptions>(query: TQueryOptions) => 
    Promise<QueryResult<TQueryOptions['metadata']>>;

export type UpsertFileData = (fileData: DatabaseFileEntry) => Promise<void>;