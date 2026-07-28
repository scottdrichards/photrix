import { memo, useEffect, useRef, useState } from "react";
import type { PhotoItem } from "../api";
import { fetchPhotos, fetchSemanticSearch } from "../api";
import { Spinner } from "../Spinner";
import { useFilter } from "./filter/FilterContext";
import { useSelectionContext } from "./selection/SelectionContext";
import { ThumbnailTile } from "./ThumbnailTile";
import { SelectionActionBar } from "./SelectionActionBar";
import { SortControl } from "./SortControl";
import { ViewToggle } from "./ViewToggle";
import css from "./ThumbnailGrid.module.css";

const PAGE_SIZE = 200;
const numberFormatter = new Intl.NumberFormat();

type ThumbnailGridProps = {
  view: "library" | "people";
  onViewChange: (view: "library" | "people") => void;
};

const ThumbnailGridComponent = ({ view, onViewChange }: ThumbnailGridProps) => {
  const { filter } = useFilter();
  const { setItems } = useSelectionContext();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{
    items: PhotoItem[];
    total: number;
    filterUsed: typeof filter;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPage(1);
    // Keep stale data visible while the new query is in flight (stale-while-revalidate).
    // The grid dims via isStale until the fetch resolves.
  }, [filter]);

  useEffect(() => {
    const abortOnDisposed = "disposed";
    const abortController = new AbortController();
    const { semanticQuery, ...filterOptions } = filter;

    setLoading(true);

    const fetchPromise = semanticQuery
      ? fetchSemanticSearch({
          q: semanticQuery,
          signal: abortController.signal,
          ...filterOptions,
        })
      : fetchPhotos({
          page,
          pageSize: PAGE_SIZE,
          signal: abortController.signal,
          ...filterOptions,
        });

    fetchPromise
      .then((result) => {
        setData((previousData) => {
          if (semanticQuery || page === 1 || !previousData) {
            return { ...result, filterUsed: filter };
          }

          const existingPaths = new Set(previousData.items.map((item) => item.path));
          const nextItems = [
            ...previousData.items,
            ...result.items.filter((item) => !existingPaths.has(item.path)),
          ];

          return {
            ...result,
            items: nextItems,
            filterUsed: filter,
          };
        });
      })
      .catch((err) => {
        if (err === "disposed") return;
        if (err.name === "AbortError") return;
        setError(
          semanticQuery
            ? "Semantic search failed. Is the CLIP worker running?"
            : "Failed to fetch photos",
        );
      })
      .finally(() => {
        setLoading(false);
      });

    return () => {
      abortController.abort(abortOnDisposed);
    };
  }, [filter, page]);

  useEffect(() => {
    setItems(data?.items ?? []);
  }, [data, setItems]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || loading || filter.semanticQuery) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setPage((prev) => prev + 1);
        }
      },
      {
        rootMargin: "200px",
      },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [loading, data?.items.length, data?.total, filter.semanticQuery]);

  const isStale = loading && !!data && page === 1;
  const emptyMessage = filter.semanticQuery
    ? "No results found for your search."
    : "No photos yet. Upload some to get started.";
  const resultCountLabel = data
    ? `${numberFormatter.format(data.total)} result${data.total === 1 ? "" : "s"}`
    : null;

  return (
    <>
      <ViewToggle view={view} onViewChange={onViewChange} />
      {error ? <h3>{error}</h3> : null}
      {resultCountLabel ? (
        <div className={css.statusRow} aria-live="polite">
          <span>{resultCountLabel}</span>
          {isStale && <Spinner size="extra-tiny" />}
          <SortControl />
        </div>
      ) : loading && !data ? (
        <div className={css.statusRow}>
          <Spinner size="extra-tiny" />
        </div>
      ) : null}
      <div
        data-testid="thumbnail-grid"
        className={css.grid}
        style={isStale ? { opacity: 0.5, pointerEvents: "none" } : undefined}
      >
        {data?.items.map((item) => (
          <ThumbnailTile key={item.path} photo={item} />
        ))}
        {!filter.semanticQuery && data && data.items.length < data.total && (
          <div ref={loadMoreSentinelRef} className={css.sentinel}>
            {loading && <Spinner size="extra-tiny" />}
          </div>
        )}
      </div>
      {!loading && data && data.items.length === 0 && <h3>{emptyMessage}</h3>}
      <SelectionActionBar />
    </>
  );
};

export const ThumbnailGrid = memo(ThumbnailGridComponent);
