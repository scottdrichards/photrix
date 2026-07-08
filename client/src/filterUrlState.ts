import {
  SEARCH_SOURCES,
  type ClientFilterState,
  type SearchSource,
} from "../../shared/filter-contract/src";

export type ViewMode = "library" | "people";

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

export const readViewModeFromSearch = (search: string): ViewMode =>
  new URLSearchParams(search).get("view") === "people" ? "people" : "library";

export const createFilterStateFromUrl = (location: {
  pathname: string;
  search: string;
}): Pick<
  ClientFilterState,
  "includeSubfolders" | "path" | "semanticQuery" | "searchSources"
> => {
  const params = new URLSearchParams(location.search);
  const pathFromLocation = decodeURIComponent(location.pathname.slice(1));

  return {
    includeSubfolders: params.get("includeSubfolders") !== "false",
    path: pathFromLocation ? `${pathFromLocation}/` : "",
    semanticQuery: normalizeSemanticQuery(params.get("q")),
    searchSources: parseSearchSources(params.get("sources")),
  };
};

export const buildFilterSearchParams = (
  filter: ClientFilterState,
  view: ViewMode,
  currentSearch: string,
): URLSearchParams => {
  const params = new URLSearchParams();
  const currentParams = new URLSearchParams(currentSearch);
  const token = currentParams.get("token");
  const semanticQuery = normalizeSemanticQuery(filter.semanticQuery);
  const searchSources = normalizeSearchSources(filter.searchSources);

  if (token) {
    params.set("token", token);
  }
  if (filter.includeSubfolders === false) {
    params.set("includeSubfolders", "false");
  }
  if (semanticQuery) {
    params.set("q", semanticQuery);
  }
  if (searchSources) {
    params.set("sources", searchSources.join(","));
  }
  if (view !== "library") {
    params.set("view", view);
  }

  return params;
};
