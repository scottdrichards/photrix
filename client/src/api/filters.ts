import { SEARCH_SOURCES } from "../../../shared/filter-contract/src";
import type {
  ApiFilterOptions,
  DateRangeFilter,
  GeoBounds,
  MediaTypeFilter,
  RatingFilter,
  SearchSource,
  ShareScope,
  SortOption,
} from "./types";

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const normalizeBounds = (bounds: GeoBounds): GeoBounds => ({
  west: clampNumber(bounds.west, -180, 180),
  east: clampNumber(bounds.east, -180, 180),
  north: clampNumber(bounds.north, -90, 90),
  south: clampNumber(bounds.south, -90, 90),
});

const locationBoundsToFilter = (bounds: GeoBounds) => {
  const normalized = normalizeBounds(bounds);
  const north = Math.max(normalized.north, normalized.south);
  const south = Math.min(normalized.north, normalized.south);
  const east = normalized.east;
  const west = normalized.west;

  const latitudeRange = { locationLatitude: { min: south, max: north } };
  if (west <= east) {
    return {
      ...latitudeRange,
      locationLongitude: { min: west, max: east },
    };
  }

  // View crosses the international date line. Split into two longitude ranges.
  return {
    operation: "and",
    conditions: [
      latitudeRange,
      {
        operation: "or",
        conditions: [
          { locationLongitude: { min: west, max: 180 } },
          { locationLongitude: { min: -180, max: east } },
        ],
      },
    ],
  };
};

const dateRangeToFilter = (dateRange?: DateRangeFilter | null) => {
  if (!dateRange) {
    return null;
  }

  const { start, end } = dateRange;
  const hasStart = typeof start === "number" && Number.isFinite(start);
  const hasEnd = typeof end === "number" && Number.isFinite(end);

  if (!hasStart && !hasEnd) {
    return null;
  }

  return {
    dateTaken: {
      ...(hasStart ? { min: start } : {}),
      ...(hasEnd ? { max: end } : {}),
    },
  };
};

export type BuildFiltersInput = {
  ratingFilter?: RatingFilter | null;
  mediaTypeFilter?: MediaTypeFilter;
  locationBounds?: GeoBounds | null;
  dateRange?: DateRangeFilter | null;
  peopleInImageFilter?: ApiFilterOptions["peopleInImageFilter"];
  faceClusterFilter?: ApiFilterOptions["faceClusterFilter"];
  cameraModelFilter?: ApiFilterOptions["cameraModelFilter"];
  lensFilter?: ApiFilterOptions["lensFilter"];
};

const normalizeDistinctNonEmpty = (values: string[]) =>
  Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  );

const toStringIncludesFilter = (value: string) => {
  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? { includes: normalizedValue } : null;
};

// People-tab cluster ids arrive as `person-<n>`; the server filters on the raw
// numeric clusterId, so parse the digits out and drop anything malformed.
export const toClusterIdFilter = (
  value: string[] | string | null | undefined,
): number[] | null => {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const ids = Array.from(
    new Set(
      values
        .map((id) => /^person-(\d+)$/.exec(id.trim())?.[1])
        .filter((digits): digits is string => digits !== undefined)
        .map((digits) => Number.parseInt(digits, 10)),
    ),
  );
  return ids.length > 0 ? ids : null;
};

const toStringArrayFilter = (value: string[] | string | null | undefined) => {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalizedValues = normalizeDistinctNonEmpty(value);
  return normalizedValues.length > 0 ? normalizedValues : null;
};

const addStringFilter = (
  filters: Record<string, unknown>[],
  field: "cameraModel" | "lens",
  value: string[] | string | null | undefined,
) => {
  const arrayFilter = toStringArrayFilter(value);
  if (arrayFilter) {
    filters.push({ [field]: arrayFilter });
    return;
  }

  if (typeof value !== "string") {
    return;
  }

  const includesFilter = toStringIncludesFilter(value);
  if (includesFilter) {
    filters.push({ [field]: includesFilter });
  }
};

