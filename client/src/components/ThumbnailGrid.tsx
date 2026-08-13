import { memo, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { MomentClusterMember, PhotoItem } from "../api";
import { fetchMomentClusterDetail, fetchPhotos, fetchSemanticSearch } from "../api";
import { Spinner } from "../Spinner";
import { useFilter } from "./filter/FilterContext";
import { useSelectionContext } from "./selection/SelectionContext";
import { ThumbnailTile } from "./ThumbnailTile";
import { PhotoStackModal } from "./PhotoStackModal";
import { SelectionActionBar } from "./SelectionActionBar";
import { SortControl } from "./SortControl";
import { TopRailPortal } from "./TopRailPortal";
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

/**
 * Stable per-photo identity for the View Transitions API (see
 * handleToggleStack) — a valid CSS custom-ident derived from the photo's
 * path, so the browser can match a tile before/after a toggle (the
 * representative tile becomes one of the unstacked member tiles, or vice
 * versa) and animate it moving/resizing into place instead of just cutting
 * over. Not guaranteed globally unique across pathologically-similar paths
 * (e.g. two different real characters both collapsing to the same `-`), but
 * collisions are only possible *within one moment cluster's own members*
 * (the only tiles ever given a name at the same time) — negligible for real
 * photo filenames.
 */
const photoViewTransitionName = (path: string): string =>
  `photrix-tile-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/** Feature-detects the View Transitions API and runs `update` through it when
 * available, falling back to a plain (unanimated) update otherwise. Safari
 * added support in 18.2 (late 2024); older Safari/Firefox silently get the
 * plain path with no error. */
const runWithViewTransition = (update: () => void): void => {
  const startViewTransition = document.startViewTransition?.bind(document);
  if (!startViewTransition) {
    update();
    return;
  }
  startViewTransition(() => flushSync(update));
};

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

  // The moment cluster whose "more options" modal (permanently unstack / pick
  // a different representative) is currently open, or null. This is now a
  // secondary path reached via the tile's kebab — the primary click (the
  // stack/restack badge) toggles inline unstacking directly, below.
  const [expandedStackClusterId, setExpandedStackClusterId] = useState<string | null>(
    null,
  );
  // Clusters currently shown inline-unstacked (every member as its own tile,
  // in place of the single collapsed representative) — client-only, never
  // persisted, toggled by clicking the stack/restack badge. Cleared on
  // navigation away (new filter/search) since it's explicitly a "this view"
  // affordance, not a saved preference.
  const [openStackClusterIds, setOpenStackClusterIds] = useState<Set<string>>(new Set());
  // Fetched member lists, keyed by clusterId, kept around independently of
  // openStackClusterIds so toggling a stack closed and back open again reuses
  // the fetch instead of re-requesting it every time.
  const [clusterMembersCache, setClusterMembersCache] = useState<
    Map<string, MomentClusterMember[]>
  >(new Map());
  // Clusters permanently dissolved via the modal. The gallery query result
  // still has the (now-stale) representative row with its old
  // momentClusterId/momentClusterSize until the next fetch; tracking this
  // client-side makes the badge disappear immediately instead of waiting on a
  // refetch.
  const [dissolvedClusterIds, setDissolvedClusterIds] = useState<Set<string>>(new Set());

  // Toggles a cluster between collapsed and inline-unstacked. Shared by both
  // the stack badge (collapsed -> unstacked, fetching+caching members on
  // first use) and the restack badge on an unstacked member (unstacked ->
  // collapsed, no fetch needed) — which one happens falls out of whether
  // `clusterId` is already open, so both badges can wire up the exact same
  // callback.
  //
  // Animates via the View Transitions API (runWithViewTransition) whenever
  // the DOM shape change is *synchronous* — closing (collapsing back down)
  // and re-opening from the cache both qualify, since nothing has to wait on
  // a network round trip. The very first expand of a given cluster
  // deliberately does NOT animate: the API supports an async callback (it'll
  // wait for a returned promise before capturing the "after" state), but
  // that would mean the browser holds a static screenshot of the page for
  // however long the fetch takes — a worse trade than just skipping the
  // animation on this one (first-time-only, forever-after-cached) path.
  const handleToggleStack = (clusterId: string) => {
    const isCurrentlyOpen = openStackClusterIds.has(clusterId);

    if (isCurrentlyOpen) {
      runWithViewTransition(() => {
        setOpenStackClusterIds((prev) => {
          const next = new Set(prev);
          next.delete(clusterId);
          return next;
        });
      });
      return;
    }

    if (clusterMembersCache.has(clusterId)) {
      runWithViewTransition(() => {
        setOpenStackClusterIds((prev) => new Set(prev).add(clusterId));
      });
      return;
    }

    setOpenStackClusterIds((prev) => new Set(prev).add(clusterId));
    fetchMomentClusterDetail(clusterId)
      .then((detail) => {
        setClusterMembersCache((prev) => new Map(prev).set(clusterId, detail?.members ?? []));
      })
      .catch(() => {
        // Revert the optimistic open on failure — otherwise the tile looks
        // toggled but silently shows nothing, with no way to tell why.
        setOpenStackClusterIds((prev) => {
          const next = new Set(prev);
          next.delete(clusterId);
          return next;
        });
      });
  };

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
    if (openStackClusterIds.size > 0) setOpenStackClusterIds(new Set());
    if (clusterMembersCache.size > 0) setClusterMembersCache(new Map());
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
      <TopRailPortal>
        <ViewToggle view={view} onViewChange={onViewChange} />
      </TopRailPortal>
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
        {data?.items.map((item) => {
          const clusterId = item.metadata?.momentClusterId;
          const clusterIdKey = clusterId != null ? String(clusterId) : null;

          // Toggled inline-unstacked: render every member as its own tile, in
          // place of the single collapsed representative, each carrying a
          // restack badge that folds the group back down (calls the same
          // handleToggleStack — it already knows this cluster is open).
          const unstackedMembers =
            clusterIdKey && openStackClusterIds.has(clusterIdKey)
              ? clusterMembersCache.get(clusterIdKey)
              : undefined;
          if (unstackedMembers) {
            // No wrapper element — each member stays an ordinary flex
            // sibling directly in .grid, with its own individual
            // --ratio-driven flex-grow/sizing exactly like a non-clustered
            // tile (a wrapper was tried and reverted specifically because it
            // changed how leftover row space distributes — see
            // ThumbnailGrid.module.css's comment on .clusterMember). The
            // "one continuous framed block" look comes entirely from
            // borders: every member gets one (.clusterMember), non-first
            // members get pulled left to make adjacent borders overlap into
            // a single shared line instead of doubling up
            // (.clusterMemberTight), and only the run's outer corners round
            // (.clusterMemberRoundStart / .clusterMemberRoundEnd).
            return unstackedMembers.map((member, index) => {
              const isFirst = index === 0;
              const isLast = index === unstackedMembers.length - 1;
              const memberClassName = [
                css.clusterMember,
                !isFirst && css.clusterMemberTight,
                isFirst && css.clusterMemberRoundStart,
                isLast && css.clusterMemberRoundEnd,
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <ThumbnailTile
                  key={member.photo.path}
                  photo={member.photo}
                  restackCount={unstackedMembers.length}
                  onToggleStack={() => handleToggleStack(clusterIdKey!)}
                  onOpenStackActions={() => setExpandedStackClusterId(clusterIdKey!)}
                  className={memberClassName}
                  viewTransitionName={photoViewTransitionName(member.photo.path)}
                />
              );
            });
          }

          const stackCount =
            clusterIdKey && !dissolvedClusterIds.has(clusterIdKey)
              ? (item.metadata?.momentClusterSize as number | undefined)
              : undefined;

          return (
            <ThumbnailTile
              key={item.path}
              photo={item}
              stackCount={stackCount}
              onToggleStack={
                clusterIdKey ? () => handleToggleStack(clusterIdKey) : undefined
              }
              onOpenStackActions={
                clusterIdKey ? () => setExpandedStackClusterId(clusterIdKey) : undefined
              }
              viewTransitionName={
                clusterIdKey ? photoViewTransitionName(item.path) : undefined
              }
            />
          );
        })}
        {!filter.semanticQuery && data && data.items.length < data.total && (
          <div ref={loadMoreSentinelRef} className={css.sentinel}>
            {loading && <Spinner size="extra-tiny" />}
          </div>
        )}
      </div>
      {!loading && data && data.items.length === 0 && <h3>{emptyMessage}</h3>}
      <SelectionActionBar />
      <PhotoStackModal
        clusterId={expandedStackClusterId}
        onDismiss={() => setExpandedStackClusterId(null)}
        onPermanentlyDissolved={(clusterId) => {
          setDissolvedClusterIds((prev) => new Set(prev).add(clusterId));
          setOpenStackClusterIds((prev) => {
            if (!prev.has(clusterId)) return prev;
            const next = new Set(prev);
            next.delete(clusterId);
            return next;
          });
        }}
      />
    </>
  );
};

export const ThumbnailGrid = memo(ThumbnailGridComponent);
