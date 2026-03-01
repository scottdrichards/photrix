import { useEffect } from "react";
import { useFilterContext } from "../components/filter/FilterContext";

export const useSyncUrlWithFilter = (): void => {
  const { filter, setFilter } = useFilterContext();
  const currentPath = filter.path?.replace(/\/$/, "") ?? "";

  // Sync URL when filter changes (only path and includeSubfolders encoded)
  useEffect(() => {
    const params = new URLSearchParams();
    if (filter.includeSubfolders === false) {
      params.set("includeSubfolders", "false");
    }

    const currentPathname = window.location.pathname.slice(1); // Remove leading slash
    const currentInclude = new URLSearchParams(window.location.search).get("includeSubfolders") !== "false";

    if (decodeURIComponent(currentPathname) !== currentPath || currentInclude !== filter.includeSubfolders) {
      const queryString = params.toString() ? `?${params.toString()}` : "";
      const encodedPath = currentPath
        ? currentPath.split("/").map(encodeURIComponent).join("/")
        : "";
      const newUrl = `/${encodedPath}${queryString}`;
      window.history.pushState(null, "", newUrl);
    }
  }, [currentPath, filter.includeSubfolders]);

  // Handle browser navigation
  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const path = decodeURIComponent(window.location.pathname.slice(1));
      setFilter({
        path: path ? `${path}/` : "",
        includeSubfolders: params.get("includeSubfolders") !== "false",
      });
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [setFilter]);
};
