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

export type FileQueryExtraField =
  | "relativePath"
  | "hasFaces"
  | "faceCluster"
  | "faceMatch";

/** The per-face "photo ready" attributes a face filter can require. */
export const FACE_ATTRIBUTE_KEYS = [
  "smiling",
  "eyesOpen",
  "inFocus",
  "wellExposed",
] as const;

export type FaceAttributeKey = (typeof FACE_ATTRIBUTE_KEYS)[number];

/**
 * Face filter carrying both *who* and *how they look*.
 *
 * Distinct from the plain `faceCluster` field because the attributes have to
 * apply to the selected person's own face — "Ana, smiling" is not "a photo of
 * Ana that also contains somebody smiling". Both halves are optional: attributes
 * with no `clusterIds` match any face in the photo.
 *
 * `includeUnknown` (default true) decides whether a face the pipeline has not
 * scored yet counts as a match. Unknown is genuinely unknown, so it is included
 * unless the user opts into the strict reading.
 */
export type FaceMatchFilter = {
  clusterIds?: number[];
  attributes?: FaceAttributeKey[];
  includeUnknown?: boolean;
};

/** UI-level selection of face attribute requirements. */
export type FaceAttributeFilter = {
  attributes: FaceAttributeKey[];
  /**
   * Whether faces the pipeline has not scored yet still match. Defaults to true
   * — "not yet analysed" is not the same as "not smiling", and while the
   * backfill runs most of the library is unscored.
   */
  includeUnknown?: boolean;
};

/** The attribute set behind the combined "photo ready" toggle. */
export const PHOTO_READY_ATTRIBUTES: readonly FaceAttributeKey[] = FACE_ATTRIBUTE_KEYS;

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

/**
 * Semantic-search modalities that contribute results, each rankable independently.
 * Exposed so the UI can toggle sources on/off for debugging which modality matched.
 * - `image`: CLIP image-embedding similarity
 * - `audio`: CLAP audio-embedding similarity
 * - `transcript`: substring match against speech transcripts
 */
export type SearchSource = "image" | "audio" | "transcript";
export const SEARCH_SOURCES: readonly SearchSource[] = ["image", "audio", "transcript"];

export type ShareScope<TFilter = unknown> = {
  filter: TFilter;
  semanticQuery?: string;
  searchSources?: SearchSource[];
  sortBy?: SortOption;
  /** Human-readable label embedded for link-preview generation. */
  description?: string;
};

/**
 * How results are ordered.
 * - `date`: capture date (dateTaken, falling back to created/modified)
 * - `rating`: user star rating (unrated always sorts last)
 * - `quality`: derived "photo ready" quality score — the worst-scoring
 *   detected face's smiling/eyes-open/in-focus/well-exposed attributes
 *   (see server's photoQuality.ts); photos with no scored faces always sort
 *   last, in either direction, since there's no signal to place them by
 * - `relevance`: semantic-search match quality; only meaningful while a search
 *   query is active, and ignored (treated as `date`) for plain library browsing
 */
export type SortField = "date" | "rating" | "quality" | "relevance";
export type SortDirection = "asc" | "desc";
export type SortOption = { field: SortField; direction: SortDirection };

export const SORT_FIELDS: readonly SortField[] = [
  "date",
  "rating",
  "quality",
  "relevance",
];

/** Newest first — the historical default when no sort is specified. */
export const DEFAULT_SORT: SortOption = { field: "date", direction: "desc" };

/** Serialize a sort for a URL/query param, e.g. `date:desc`. */
export const serializeSort = (sort: SortOption): string =>
  `${sort.field}:${sort.direction}`;

/**
 * Parse a `field:direction` sort param. Returns undefined for absent/malformed
 * input so callers can fall back to DEFAULT_SORT.
 */
export const parseSort = (raw: string | null | undefined): SortOption | undefined => {
  if (!raw) return undefined;
  const [field, direction] = raw.split(":");
  if (!(SORT_FIELDS as readonly string[]).includes(field)) return undefined;
  if (direction !== "asc" && direction !== "desc") return undefined;
  return { field: field as SortField, direction };
};

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
  /**
   * When true, results are expanded to include all files in any folder that
   * contains a matched item. Useful with location or people filters to see
   * the full set of related photos from the same shoot.
   */
  expandToFolder: boolean;
  mediaTypeFilter: MediaTypeFilter;
  peopleInImageFilter: string[] | null;
  /** Face-cluster ids (People-tab clusters, e.g. `person-3`) to match faces against. */
  faceClusterFilter: string[] | null;
  /**
   * Per-face "photo ready" requirements, applied to the same face that matched
   * `faceClusterFilter` (or to any face when no person is selected).
   */
  faceAttributeFilter: FaceAttributeFilter | null;
  cameraModelFilter: string[] | null;
  lensFilter: string[] | null;
  ratingFilter: RatingFilter | null;
  locationBounds: GeoBoundsLike | null;
  dateRange: DateRangeSelection | null;
  semanticQuery: string;
  /** Enabled semantic-search sources; `undefined` means all sources are used. */
  searchSources: SearchSource[];
  /** Result ordering; `undefined` means DEFAULT_SORT (newest first). */
  sortBy: SortOption;
}>;

