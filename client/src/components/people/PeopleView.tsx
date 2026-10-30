import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { PeopleSelection } from "../../filterUrlState";
import type { FaceClusterPCAPoint, PersonCluster, PersonCentroid, PersonClusterWithFaces, PeopleClustersResult } from "../../api";
import { fetchClusterDetail, fetchFaceClustersPCA, fetchPeopleClusters, mergeClusters, renameCluster, separateCluster, setPersonTags, fetchDefaultExclusionFilter, setDefaultExclusionFilter } from "../../api";
import { Spinner } from "../../Spinner";
import { useFilter } from "../filter/FilterContext";
import { useSelectionContext } from "../selection/SelectionContext";
import { FaceClusterViz } from "./FaceClusterViz";
import { TopRailPortal } from "../TopRailPortal";
import { ViewToggle } from "../ViewToggle";
import { isSharedView } from "../../hooks/useShareFilter";
import css from "./PeopleView.module.css";
import { PersonDetail, type SelectedFaceGroup } from "./PersonDetail";
import { ClusterCard } from "./ClusterCard";
import { applyOptimisticClusterMerge, applyOptimisticDetailMerge, chooseCanonicalMergeTarget } from "./peopleMerge";

// Share-link viewers are read-only: they may browse people but never rename,
// merge, or separate clusters (the server rejects those writes too). Computed
// from the URL token, which is fixed for the page's lifetime.
const READ_ONLY = isSharedView();

/**
 * The open person and match group are owned by the URL (see `filterUrlState`),
 * not by this component: they arrive as props and every navigation is reported
 * back through `onNavigate`. That keeps a single writer for the address bar, so
 * a refresh or a back button lands exactly where the user was.
 */
type PeopleViewProps = {
  view: "library" | "people";
  onViewChange: (view: "library" | "people") => void;
  personId: string | null;
  groupId: string | null;
  onNavigate: (next: PeopleSelection, options?: { replace?: boolean }) => void;
};

const PEOPLE_PAGE_SIZE = 120;

