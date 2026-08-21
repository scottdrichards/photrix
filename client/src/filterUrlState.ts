import {
  DEFAULT_SORT,
  FACE_ATTRIBUTE_KEYS,
  parseSort,
  SEARCH_SOURCES,
  serializeSort,
  type ClientFilterState,
  type DateRangeSelection,
  type FaceAttributeFilter,
  type FaceAttributeKey,
  type FaceClusterMatchMode,
  type GeoBoundsLike,
  type MediaTypeFilter,
  type RatingFilter,
  type SearchSource,
  type SortOption,
} from "../../shared/filter-contract/src";

/**
 * Single serialize/deserialize layer between application state and the URL.
 *
 * Everything the user can see is addressable, so any view can be refreshed,
 * shared or reached with the back button:
 *
 *   /<folder path>?<params>
 *
 *   token               share-link token (preserved verbatim, never authored here)
 *   view=people         non-default view mode
 *   cluster=person-12   open person in the People tab (only with view=people)
 *   group=person-34     selected match group inside that person
 *   includeSubfolders=false
 *   q=sunset            semantic query
 *   sources=image,transcript   enabled search sources (omitted when all are on)
 *   sort=rating:desc    non-default ordering
 *   media=photo         media type (omitted for "all")
 *   expand=1            expandToFolder
 *   people=Ann&people=Bo        repeated param, one value per person
 *   faces=person-3              repeated param, face-cluster ids
 *   faceMode=any                multiple selected face clusters use OR instead of AND
 *   camera=Pixel 8&camera=X-T5  repeated param
 *   lens=XF 35mm                repeated param
 *   rating=min3 | exact3        star rating
 *   bbox=w,s,e,n        map bounds (6 decimal places ≈ 0.1 m)
 *   dates=<start>..<end>        epoch-millisecond capture-date range
 *
 * Defaults are omitted so an unfiltered library stays at a clean `/`.
 *
 * Nullable filters distinguish three states: the param is absent (no filter),
 * carries the {@link NONE} sentinel (match records that have *no* value for the
 * field), or carries values. Round-tripping is exact except that an empty array
 * deserializes as `undefined` — the two mean the same thing to every consumer.
 */

export type ViewMode = "library" | "people";

/** Which person / match group the People tab has open. */
export type PeopleSelection = {
  personId: string | null;
  groupId: string | null;
};

export const NO_PEOPLE_SELECTION: PeopleSelection = { personId: null, groupId: null };

/** Complete application state that lives in the URL. */
export type AppUrlState = {
  view: ViewMode;
  filter: ClientFilterState;
  people: PeopleSelection;
};

/**
 * Marks "explicitly match records with no value for this field" (as opposed to
 * "no filter"). Chosen from the characters `URLSearchParams` leaves unescaped so
 * URLs stay readable.
 */
const NONE = "_none";

const MEDIA_TYPES: readonly MediaTypeFilter[] = ["all", "photo", "video", "other"];

const normalizeSemanticQuery = (query: string | null | undefined): string | undefined => {
  const normalizedQuery = query?.trim() ?? "";
  return normalizedQuery.length > 0 ? normalizedQuery : undefined;
};

const normalizeSearchSources = (
  searchSources: SearchSource[] | null | undefined,
): SearchSource[] | undefined => {
  if (!searchSources || searchSources.length === 0) {
    return undefined;
  }

  const orderedSources = SEARCH_SOURCES.filter((source) =>
    searchSources.includes(source),
  );
  return orderedSources.length === SEARCH_SOURCES.length ? undefined : orderedSources;
};

export const parseSearchSources = (
  searchSourcesParam: string | null | undefined,
): SearchSource[] | undefined =>
  normalizeSearchSources(
    searchSourcesParam
      ?.split(",")
      .map((source) => source.trim())
      .filter((source): source is SearchSource =>
        (SEARCH_SOURCES as readonly string[]).includes(source),
      ),
  );

const isDefaultSort = (sort: SortOption | undefined): boolean =>
  !sort || (sort.field === DEFAULT_SORT.field && sort.direction === DEFAULT_SORT.direction);

// ---------------------------------------------------------------------------
// Per-field codecs
// ---------------------------------------------------------------------------

const appendListParam = (
  params: URLSearchParams,
  key: string,
  value: string[] | null | undefined,
): void => {
  if (value === undefined) return;
  if (value === null) {
    params.append(key, NONE);
    return;
  }
  for (const entry of value) {
    if (entry !== "") params.append(key, entry);
  }
};

const parseListParam = (
  params: URLSearchParams,
  key: string,
): string[] | null | undefined => {
  const values = params.getAll(key).filter((value) => value !== "");
  if (values.length === 0) return undefined;
  const concrete = values.filter((value) => value !== NONE);
  return concrete.length > 0 ? concrete : null;
};

