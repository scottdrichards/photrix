import { DatabaseEntry } from "./fileRecord.type.ts";


/**
 * How a file is represented when sent out - same as DatabaseFileEntry
 */
export type FileRecord = DatabaseEntry;

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
            K extends 'relativePath' ? (StringSearch | {
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

export type UpsertFileData = (fileData: DatabaseEntry) => Promise<void>;