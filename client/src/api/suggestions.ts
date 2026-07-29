import { buildFilters, filtersToParam } from "./filters";
import { fetchJsonOrThrow } from "./http";
import type {
  FetchSuggestionsOptions,
  SuggestionWithCount,
} from "./types";

const buildSuggestionParams = ({
  field,
  q,
  includeCounts,
  limit,
  includeSubfolders,
  path,
  ratingFilter,
  mediaTypeFilter,
  locationBounds,
  dateRange,
  peopleInImageFilter,
  faceClusterFilter,
  faceAttributeFilter,
  cameraModelFilter,
  lensFilter,
}: FetchSuggestionsOptions & { includeCounts: boolean; limit: number; includeSubfolders: boolean; path: string }) => {
  const params = new URLSearchParams();
  params.set("field", field);
  params.set("q", q.trim());
  params.set("limit", String(limit));
  if (includeCounts) params.set("includeCounts", "true");
  if (includeSubfolders) params.set("includeSubfolders", "true");
  if (path) params.set("path", path);

  const filterParam = filtersToParam(buildFilters({
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    faceAttributeFilter,
    cameraModelFilter,
    lensFilter,
  }));
  if (filterParam) params.set("filter", filterParam);

  return params;
};

export const fetchSuggestions = async ({
  field,
  q,
  allowBlankQuery = false,
  includeCounts = false,
  limit = 8,
  includeSubfolders = false,
  path = "",
  ratingFilter,
  mediaTypeFilter = "all",
  locationBounds,
  dateRange,
  peopleInImageFilter,
  faceClusterFilter,
  faceAttributeFilter,
  cameraModelFilter,
  lensFilter,
  signal,
}: FetchSuggestionsOptions): Promise<string[]> => {
  const normalizedQuery = q.trim();
  if (!allowBlankQuery && normalizedQuery.length === 0) return [];

  const params = buildSuggestionParams({
    field,
    q: normalizedQuery,
    includeCounts,
    limit,
    includeSubfolders,
    path,
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    faceAttributeFilter,
    cameraModelFilter,
    lensFilter,
    signal,
  });

  const payload = await fetchJsonOrThrow<{ suggestions: string[] }>(
    `/api/suggestions?${params.toString()}`,
    "fetch suggestions",
    { signal },
  );
  return payload.suggestions;
};

export const fetchSuggestionsWithCounts = async ({
  field,
  q,
  allowBlankQuery = false,
  includeCounts = true,
  limit = 8,
  includeSubfolders = false,
  path = "",
  ratingFilter,
  mediaTypeFilter = "all",
  locationBounds,
  dateRange,
  peopleInImageFilter,
  faceClusterFilter,
  faceAttributeFilter,
  cameraModelFilter,
  lensFilter,
  signal,
}: FetchSuggestionsOptions): Promise<SuggestionWithCount[]> => {
  const normalizedQuery = q.trim();
  if (!allowBlankQuery && normalizedQuery.length === 0) return [];

  const params = buildSuggestionParams({
    field,
    q: normalizedQuery,
    includeCounts,
    limit,
    includeSubfolders,
    path,
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    faceAttributeFilter,
    cameraModelFilter,
    lensFilter,
    signal,
  });

  const payload = await fetchJsonOrThrow<{ suggestions: SuggestionWithCount[] }>(
    `/api/suggestions?${params.toString()}`,
    "fetch suggestions",
    { signal },
  );
  return payload.suggestions;
};