const PeopleViewComponent = ({
  view,
  onViewChange,
  personId,
  groupId,
  onNavigate,
}: PeopleViewProps) => {
  const { filter } = useFilter();
  const { setItems } = useSelectionContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PeopleClustersResult | null>(null);
  const [personDetail, setPersonDetail] = useState<PersonClusterWithFaces | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);
  const [mergingSuggestionId, setMergingSuggestionId] = useState<string | null>(null);
  const [separatingCentroidId, setSeparatingCentroidId] = useState<string | null>(null);
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<Set<string>>(new Set());
  const [selectedFaceGroup, setSelectedFaceGroup] = useState<SelectedFaceGroup | null>(null);
  const [selectedFaceGroupLoading, setSelectedFaceGroupLoading] = useState(false);
  const [vizPoints, setVizPoints] = useState<FaceClusterPCAPoint[] | null>(null);
  const [vizLoading, setVizLoading] = useState(false);
  // Only render this many cluster cards at once. The server lists up to 1000
  // clusters (a long tail of tiny noise groups), and each card loads a
  // server-generated face crop; rendering all of them floods the browser with
  // DOM nodes and crop requests. Reveal more on demand instead.
  const [visibleCount, setVisibleCount] = useState(PEOPLE_PAGE_SIZE);
  // Feedback #95: which person (if any) is currently the standing default
  // exclusion — `null` means none set, `undefined` means "not loaded yet".
  // Loaded once; a numeric faceCluster id is the only shape this UI writes,
  // even though the server-side setting can hold any FilterElement.
  const [defaultExclusionPersonId, setDefaultExclusionPersonId] = useState<
    number | null | undefined
  >(undefined);
  useEffect(() => {
    if (READ_ONLY) return;
    fetchDefaultExclusionFilter()
      .then((f) => {
        const id = f && typeof f.faceCluster === "number" ? f.faceCluster : null;
        setDefaultExclusionPersonId(id);
      })
      .catch(() => setDefaultExclusionPersonId(null));
  }, []);
  const vizRequestRef = useRef<AbortController | null>(null);
  const selectedFaceGroupRequestRef = useRef<AbortController | null>(null);
  // Tracks the post-merge refresh (detail + grid) kicked off by the most
  // recent suggested-merge action — see handleMergeSuggestion.
  const mergeSuggestionRefreshRef = useRef<AbortController | null>(null);
  // Id of the cluster currently loaded into `personDetail`, read by effects that
  // must not re-run merely because the detail object was replaced.
  const loadedClusterIdRef = useRef<string | null>(null);
  loadedClusterIdRef.current = personDetail?.id ?? null;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    const abortOnDisposed = "disposed";
    const abortController = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const load = (initial: boolean) => {
      fetchPeopleClusters({
        signal: abortController.signal,
        ...filter,
      })
        .then((result) => {
          setData(result);
          if (result.pendingFaces > 0 && !abortController.signal.aborted) {
            refreshTimer = setTimeout(() => load(false), 10_000);
          }
        })
        .catch((err) => {
          if (err === abortOnDisposed || err.name === "AbortError") return;
          setError("Failed to fetch people clusters");
        })
        .finally(() => {
          if (initial) setLoading(false);
        });
      if (initial) {
        setLoading(true);
        setError(null);
        setVisibleCount(PEOPLE_PAGE_SIZE);
      }
    };

    load(true);
    return () => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      abortController.abort(abortOnDisposed);
    };
  }, [filter]);

  // When the filter changes while a person detail is open, the People grid
  // re-fetches (effect above) but the open detail would keep showing faces and
  // counts from the previous filter. Re-fetch the detail so everything on screen
  // reflects the same filter; if the person has no matching faces, fall back to
  // the grid. Skip the first run: the loader above already fetched with the
  // current filter, and a freshly opened detail is fetched with it too.
  const skipFilterReloadRef = useRef(true);
  useEffect(() => {
    if (skipFilterReloadRef.current) {
      skipFilterReloadRef.current = false;
      return;
    }
    const openClusterId = loadedClusterIdRef.current;
    if (!openClusterId) return;
    const abortController = new AbortController();
    loadClusterDetail(openClusterId, abortController.signal, { showSpinner: false })
      .then((cluster) => {
        if (abortController.signal.aborted || cluster) return;
        // Person has no faces under the new filter — return to the grid. The
        // user didn't ask for this, so it replaces rather than adds history.
        onNavigateRef.current({ personId: null, groupId: null }, { replace: true });
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        console.error("Failed to reload cluster detail after filter change:", err);
      });
    return () => abortController.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  useEffect(() => () => {
    vizRequestRef.current?.abort();
  }, []);

  useEffect(() => () => {
    selectedFaceGroupRequestRef.current?.abort();
  }, []);

  useEffect(() => () => {
    mergeSuggestionRefreshRef.current?.abort();
  }, []);

  useEffect(() => {
    setDismissedSuggestionIds(new Set());
  }, [personId]);

  // Load the person named by the URL. This is the *only* path that opens a
  // person, so a fresh page load, a click and a back button all behave the same.
  useEffect(() => {
    if (!personId) {
      setPersonDetail(null);
      setDetailLoading(false);
      setItems([]);
      return;
    }
    if (loadedClusterIdRef.current === personId) return;

    const abortController = new AbortController();
    loadClusterDetail(personId, abortController.signal)
      .then((cluster) => {
        if (abortController.signal.aborted || cluster) return;
        // Unknown or filtered-out person id — drop back to the grid.
        onNavigateRef.current({ personId: null, groupId: null }, { replace: true });
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        console.error("Failed to load cluster detail:", err);
      });
    return () => abortController.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, setItems]);

  // Load the match group named by the URL. Re-runs on filter changes so the
  // group's faces never outlive the filter they were fetched under.
  useEffect(() => {
    selectedFaceGroupRequestRef.current?.abort();
    selectedFaceGroupRequestRef.current = null;

    if (!personId || !groupId) {
      setSelectedFaceGroup(null);
      setSelectedFaceGroupLoading(false);
      return;
    }

    const abortController = new AbortController();
    selectedFaceGroupRequestRef.current = abortController;
    setSelectedFaceGroup({ id: groupId, faces: [] });
    setSelectedFaceGroupLoading(true);

    fetchClusterDetail({
      clusterId: groupId,
      exactCluster: true,
      signal: abortController.signal,
      ...filter,
    })
      .then((result) => {
        if (abortController.signal.aborted) return;
        if (!result.cluster) {
          onNavigateRef.current({ personId, groupId: null }, { replace: true });
          return;
        }
        setSelectedFaceGroup({ id: groupId, faces: result.cluster.faces });
      })
      .catch((err) => {
        if (err === "disposed" || (err as { name?: string })?.name === "AbortError") return;
        console.error("Failed to load related group faces:", err);
        onNavigateRef.current({ personId, groupId: null }, { replace: true });
      })
      .finally(() => {
        if (selectedFaceGroupRequestRef.current === abortController) {
          selectedFaceGroupRequestRef.current = null;
          setSelectedFaceGroupLoading(false);
        }
      });

    return () => abortController.abort();
  }, [personId, groupId, filter]);

  // A deep link carries only ids, so the group's caption is derived from the
  // person rather than remembered from the click that opened it.
  const selectedFaceGroupLabel = useMemo(() => {
    if (!groupId || !personDetail) return "";
    const centroid = personDetail.centroids.find((entry) => entry.id === groupId);
    if (centroid) return `${centroid.count} faces`;
    const suggestion = personDetail.mergeSuggestions.find((entry) => entry.id === groupId);
    if (suggestion) return suggestion.name ?? `${suggestion.count} faces`;
    return "";
  }, [groupId, personDetail]);

  const refreshPeopleClusters = async (signal?: AbortSignal) => {
    const result = await fetchPeopleClusters({ ...filter, signal });
    setData(result);
    return result;
  };

  const loadClusterDetail = async (
    clusterId: string,
    signal?: AbortSignal,
    options: { showSpinner?: boolean } = {},
  ) => {
    const { showSpinner = true } = options;
    if (showSpinner) setDetailLoading(true);
    try {
      const result = await fetchClusterDetail({ clusterId, signal, ...filter });
      if (result.cluster) setPersonDetail(result.cluster);
      return result.cluster;
    } finally {
      if (showSpinner) setDetailLoading(false);
    }
  };

  const handleClusterClick = (cluster: PersonCluster, event: React.MouseEvent) => {
    // If any clusters are selected, treat click as toggle
    if (selected.size > 0) {
      event.preventDefault();
      toggleSelect(cluster.id);
      return;
    }

    // Navigate rather than fetch: the URL effect owns loading, so a click, a
    // deep link and the back button all take the same path.
    onNavigate({ personId: cluster.id, groupId: null });
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleLongPress = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const handleMerge = async () => {
    if (selected.size < 2) return;
    // Use the largest cluster as target (first in list by count)
    const ids = Array.from(selected);
    const clusters = data?.clusters ?? [];
    const ordered = ids
      .map((id) => clusters.find((c) => c.id === id))
      .filter(Boolean) as PersonCluster[];
      ordered.sort(
        (a, b) => Number(Boolean(b.name)) - Number(Boolean(a.name)) || b.count - a.count,
      );
    const [target, ...sources] = ordered;
    const previousData = data;
    const previousSelected = selected;
    setMerging(true);
    setData((prev) => applyOptimisticClusterMerge(prev, sources, target));
    setSelected(new Set());
    try {
      await mergeClusters(
        sources.map((c) => c.id),
        target.id,
      );
      refreshPeopleClusters().catch((err) => {
        console.error("Failed to refresh people clusters after merge:", err);
      });
    } catch (err) {
      setData(previousData);
      setSelected(previousSelected);
      console.error("Failed to merge clusters:", err);
    } finally {
      setMerging(false);
    }
  };

  const handleRenameInDetail = async (name: string | null) => {
    if (!personDetail) return;
    try {
      await renameCluster(personDetail.id, name);
      setPersonDetail({ ...personDetail, name });
      setData((prev) =>
        prev
          ? {
              ...prev,
              clusters: prev.clusters.map((c) =>
                c.id === personDetail.id ? { ...c, name } : c,
              ),
            }
          : prev,
      );
    } catch (err) {
      console.error("Failed to rename cluster:", err);
    }
  };

  const handleSetTagsInDetail = async (tags: string[]) => {
    if (!personDetail) return;
    try {
      await setPersonTags(personDetail.id, tags);
      setPersonDetail({ ...personDetail, tags });
      setData((prev) =>
        prev
          ? {
              ...prev,
              clusters: prev.clusters.map((c) =>
                c.id === personDetail.id ? { ...c, tags } : c,
              ),
            }
          : prev,
      );
    } catch (err) {
      console.error("Failed to set person tags:", err);
    }
  };

  // Feedback #95: toggle this person as the app-wide default exclusion.
  // Deliberately single-target for now — setting a new one replaces any
  // previous one, matching the settings row's one-value-at-a-time shape.
  const handleToggleDefaultExclusion = async () => {
    if (!personDetail) return;
    const numericId = Number(personDetail.id.replace(/^person-/, ""));
    if (!Number.isFinite(numericId)) return;
    const currentlyExcluded = defaultExclusionPersonId === numericId;
    try {
      await setDefaultExclusionFilter(currentlyExcluded ? null : { faceCluster: numericId });
      setDefaultExclusionPersonId(currentlyExcluded ? null : numericId);
    } catch (err) {
      console.error("Failed to toggle default exclusion:", err);
    }
  };

  const handleRenameInGrid = async (cluster: PersonCluster, name: string | null) => {
    try {
      await renameCluster(cluster.id, name);
      setData((prev) =>
        prev
          ? {
              ...prev,
              clusters: prev.clusters.map((c) => (c.id === cluster.id ? { ...c, name } : c)),
            }
          : prev,
      );
    } catch (err) {
      console.error("Failed to rename cluster:", err);
    }
  };

  const handleBack = () => {
    onNavigate({ personId: null, groupId: null });
  };

  const openClusterDetail = (id: string) => {
    vizRequestRef.current?.abort();
    vizRequestRef.current = null;
    setVizLoading(false);
    setVizPoints(null);
    onNavigate({ personId: id, groupId: null });
  };

  const clearSelectedFaceGroup = () => {
    onNavigate({ personId, groupId: null });
  };

  /**
   * Viewing a group is a navigation, not a fetch. The group effect owns the
   * request and aborts the previous one, so clicking through several groups
   * quickly leaves exactly one in flight — the last one asked for.
   */
  const handleViewRelatedGroup = (relatedGroup: { id: string }) => {
    onNavigate({
      personId,
      groupId: selectedFaceGroup?.id === relatedGroup.id ? null : relatedGroup.id,
    });
  };

  const handleMergeSuggestion = async (suggestion: PersonCluster) => {
    if (!personDetail) return;
    if (selectedFaceGroup?.id === suggestion.id) clearSelectedFaceGroup();
    const previousDetail = personDetail;
    const previousData = data;
    const currentCluster: PersonCluster = {
      id: personDetail.id,
      count: personDetail.count,
      representative: personDetail.representative,
      name: personDetail.name,
      tags: personDetail.tags,
    };
    const canonicalTarget = chooseCanonicalMergeTarget(currentCluster, suggestion);
    const mergedAwayCluster = canonicalTarget.id === currentCluster.id ? suggestion : currentCluster;
    setMergingSuggestionId(suggestion.id);
    setPersonDetail((prev) => (prev ? applyOptimisticDetailMerge(prev, suggestion) : prev));
    setData((prev) => applyOptimisticClusterMerge(prev, [mergedAwayCluster], canonicalTarget));
    // Merging suggestions A, then B, then D in quick succession must not let an
    // earlier merge's post-merge refresh resolve *after* a later one and
    // re-populate the suggestions list with stale data — that's the reported
    // flicker (disappear, reappear, then disappear again). Same discipline as
    // loadViz/the related-group effect above: abort the previous in-flight
    // refresh before starting this one's.
    mergeSuggestionRefreshRef.current?.abort();
    const refreshController = new AbortController();
    mergeSuggestionRefreshRef.current = refreshController;
    try {
      await mergeClusters([suggestion.id], personDetail.id);
      loadClusterDetail(canonicalTarget.id, refreshController.signal, { showSpinner: false }).catch(
        (err) => {
          if (err?.name === "AbortError") return;
          console.error("Failed to refresh merged cluster detail:", err);
        },
      );
      refreshPeopleClusters(refreshController.signal).catch((err) => {
        if (err?.name === "AbortError") return;
        console.error("Failed to refresh people clusters after suggested merge:", err);
      });
    } catch (err) {
      setPersonDetail(previousDetail);
      setData(previousData);
      console.error("Failed to merge suggested cluster:", err);
    } finally {
      setMergingSuggestionId(null);
    }
  };

  const handleSeparateCentroid = async (centroid: PersonCentroid) => {
    if (!personDetail || centroid.id === personDetail.id) return;
    if (selectedFaceGroup?.id === centroid.id) clearSelectedFaceGroup();
    setSeparatingCentroidId(centroid.id);
    try {
      await separateCluster(centroid.id);
      await Promise.all([loadClusterDetail(personDetail.id), refreshPeopleClusters()]);
    } catch (err) {
      console.error("Failed to separate cluster:", err);
    } finally {
      setSeparatingCentroidId(null);
    }
  };

  const handleDismissSuggestion = (suggestionId: string) => {
    if (selectedFaceGroup?.id === suggestionId) clearSelectedFaceGroup();
    setDismissedSuggestionIds((prev) => {
      if (prev.has(suggestionId)) return prev;
      const next = new Set(prev);
      next.add(suggestionId);
      return next;
    });
  };

  const loadViz = (clusterId?: string) => {
    vizRequestRef.current?.abort();
    const abortController = new AbortController();
    vizRequestRef.current = abortController;
    setVizLoading(true);
    fetchFaceClustersPCA({ clusterId, signal: abortController.signal })
      .then((points) => {
        if (!abortController.signal.aborted) setVizPoints(points);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        console.error("Failed to load face PCA:", err);
      })
      .finally(() => {
        if (vizRequestRef.current === abortController) {
          vizRequestRef.current = null;
          setVizLoading(false);
        }
      });
  };

  const handleShowViz = () => {
    loadViz();
  };

  const handleVizFocusCluster = (id: string) => {
    loadViz(id);
  };

  const handleCloseViz = () => {
    vizRequestRef.current?.abort();
    vizRequestRef.current = null;
    setVizLoading(false);
    setVizPoints(null);
  };

  // Opening a person must not wait on the round trip. The card that was just
  // clicked already carries the name, count and face, so the page can be built
  // from it and only the face grid is left to fill in. A deep link has no card
  // to borrow from, so it still waits — there is genuinely nothing to show yet.
  const seededDetail: PersonClusterWithFaces | null =
    !personDetail && personId
      ? (() => {
          const card = data?.clusters.find((entry) => entry.id === personId);
          return card
            ? { ...card, faces: [], centroids: [], mergeSuggestions: [] }
            : null;
        })()
      : null;

  const shownDetail = personDetail ?? seededDetail;
  const visibleDetail = shownDetail
    ? {
        ...shownDetail,
        mergeSuggestions: shownDetail.mergeSuggestions.filter(
          (suggestion) => !dismissedSuggestionIds.has(suggestion.id),
        ),
      }
    : null;

  if (visibleDetail) {
    return (
      <section className={css.peopleView}>
        <TopRailPortal>
          <ViewToggle view={view} onViewChange={onViewChange} />
        </TopRailPortal>
        <PersonDetail
          cluster={visibleDetail}
          loadingFaces={!personDetail}
          onBack={handleBack}
          onViewRelatedGroup={handleViewRelatedGroup}
          onClearSelectedFaceGroup={clearSelectedFaceGroup}
          selectedFaceGroup={selectedFaceGroup}
          selectedFaceGroupLabel={selectedFaceGroupLabel}
          selectedFaceGroupLoading={selectedFaceGroupLoading}
          onMergeSuggestion={handleMergeSuggestion}
          onDismissSuggestion={handleDismissSuggestion}
          mergingSuggestionId={mergingSuggestionId}
          onSeparateCentroid={handleSeparateCentroid}
          separatingCentroidId={separatingCentroidId}
          onRename={handleRenameInDetail}
          onSetTags={handleSetTagsInDetail}
          isDefaultExcluded={
            defaultExclusionPersonId === Number(visibleDetail.id.replace(/^person-/, ""))
          }
          onToggleDefaultExclusion={handleToggleDefaultExclusion}
          onReviewChanged={() => {
            void loadClusterDetail(visibleDetail.id, undefined, { showSpinner: false });
            void refreshPeopleClusters();
          }}
        />
      </section>
    );
  }

  return (
    <section className={css.peopleView}>
      <TopRailPortal>
        <ViewToggle view={view} onViewChange={onViewChange} />
      </TopRailPortal>
      {vizPoints !== null && (
        <FaceClusterViz
          points={vizPoints}
          onFocusCluster={handleVizFocusCluster}
          onResetOverview={handleShowViz}
          onOpenCluster={openClusterDetail}
          onClose={handleCloseViz}
        />
      )}
      <div className={css.summaryRow}>
        <h3>People</h3>
        <div className={css.summaryActions}>
          {!READ_ONLY && selected.size >= 2 && (
            <button
              type="button"
              className={css.mergeButton}
              onClick={handleMerge}
              disabled={merging}
            >
              {merging ? "Merging…" : `Merge ${selected.size} people`}
            </button>
          )}
          {selected.size > 0 && (
            <button
              type="button"
              className={css.cancelSelectButton}
              onClick={() => setSelected(new Set())}
            >
              Cancel
            </button>
          )}
          {data ? (
            <small>
              {data.totalClusters} clusters • {data.totalFaces} faces
              {data.pendingFaces > 0
                ? ` • clustering ${data.pendingFaces.toLocaleString()} more…`
                : ""}
            </small>
          ) : null}
          <button
            type="button"
            className={css.vizButton}
            onClick={handleShowViz}
            disabled={vizLoading || !data || data.clusters.length < 2}
            title="Explore face embedding space in 3D"
            aria-label="Show 3D face embedding visualization"
          >
            {vizLoading ? "…" : "✦"}
          </button>
        </div>
      </div>

      {error ? <h3>{error}</h3> : null}

      {loading || detailLoading ? (
        <div className={css.spinnerWrap}>
          <Spinner size="small" />
        </div>
      ) : null}

      {data && data.clusters.length === 0 ? (
        <h3>No clustered faces for the current filter.</h3>
      ) : null}

      {!READ_ONLY && selected.size === 0 && (
        <p className={css.selectHint}>Long-press or right-click a person to select for merging</p>
      )}

      {data && data.clusters.length > 0 ? (
        <>
          <div className={css.clusterList}>
            {data.clusters.slice(0, visibleCount).map((cluster) => (
              <ClusterCard
                key={cluster.id}
                cluster={cluster}
                isSelected={selected.has(cluster.id)}
                onClick={(e) => handleClusterClick(cluster, e)}
                onLongPress={() => handleLongPress(cluster.id)}
                onToggleSelect={() => toggleSelect(cluster.id)}
                onRename={(name) => handleRenameInGrid(cluster, name)}
              />
            ))}
          </div>
          {data.clusters.length > visibleCount ? (
            <button
              type="button"
              className={css.showMoreButton}
              onClick={() => setVisibleCount((n) => n + PEOPLE_PAGE_SIZE)}
            >
              Show more ({data.clusters.length - visibleCount} more)
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
};

export const PeopleView = memo(PeopleViewComponent);
