import { useEffect } from "react";
import { useFilter } from "../components/filter/FilterContext";
import {
  buildFilterSearchParams,
  createFilterStateFromUrl,
  readViewModeFromSearch,
  type ViewMode,
} from "../filterUrlState";

export type { ViewMode } from "../filterUrlState";

export const useSyncUrlWithFilter = (
  view: ViewMode,
  setView: (v: ViewMode) => void,
): void => {
  const { filter, setFilter } = useFilter();
  const currentPath = filter.path?.replace(/\/$/, "") ?? "";

  // Sync URL when filter or view changes
  useEffect(() => {
    const params = buildFilterSearchParams(filter, view, window.location.search);
    const queryString = params.toString() ? `?${params.toString()}` : "";
    const encodedPath = currentPath
      ? currentPath.split("/").map(encodeURIComponent).join("/")
      : "";
    const nextUrl = `/${encodedPath}${queryString}`;
    const currentUrl = `${window.location.pathname}${window.location.search}`;

    if (currentUrl !== nextUrl) {
      window.history.pushState(null, "", nextUrl);
    }
  }, [currentPath, filter, view]);

  // Handle browser navigation
  useEffect(() => {
    const handlePopState = () => {
      setFilter(createFilterStateFromUrl(window.location));
      setView(readViewModeFromSearch(window.location.search));
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [setFilter, setView]);
};