/**
 * Face attributes ride as a repeated `attr` param, with the strict reading of
 * unknown faces flagged by a trailing `!` on the first entry rather than a
 * second param — it only ever applies alongside a selection.
 */
const STRICT_UNKNOWN_MARKER = "!";

const serializeFaceAttributes = (
  value: FaceAttributeFilter | null | undefined,
): string[] | undefined => {
  if (!value || value.attributes.length === 0) return undefined;
  const keys = [...value.attributes];
  // `includeUnknown` defaults to true, so only the strict reading needs marking.
  return value.includeUnknown === false
    ? [`${keys[0]}${STRICT_UNKNOWN_MARKER}`, ...keys.slice(1)]
    : keys;
};

const parseFaceAttributes = (
  params: URLSearchParams,
): FaceAttributeFilter | null | undefined => {
  const raw = params.getAll("attr").filter((value) => value !== "");
  if (raw.length === 0) return undefined;

  let strict = false;
  const attributes: FaceAttributeKey[] = [];
  for (const entry of raw) {
    let key = entry;
    if (key.endsWith(STRICT_UNKNOWN_MARKER)) {
      strict = true;
      key = key.slice(0, -1);
    }
    // Ignore anything not in the contract, so a stale or hand-edited link
    // degrades to a weaker filter rather than an empty result set.
    if ((FACE_ATTRIBUTE_KEYS as readonly string[]).includes(key)) {
      attributes.push(key as FaceAttributeKey);
    }
  }

  if (attributes.length === 0) return null;
  return strict ? { attributes, includeUnknown: false } : { attributes };
};

const parseFaceClusterMatchMode = (
  raw: string | null,
): FaceClusterMatchMode | undefined => (raw === "any" ? "any" : undefined);

const serializeRating = (
  rating: RatingFilter | null | undefined,
): string | undefined => {
  if (rating === undefined) return undefined;
  if (rating === null) return NONE;
  const stars = Math.trunc(rating.rating);
  return rating.atLeast ? `min${stars}` : `exact${stars}`;
};

const parseRating = (raw: string | null): RatingFilter | null | undefined => {
  if (raw === null) return undefined;
  if (raw === NONE) return null;
  // Also accept a bare `rating=3` and a hand-typed `rating=3+` (which arrives as
  // "3 ", since `+` decodes to a space); both mean "at least".
  const match = /^(min|exact)?(\d+)\s*\+?\s*$/.exec(raw);
  if (!match) return undefined;
  return { rating: Number(match[2]), atLeast: match[1] !== "exact" };
};

/** ~0.1 m of precision; enough for a map viewport and far shorter in a URL. */
const roundCoordinate = (value: number): number => Number(value.toFixed(6));

const serializeBounds = (
  bounds: GeoBoundsLike | null | undefined,
): string | undefined => {
  if (bounds === undefined) return undefined;
  if (bounds === null) return NONE;
  return [bounds.west, bounds.south, bounds.east, bounds.north]
    .map((coordinate) => String(roundCoordinate(coordinate)))
    .join(",");
};

const parseBounds = (raw: string | null): GeoBoundsLike | null | undefined => {
  if (raw === null) return undefined;
  if (raw === NONE) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    return undefined;
  }
  const [west, south, east, north] = parts;
  return { west, south, east, north };
};

const serializeDateRange = (
  dateRange: DateRangeSelection | null | undefined,
): string | undefined => {
  if (dateRange === undefined) return undefined;
  if (dateRange === null) return NONE;
  return `${Math.round(dateRange.start)}..${Math.round(dateRange.end)}`;
};

const parseDateRange = (raw: string | null): DateRangeSelection | null | undefined => {
  if (raw === null) return undefined;
  if (raw === NONE) return null;
  const [rawStart, rawEnd, ...rest] = raw.split("..");
  if (rest.length > 0) return undefined;
  const start = Number(rawStart);
  const end = Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return { start, end };
};

const parseMediaType = (raw: string | null): MediaTypeFilter =>
  MEDIA_TYPES.includes(raw as MediaTypeFilter) ? (raw as MediaTypeFilter) : "all";

// ---------------------------------------------------------------------------
// Deserialize
// ---------------------------------------------------------------------------

export const readViewModeFromSearch = (search: string): ViewMode =>
  new URLSearchParams(search).get("view") === "people" ? "people" : "library";

/**
 * A person is only meaningful inside the People tab, and a match group is only
 * meaningful inside a person — so both are gated on their parent.
 */
export const readPeopleSelectionFromSearch = (search: string): PeopleSelection => {
  const params = new URLSearchParams(search);
  if (params.get("view") !== "people") return NO_PEOPLE_SELECTION;
  const personId = params.get("cluster") || null;
  if (!personId) return NO_PEOPLE_SELECTION;
  return { personId, groupId: params.get("group") || null };
};

/**
 * Every field is returned (as `undefined` when absent) so that feeding the
 * result through a partial `setFilter` clears filters that dropped out of the
 * URL — which is what a back-button navigation must do.
 */
