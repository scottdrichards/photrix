import { useEffect, useRef, useState } from "react";
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

/**
 * Sets `document.title` from the current filter (existing behaviour) and,
 * since feedback #85, also returns the same generated description so the
 * header subtitle can append it — "A better way to view photos... of your
 * trip to Mexico" — rather than it only being visible in the browser tab.
 * Same request, same debounce, same server-side generateShareDescription
 * (also #86's nearby-city grounding when a map bounding box is present) —
 * this hook is now the one source for "what does the current view look
 * like", consumed two ways.
 */
export const usePageTitle = (filter: FilterState): { description: string | null } => {
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [description, setDescription] = useState<string | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();

    if (isEmptyFilter(filter)) {
      document.title = "Photrix";
      setDescription(null);
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
          if (data?.title) {
            document.title = `${data.title} – Photrix`;
            setDescription(data.title);
          }
        })
        .catch(() => {
          // Aborted or network error — leave current title/description
        });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [filter]);

  return { description };
};