export const buildFilters = ({
  ratingFilter,
  mediaTypeFilter,
  locationBounds,
  dateRange,
  peopleInImageFilter,
  faceClusterFilter,
  cameraModelFilter,
  lensFilter,
}: BuildFiltersInput) => {
  const filters: Record<string, unknown>[] = [];

  if (ratingFilter) {
    const ratingFilterObj = ratingFilter.atLeast
      ? { rating: { min: ratingFilter.rating } }
      : { rating: ratingFilter.rating };
    filters.push(ratingFilterObj);
  }

  if (mediaTypeFilter === "photo") {
    filters.push({ mimeType: { startsWith: "image/" } });
  } else if (mediaTypeFilter === "video") {
    filters.push({ mimeType: { startsWith: "video/" } });
  } else if (mediaTypeFilter === "other") {
    // Files that are neither images nor videos (null mimeType or other types like application/pdf)
    filters.push({
      operation: "and",
      conditions: [
        {
          operation: "or",
          conditions: [{ mimeType: null }, { mimeType: { notStartsWith: "image/" } }],
        },
        {
          operation: "or",
          conditions: [{ mimeType: null }, { mimeType: { notStartsWith: "video/" } }],
        },
      ],
    });
  }

  const clusterIds = toClusterIdFilter(faceClusterFilter);
  if (clusterIds) {
    filters.push({ faceCluster: clusterIds });
  }

  if (locationBounds) {
    filters.push(locationBoundsToFilter(locationBounds));
  }

  const dateFilter = dateRangeToFilter(dateRange);
  if (dateFilter) {
    filters.push(dateFilter);
  }

  const peopleFilter = toStringArrayFilter(peopleInImageFilter);
  if (peopleFilter) {
    filters.push({ personInImage: peopleFilter });
  } else if (typeof peopleInImageFilter === "string") {
    const includesFilter = toStringIncludesFilter(peopleInImageFilter);
    if (includesFilter) {
      filters.push({ personInImage: includesFilter });
    }
  }

  addStringFilter(filters, "cameraModel", cameraModelFilter);
  addStringFilter(filters, "lens", lensFilter);

  return filters;
};

export const filtersToParam = (filters: Record<string, unknown>[]): string | null => {
  if (filters.length === 0) return null;
  const filterObj =
    filters.length === 1 ? filters[0] : { operation: "and", conditions: filters };
  return JSON.stringify(filterObj);
};

// Builds the full server-side query filter for a share token, including the
// folder/path constraint. This is the format stored server-side and enforced
// on every request made with the resulting share token.
export const buildFullShareFilter = (
  filter: ApiFilterOptions & { path?: string; includeSubfolders?: boolean },
): unknown => {
  const conditions: unknown[] = [];

  const path = (filter.path ?? "").replace(/\/$/, "");
  const includeSubfolders = filter.includeSubfolders ?? true;

  if (path || !includeSubfolders) {
    conditions.push({
      folder: { folder: path || "/", recursive: includeSubfolders },
    });
  }

  conditions.push(
    ...buildFilters({
      ratingFilter: filter.ratingFilter,
      mediaTypeFilter: filter.mediaTypeFilter,
      locationBounds: filter.locationBounds,
      dateRange: filter.dateRange,
      peopleInImageFilter: filter.peopleInImageFilter,
      faceClusterFilter: filter.faceClusterFilter,
      cameraModelFilter: filter.cameraModelFilter,
      lensFilter: filter.lensFilter,
    }),
  );

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { operation: "and", conditions };
};

export const buildShareScope = (
  filter: ApiFilterOptions & {
    path?: string;
    includeSubfolders?: boolean;
    semanticQuery?: string;
    searchSources?: SearchSource[];
    sortBy?: SortOption;
  },
): ShareScope<unknown> => {
  const semanticQuery = filter.semanticQuery?.trim();
  const normalizedSearchSources = filter.searchSources
    ? SEARCH_SOURCES.filter((source) => filter.searchSources?.includes(source))
    : undefined;

  return {
    filter: buildFullShareFilter(filter),
    ...(semanticQuery ? { semanticQuery } : {}),
    ...(normalizedSearchSources && normalizedSearchSources.length < SEARCH_SOURCES.length
      ? { searchSources: normalizedSearchSources }
      : {}),
    ...(filter.sortBy ? { sortBy: filter.sortBy } : {}),
  };
};
