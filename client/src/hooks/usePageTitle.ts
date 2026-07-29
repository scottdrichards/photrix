import { useEffect, useRef } from "react";
import { getAuthHeaders } from "../auth";
import { buildFullShareFilter } from "../api/filters";
import type { FilterState } from "../components/filter/FilterContext";

const DEBOUNCE_MS = 600;

const isEmptyFilter = (filter: FilterState): boolean => {
  const {
    semanticQuery,
    path,
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    faceClusterFilter,
    cameraModelFilter,
    lensFilter,
  } = filter;
  return (
    !semanticQuery &&
    (!path || path === "/") &&
    !ratingFilter &&
    (!mediaTypeFilter || mediaTypeFilter === "all") &&
    !locationBounds &&
    !dateRange &&
    !peopleInImageFilter &&
    !faceClusterFilter &&
    !cameraModelFilter &&
    !lensFilter
  );
};

export const usePageTitle = (filter: FilterState) => {
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();

    if (isEmptyFilter(filter)) {
      document.title = "Photrix";
      return;
    }

    timerRef.current = setTimeout(() => {
      const ac = new AbortController();
      abortRef.current = ac;

      const body = {
        filter: buildFullShareFilter({
          path: filter.path,
          includeSubfolders: filter.includeSubfolders,
          ratingFilter: filter.ratingFilter,
          mediaTypeFilter: filter.mediaTypeFilter,
          locationBounds: filter.locationBounds,
          dateRange: filter.dateRange,
          peopleInImageFilter: filter.peopleInImageFilter,
          faceClusterFilter: filter.faceClusterFilter,
          cameraModelFilter: filter.cameraModelFilter,
          lensFilter: filter.lensFilter,
        }),
        ...(filter.semanticQuery ? { semanticQuery: filter.semanticQuery } : {}),
      };

      fetch("/api/page-title", {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { title?: string } | null) => {
          if (data?.title) document.title = `${data.title} – Photrix`;
        })
        .catch(() => {
          // Aborted or network error — leave current title
        });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [filter]);
};
