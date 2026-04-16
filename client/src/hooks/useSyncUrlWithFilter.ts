import { useEffect } from "react";
import { useFilterContext } from "../components/filter/FilterContext";

export type ViewMode = "library";

export const useSyncUrlWithFilter = (
  view: ViewMode,
  setView: (v: ViewMode) => void,
): void => {
  const { filter, setFilter } = useFilterContext();
  const currentPath = filter.path?.replace(/\/$/, "") ?? "";

  // Sync URL when filter or view changes
  useEffect(() => {
    const params = new URLSearchParams();
    if (filter.includeSubfolders === false) {
      params.set("includeSubfolders", "false");
    }

    const currentSearch = new URLSearchParams(window.location.search);
    const currentPathname = window.location.pathname.slice(1);
    const currentInclude = currentSearch.get("includeSubfolders") !== "false";

    if (
      decodeURIComponent(currentPathname) !== currentPath ||
      currentInclude !== filter.includeSubfolders
    ) {
      const queryString = params.toString() ? `?${params.toString()}` : "";
      const encodedPath = currentPath
        ? currentPath.split("/").map(encodeURIComponent).join("/")
        : "";
      window.history.pushState(null, "", `/${encodedPath}${queryString}`);
    }
  }, [currentPath, filter.includeSubfolders, view]);

  // Handle browser navigation
  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const path = decodeURIComponent(window.location.pathname.slice(1));
      setFilter({
        path: path ? `${path}/` : "",
        includeSubfolders: params.get("includeSubfolders") !== "false",
      });
      setView("library");
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [setFilter, setView]);
};