export const createFilterStateFromUrl = (location: {
  pathname: string;
  search: string;
}): ClientFilterState => {
  const params = new URLSearchParams(location.search);
  const pathFromLocation = decodeURIComponent(location.pathname.slice(1));

  return {
    includeSubfolders: params.get("includeSubfolders") !== "false",
    path: pathFromLocation ? `${pathFromLocation}/` : "",
    semanticQuery: normalizeSemanticQuery(params.get("q")),
    searchSources: parseSearchSources(params.get("sources")),
    sortBy: parseSort(params.get("sort")),
    mediaTypeFilter: parseMediaType(params.get("media")),
    expandToFolder: params.get("expand") === "1",
    peopleInImageFilter: parseListParam(params, "people"),
    faceClusterFilter: parseListParam(params, "faces"),
    faceClusterMatchMode: parseFaceClusterMatchMode(params.get("faceMode")),
    faceAttributeFilter: parseFaceAttributes(params),
    cameraModelFilter: parseListParam(params, "camera"),
    lensFilter: parseListParam(params, "lens"),
    ratingFilter: parseRating(params.get("rating")),
    locationBounds: parseBounds(params.get("bbox")),
    dateRange: parseDateRange(params.get("dates")),
  };
};

export const parseAppUrlState = (location: {
  pathname: string;
  search: string;
}): AppUrlState => ({
  view: readViewModeFromSearch(location.search),
  filter: createFilterStateFromUrl(location),
  people: readPeopleSelectionFromSearch(location.search),
});

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/**
 * @param currentSearch the live query string, read only to carry a share
 * `token` forward — it is never authored by the app itself.
 */
export const buildAppSearchParams = (
  state: AppUrlState,
  currentSearch = "",
): URLSearchParams => {
  const { filter, view, people } = state;
  const params = new URLSearchParams();
  const token = new URLSearchParams(currentSearch).get("token");

  if (token) params.set("token", token);
  if (view !== "library") params.set("view", view);
  if (view === "people" && people.personId) {
    params.set("cluster", people.personId);
    if (people.groupId) params.set("group", people.groupId);
  }

  // Only persist non-defaults so ordinary library URLs stay clean.
  if (!isDefaultSort(filter.sortBy)) {
    params.set("sort", serializeSort(filter.sortBy as SortOption));
  }
  if (filter.includeSubfolders === false) {
    params.set("includeSubfolders", "false");
  }
  const semanticQuery = normalizeSemanticQuery(filter.semanticQuery);
  if (semanticQuery) params.set("q", semanticQuery);
  const searchSources = normalizeSearchSources(filter.searchSources);
  if (searchSources) params.set("sources", searchSources.join(","));
  if (filter.mediaTypeFilter && filter.mediaTypeFilter !== "all") {
    params.set("media", filter.mediaTypeFilter);
  }
  if (filter.expandToFolder) params.set("expand", "1");

  appendListParam(params, "people", filter.peopleInImageFilter);
  appendListParam(params, "faces", filter.faceClusterFilter);
  if (filter.faceClusterMatchMode === "any" && (filter.faceClusterFilter?.length ?? 0) > 0) {
    params.set("faceMode", "any");
  }
  for (const attr of serializeFaceAttributes(filter.faceAttributeFilter) ?? []) {
    params.append("attr", attr);
  }
  appendListParam(params, "camera", filter.cameraModelFilter);
  appendListParam(params, "lens", filter.lensFilter);

  const rating = serializeRating(filter.ratingFilter);
  if (rating !== undefined) params.set("rating", rating);
  const bbox = serializeBounds(filter.locationBounds);
  if (bbox !== undefined) params.set("bbox", bbox);
  const dates = serializeDateRange(filter.dateRange);
  if (dates !== undefined) params.set("dates", dates);

  return params;
};

/** The folder path lives in the pathname, not the query string. */
const buildPathname = (path: string | undefined): string => {
  const trimmed = path?.replace(/\/$/, "") ?? "";
  if (!trimmed) return "/";
  return `/${trimmed.split("/").map(encodeURIComponent).join("/")}`;
};

export const buildAppUrl = (state: AppUrlState, currentSearch = ""): string => {
  const queryString = buildAppSearchParams(state, currentSearch).toString();
  return `${buildPathname(state.filter.path)}${queryString ? `?${queryString}` : ""}`;
};

/**
 * Identity of the *navigational* part of a URL — the parts a back button should
 * step through. Two URLs that differ only in filter params share a nav key, so
 * tweaking a filter replaces the history entry instead of stacking a new one.
 */
export const navigationKey = (url: string): string => {
  const [pathname = "", search = ""] = url.split("?");
  const params = new URLSearchParams(search);
  return [
    pathname,
    params.get("view") ?? "",
    params.get("cluster") ?? "",
    params.get("group") ?? "",
  ].join("|");
};
