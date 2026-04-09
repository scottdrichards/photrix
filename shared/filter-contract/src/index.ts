/**
 * Text search operators for string fields.
 */
export type StringSearch =
  | string
  | string[]
  | {
      includes?: string;
      glob?: string;
      regex?: string;
      /** Index-friendly prefix match. */
      startsWith?: string;
      /** Index-friendly prefix negation match. */
      notStartsWith?: string;
    };

/** Inclusive min/max range. */
export type Range<T extends Date | number> = {
  min?: T;
  max?: T;
};

/**
 * Folder-specific filter with optional recursive matching.
 */
export type FolderFilter = {
  folder: string;
  /** `true` to include descendants. Defaults to `false`. */
  recursive?: boolean;
};

/**
 * Generic per-field filter constraint used by API filter JSON.
 */
export type FilterConstraint =
  | null
  | string
  | number
  | boolean
  | Date
  | string[]
  | number[]
  | Range<Date | number>
  | StringSearch
  | FolderFilter
  | Record<string, number[] | Range<number>>;

export type FilterCondition<TField extends string = string> = {
  [K in TField]?: FilterConstraint;
};

export type LogicalFilter<TCondition> = {
  operation: "and" | "or";
  conditions: FilterElement<TCondition>[];
};

export type FilterElement<TCondition> = TCondition | LogicalFilter<TCondition>;

type FilterConstraintForValue<TField extends string, TValue> =
  | null
  | (TField extends "relativePath"
      ? StringSearch
      : TField extends "folder"
        ? StringSearch | FolderFilter
        : NonNullable<TValue> extends number
          ? number | number[] | Range<number>
          : NonNullable<TValue> extends Record<string, number>
            ? { [P in keyof NonNullable<TValue>]?: number[] | Range<number> }
            : NonNullable<TValue> extends string | string[]
              ? StringSearch
              : NonNullable<TValue> extends Date
                ? Range<Date>
                : NonNullable<TValue> extends boolean
                  ? NonNullable<TValue>
                  : TValue);

export type RecordFilterCondition<
  TRecord extends Record<string, unknown>,
  TExtraFields extends string = "relativePath",
> = {
  [K in (keyof TRecord & string) | TExtraFields]?: FilterConstraintForValue<
    K,
    K extends keyof TRecord ? TRecord[K] : never
  >;
};

export type RecordFilterElement<
  TRecord extends Record<string, unknown>,
  TExtraFields extends string = "relativePath",
> = FilterElement<RecordFilterCondition<TRecord, TExtraFields>>;

export type MediaTypeFilter = "all" | "photo" | "video" | "other";

export type RatingFilter = {
  rating: number;
  atLeast: boolean;
};

export type GeoBoundsLike = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type DateRangeFilter = {
  start?: number;
  end?: number;
};

export type DateRangeSelection = {
  start: number;
  end: number;
};

/**
 * UI-level filter state semantics:
 * - `undefined`: no filter for the field
 * - `null` for nullable fields: explicitly match records with no value
 */
export type ClientFilterState = Partial<{
  includeSubfolders: boolean;
  path: string;
  mediaTypeFilter: MediaTypeFilter;
  peopleInImageFilter: string[] | null;
  cameraModelFilter: string[] | null;
  lensFilter: string[] | null;
  ratingFilter: RatingFilter | null;
  locationBounds: GeoBoundsLike | null;
  dateRange: DateRangeSelection | null;
}>;

/**
 * Master field metadata: single source of truth for field capabilities.
 * All nullable/array/supportsArray info derives from this object.
 * @internal Exported for testing and deriving other values; not part of public API.
 */
export const FIELD_METADATA = {
  peopleInImageFilter: { nullable: true, supportsArray: true },
  cameraModelFilter: { nullable: true, supportsArray: true },
  lensFilter: { nullable: true, supportsArray: true },
  ratingFilter: { nullable: true, supportsArray: false },
  locationBounds: { nullable: true, supportsArray: false },
  dateRange: { nullable: true, supportsArray: false },
  mediaTypeFilter: { nullable: false, supportsArray: false },
} as const;

/**
 * Maps a ClientFilterState field value to its API-accepted type.
 * Array fields accept collapsed `string | string[]`; dateRange uses DateRangeFilter.
 */
type ApiFieldType<K extends keyof typeof FIELD_METADATA, TClientValue> = (typeof FIELD_METADATA)[K] extends {
  supportsArray: true;
}
  ? string[] | string
  : K extends "dateRange"
    ? DateRangeFilter
    : NonNullable<TClientValue>;

/**
 * Derived: API-level filter inputs.
 * Nullable/array semantics come from FIELD_METADATA — no manual duplication.
 */
export type ApiFilterOptions = {
  [K in keyof typeof FIELD_METADATA]?: ApiFieldType<
    K,
    K extends keyof ClientFilterState ? ClientFilterState[K] : never
  > | ((typeof FIELD_METADATA)[K] extends { nullable: true } ? null : never);
};

/**
 * Derived: Field-level behavior hints for UI builders and docs.
 * Values match FIELD_METADATA with allowsNullState mirroring the `nullable` property.
 */
export const filterFieldCapabilities = Object.fromEntries(
  (Object.keys(FIELD_METADATA) as (keyof typeof FIELD_METADATA)[]).map((field) => [
    field,
    {
      supportsArray: FIELD_METADATA[field].supportsArray,
      allowsNullState: FIELD_METADATA[field].nullable,
    },
  ])
) as Record<
  keyof typeof FIELD_METADATA,
  { supportsArray: boolean; allowsNullState: boolean }
>;