/**
 * Filter-state fields a natural-language query is allowed to set. Deliberately a
 * narrow subset of ClientFilterState: the interpreter may only produce filters
 * the user can see as a chip and remove in one click.
 */
export type InterpretedSearchFilter = Pick<
  ClientFilterState,
  | "path"
  | "includeSubfolders"
  | "mediaTypeFilter"
  | "peopleInImageFilter"
  | "faceClusterFilter"
  | "ratingFilter"
  | "dateRange"
  | "semanticQuery"
>;

export type InterpretedFilterField = keyof InterpretedSearchFilter;

/**
 * One removable piece of an interpretation, rendered as a filter chip.
 * `value` identifies the single entry for array-valued fields (people), so
 * removing one person leaves the others in place.
 */
export type InterpretedFilterChip = {
  field: InterpretedFilterField;
  label: string;
  value?: string;
};

/**
 * Result of translating a natural-language search into structured filters.
 *
 * `interpreted: false` is the normal, non-error outcome whenever the local model
 * is unconfigured/unreachable/slow, answers with something unusable, or finds
 * nothing structured in the query — the caller then runs the query exactly as a
 * plain semantic search.
 */
export type SearchInterpretation =
  | {
      interpreted: true;
      /** The original query text, echoed so a stale response can be discarded. */
      query: string;
      filter: InterpretedSearchFilter;
      chips: InterpretedFilterChip[];
      /** Names/places the model asked for that do not exist in this library. */
      ignored: string[];
    }
  | {
      interpreted: false;
      reason:
        | "unavailable"
        | "malformed"
        | "no-filters"
        | "empty-query"
        | "disabled"
        | "error";
    };

/**
 * Master field metadata: single source of truth for field capabilities.
 * All nullable/array/supportsArray info derives from this object.
 * @internal Exported for testing and deriving other values; not part of public API.
 */
export const FIELD_METADATA = {
  peopleInImageFilter: { nullable: true, supportsArray: true },
  faceClusterFilter: { nullable: true, supportsArray: true },
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
type ApiFieldType<
  K extends keyof typeof FIELD_METADATA,
  TClientValue,
> = (typeof FIELD_METADATA)[K] extends {
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
  [K in keyof typeof FIELD_METADATA]?:
    | ApiFieldType<K, K extends keyof ClientFilterState ? ClientFilterState[K] : never>
    | ((typeof FIELD_METADATA)[K] extends { nullable: true } ? null : never);
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
  ]),
) as Record<
  keyof typeof FIELD_METADATA,
  { supportsArray: boolean; allowsNullState: boolean }
>;

export type BackgroundTaskStatus = {
  id: string;
  name: string;
  queue: "background" | "implied";
  state: "queued" | "running" | "paused" | "cancelled" | "complete";
  itemsProcessed?: number;
  total?: number;
  portionComplete?: number;
  description?: string;
};

export type ComputeProcessRole = "image" | "clap" | "whisper" | "other";

export type GpuProcess = {
  pid: number;
  role: ComputeProcessRole;
  vramMB: number;
};

export type ComputeWorkerMetric = {
  id: string;
  role: ComputeProcessRole;
  pid: number;
  vramMB: number; // 0 when the worker holds no VRAM (e.g. running on CPU)
  rssMB: number;
  suspended: boolean;
  leases: number;
};

export type SystemMetrics = {
  cpu: {
    usage: number; // percentage 0-100
    cores: number;
  };
  memory: {
    used: number; // bytes
    total: number; // bytes
    usage: number; // percentage 0-100
  };
  disk?: {
    readLatencyMs?: number;
    writeLatencyMs?: number;
    utilization?: number; // percentage 0-100
    iopsRead?: number;
    iopsWrite?: number;
  };
  gpu?: {
    usage: number; // percentage 0-100
    memory?: {
      used: number; // MB
      total: number; // MB
    };
    processes?: GpuProcess[];
    // VRAM in use on the card but not attributable to any visible pid — e.g.
    // processes on the host or in sibling containers sharing a passed-through
    // GPU. A small residue (driver/context overhead) is normal.
    unaccountedMB?: number;
  };
  workers?: ComputeWorkerMetric[];
};

// Live arbitration state, so the status UI can show *why* the ML workers are (or
// aren't) holding VRAM right now: a user request in flight fully stops
// background work, and a user GPU request additionally reclaims (kills) the
// background workers' VRAM until the user goes idle.
export type ArbitrationState = {
  userActive: boolean;
  workersSuspended: boolean;
  gpuReclaimed: boolean;
  overloaded: boolean;
  runningTasks: { name: string; queue: string; priority: string }[];
};

export type ServerStatus = {
  backgroundTasks: BackgroundTaskStatus[];
  maintenance: {
    backgroundTasksEnabled: boolean;
  };
  system: SystemMetrics;
  arbitration?: ArbitrationState;
};
