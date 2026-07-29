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
/**
 * How far below the last loaded tile the next page is requested. The sentinel
 * sits at the very end of the grid, so this is the entire warning the fetch
 * gets: at 200px the user reached the bottom of the content and *then* waited
 * for a round trip plus a 200-tile mount. Two thousand pixels is roughly a
 * screenful and a half of runway on a desktop, which is enough to have the next
 * page merged before the scroll arrives.
 */
const LOAD_MORE_MARGIN_PX = 2000;
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

  // Reset paging during render rather than in an effect. As an effect, the fetch
  // effect below still ran once with the *previous* page against the new filter
  // — so changing a filter while on page 5 fired a full page-5 query, aborted
  // it, and only then fetched page 1. Adjusting here means the re-render happens
  // before any effect runs and that wasted query never leaves the browser.
  // Stale data stays visible while the new query is in flight; the grid dims via
  // isStale until it resolves.
  const lastFilterRef = useRef(filter);
  if (lastFilterRef.current !== filter) {
    lastFilterRef.current = filter;
    if (page !== 1) setPage(1);
  }

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
          // Disconnect before advancing: a second callback in the same batch
          // would bump the page twice and silently skip 200 items, which the
          // path-based dedupe on merge would then hide rather than repair.
          observer.disconnect();
          setPage((prev) => prev + 1);
        }
      },
      {
        rootMargin: `${LOAD_MORE_MARGIN_PX}px 0px`,
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
