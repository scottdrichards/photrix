import { useEffect, useMemo, useRef, useState } from "react";
import type { ClusterFace, PersonCluster, PersonCentroid, PersonClusterWithFaces } from "../../api";
import { excludeFaceFromCluster } from "../../api";
import { Spinner } from "../../Spinner";
import { useSelectionContext } from "../selection/SelectionContext";
import { PersonReviewPanel } from "./PersonReviewPanel";
import { isSharedView } from "../../hooks/useShareFilter";
import css from "./PeopleView.module.css";
import { FACE_SORT_LABELS, sortFaces, type FaceSort } from "./faceSort";
import { FaceImage, FaceThumb } from "./FaceThumb";
import { InlineNameEditor } from "./InlineNameEditor";
import { PersonTagEditor } from "./PersonTagEditor";

const READ_ONLY = isSharedView();

export type SelectedFaceGroup = {
  id: string;
  faces: ClusterFace[];
};

// How many face crops to mount up front, and grow by per scroll page. A
// popular person's cluster can carry up to a few thousand matches (server
// caps at MAX_FACES_IN_CLUSTER_DETAIL), and each face crop is its own HTTP
// round trip plus an on-demand server-side image decode — mounting all of
// them at once (even behind `loading="lazy"`) was the actual "slow to load
// all matches" reported in feedback #89: hundreds/thousands of <img> tags
// enter the DOM and a large fraction still end up within the browser's own
// lazy-load prefetch margin. Client-side pagination keeps the same API
// response (one request, whole list) but bounds how much of it gets a real
// <img> element before the user has scrolled to see it — the same pattern
// ThumbnailGrid already uses for the main grid.
const FACE_PAGE_SIZE = 120;

const FACE_LOAD_MORE_MARGIN_PX = 1200;

type PersonDetailProps = {
  cluster: PersonClusterWithFaces;
  onBack: () => void;
  onViewRelatedGroup: (cluster: { id: string }) => void;
  onClearSelectedFaceGroup: () => void;
  selectedFaceGroup: SelectedFaceGroup | null;
  /** Derived from the person's own groups, so a deep link needs no stored label. */
  selectedFaceGroupLabel: string;
  selectedFaceGroupLoading: boolean;
  onMergeSuggestion: (cluster: PersonCluster) => void;
  onDismissSuggestion: (clusterId: string) => void;
  mergingSuggestionId: string | null;
  onSeparateCentroid: (centroid: PersonCentroid) => void;
  separatingCentroidId: string | null;
  onRename: (name: string | null) => void;
  onSetTags: (tags: string[]) => void;
  /** Feedback #95: this person is the app-wide default-hidden person. */
  isDefaultExcluded: boolean;
  onToggleDefaultExclusion: () => void;
  /** Re-fetches the person after the review panel changes their membership. */
  onReviewChanged: () => void;
  /**
   * The person opened from a card we already had, with their faces still in
   * flight. The header is fully real (name, count and face all come from the
   * card); only the face grid below is still filling in.
   */
  loadingFaces?: boolean;
};

export const PersonDetail = ({
  cluster,
  onBack,
  onViewRelatedGroup,
  onClearSelectedFaceGroup,
  selectedFaceGroup,
  selectedFaceGroupLabel,
  selectedFaceGroupLoading,
  onMergeSuggestion,
  onDismissSuggestion,
  mergingSuggestionId,
  onSeparateCentroid,
  separatingCentroidId,
  onRename,
  onSetTags,
  isDefaultExcluded,
  onToggleDefaultExclusion,
  onReviewChanged,
  loadingFaces = false,
}: PersonDetailProps) => {
  const { setItems, setSelected } = useSelectionContext();
  // Feedback #90: faces excluded this session are hidden immediately
  // (optimistic) rather than waiting on a full detail refetch; the server
  // write is what makes it stick across future clustering passes.
  const [excludedFaceIds, setExcludedFaceIds] = useState<Set<number>>(new Set());
  const [excludingFaceId, setExcludingFaceId] = useState<number | null>(null);
  // The review panel replaces the face grid rather than sitting beside it: both
  // show the same faces, and showing them twice invites the user to correct a
  // face in the list that isn't the one they are reviewing.
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    setReviewing(false);
  }, [cluster.id]);
  // Memoised, not recomputed per render: the effects below depend on this
  // array's identity, and pushing a fresh one into the selection context on
  // every render re-rendered this view forever (~90% of a core while idle).
  const [faceSort, setFaceSort] = useState<FaceSort>("match");
  const visibleFaces = useMemo(
    () =>
      sortFaces(
        (selectedFaceGroup?.faces ?? cluster.faces).filter(
          (face) => !excludedFaceIds.has(face.faceId),
        ),
        faceSort,
      ),
    [selectedFaceGroup?.faces, cluster.faces, excludedFaceIds, faceSort],
  );

  useEffect(() => {
    setItems(visibleFaces.map((face) => face.photo));
    return () => setItems([]);
  }, [setItems, visibleFaces]);

  const handleFaceClick = (face: ClusterFace) => {
    setSelected(face.photo);
  };

  const handleExcludeFace = async (face: ClusterFace) => {
    setExcludingFaceId(face.faceId);
    try {
      await excludeFaceFromCluster(face.faceId);
      setExcludedFaceIds((prev) => new Set(prev).add(face.faceId));
    } catch (err) {
      console.error("Failed to exclude face from cluster:", err);
    } finally {
      setExcludingFaceId(null);
    }
  };

  // How many of visibleFaces actually get an <img> — see FACE_PAGE_SIZE.
  // Reset whenever the underlying list changes identity (a different person,
  // switching into/out of a match-group filter) rather than growing forever.
  const [faceRenderCount, setFaceRenderCount] = useState(FACE_PAGE_SIZE);
  useEffect(() => {
    setFaceRenderCount(FACE_PAGE_SIZE);
  }, [visibleFaces]);
  const renderedFaces = visibleFaces.slice(0, faceRenderCount);
  const hasMoreFaces = faceRenderCount < visibleFaces.length;

  const faceLoadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = faceLoadMoreSentinelRef.current;
    if (!sentinel || !hasMoreFaces) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          setFaceRenderCount((prev) => prev + FACE_PAGE_SIZE);
        }
      },
      { rootMargin: `${FACE_LOAD_MORE_MARGIN_PX}px 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreFaces, faceRenderCount]);

  return (
    <div className={css.personDetail}>
      <div className={css.personDetailHeader}>
        <button type="button" className={css.backButton} onClick={onBack}>
          ← Back
        </button>
        {/* Shrink-to-fit identity card rather than a full-width bar: the
            person's own face anchors the name at a readable size. */}
        <div className={css.personIdentity}>
          <FaceImage
            face={cluster.representative}
            className={css.personIdentityFace}
            priority="high"
          />
          <div className={css.personIdentityText}>
            <InlineNameEditor name={cluster.name} onSave={onRename} />
            <span className={css.personDetailCount}>{cluster.count} faces</span>
            <PersonTagEditor tags={cluster.tags} onSave={onSetTags} />
          </div>
        </div>
        {!READ_ONLY && (
          <button
            type="button"
            className={css.defaultExclusionToggle}
            onClick={() => setReviewing((open) => !open)}
            title="Sort this person's faces by how far they sit from the rest, and cut the ones that don't belong"
          >
            {reviewing ? "Close review" : "Review faces"}
          </button>
        )}
        {!READ_ONLY && (
          <button
            type="button"
            className={css.defaultExclusionToggle}
            onClick={onToggleDefaultExclusion}
            title="Hide this person's photos across the whole app by default (feedback #95)"
          >
            {isDefaultExcluded
              ? "Hidden by default — click to unhide"
              : "Hide by default"}
          </button>
        )}
      </div>
      {(cluster.centroids.length > 0 ||
        (!READ_ONLY && cluster.mergeSuggestions.length > 0)) && (
        <div className={css.personDetailSections}>
          {cluster.centroids.length > 0 && (
            <section className={css.detailSection}>
              <div className={css.detailSectionHeader}>
                <h3>Match Groups</h3>
              </div>
                <div className={css.relatedPeopleList}>
                  {cluster.centroids.map((centroid) => (
                  <article
                    key={centroid.id}
                    className={`${css.relatedPersonCard} ${selectedFaceGroup?.id === centroid.id ? css.relatedPersonCardSelected : ""}`}
                  >
                    <div className={css.relatedPersonFaceWrap}>
                      <FaceImage
                        face={centroid.representative}
                        className={css.relatedPersonFaceImage}
                        priority="high"
                      />
                    </div>
                    <div className={css.relatedPersonBody}>
                      <div className={css.relatedPersonTitleRow}>
                        <span>{centroid.count} faces</span>
                      </div>
                      <div className={css.relatedPersonActions}>
                        <button
                          type="button"
                          className={css.relatedPersonActionButton}
                          onClick={() => onViewRelatedGroup(centroid)}
                        >
                          View
                        </button>
                        {!READ_ONLY && centroid.id !== cluster.id && (
                          <button
                            type="button"
                            className={css.relatedPersonMergeButton}
                            onClick={() => onSeparateCentroid(centroid)}
                            disabled={separatingCentroidId === centroid.id}
                            aria-label={`Separate ${centroid.id} from ${cluster.name ?? cluster.id}`}
                          >
                            {separatingCentroidId === centroid.id ? "Separating..." : "Separate"}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {!READ_ONLY && cluster.mergeSuggestions.length > 0 && (
            <section className={css.detailSection}>
              <div className={css.detailSectionHeader}>
                <h3>Suggested matches</h3>
              </div>
                <div className={css.relatedPeopleList}>
                  {cluster.mergeSuggestions.map((suggestion) => (
                  <article
                    key={suggestion.id}
                    className={`${css.relatedPersonCard} ${selectedFaceGroup?.id === suggestion.id ? css.relatedPersonCardSelected : ""}`}
                  >
                    <div className={css.relatedPersonFaceWrap}>
                      <FaceImage
                        face={suggestion.representative}
                        className={css.relatedPersonFaceImage}
                        priority="high"
                      />
                    </div>
                    <div className={css.relatedPersonBody}>
                      <div className={css.relatedPersonHeaderRow}>
                        <div className={css.relatedPersonTitleRow}>
                          {suggestion.name ? <strong>{suggestion.name}</strong> : null}
                          <span>{suggestion.count} faces</span>
                          {suggestion.yearRangeLabel ? <span>{suggestion.yearRangeLabel}</span> : null}
                        </div>
                        <button
                          type="button"
                          className={css.dismissSuggestionButton}
                          onClick={() => onDismissSuggestion(suggestion.id)}
                          aria-label={`Dismiss suggested match ${suggestion.name ?? suggestion.id}`}
                          title="Dismiss suggestion"
                        >
                          ×
                        </button>
                      </div>
                      <div className={css.relatedPersonActions}>
                        <button
                          type="button"
                          className={css.relatedPersonActionButton}
                          onClick={() => onViewRelatedGroup(suggestion)}
                        >
                          View
                        </button>
                        <button
                          type="button"
                          className={css.relatedPersonMergeButton}
                          onClick={() => onMergeSuggestion(suggestion)}
                          disabled={mergingSuggestionId === suggestion.id}
                          aria-label={`Merge ${suggestion.name ?? suggestion.id} into ${cluster.name ?? cluster.id}`}
                        >
                          {mergingSuggestionId === suggestion.id ? "Merging…" : "Merge"}
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
      {reviewing ? (
        <PersonReviewPanel
          personId={cluster.id}
          onClose={() => setReviewing(false)}
          onChanged={onReviewChanged}
        />
      ) : (
      <section className={css.detailSection}>
        <div className={css.detailSectionHeader}>
          <div className={css.selectedFacesHeader}>
            <h3>{selectedFaceGroup ? "Selected Match Group Faces" : "All faces"}</h3>
            {selectedFaceGroup && selectedFaceGroupLabel ? (
              <span className={css.selectedFacesMeta}>{selectedFaceGroupLabel}</span>
            ) : null}
          </div>
          <div className={css.faceGridControls}>
            <label className={css.faceSortLabel}>
              Sort
              <select
                className={css.faceSortSelect}
                value={faceSort}
                aria-label="Sort faces"
                onChange={(e) => setFaceSort(e.target.value as FaceSort)}
              >
                {(Object.keys(FACE_SORT_LABELS) as FaceSort[]).map((value) => (
                  <option key={value} value={value}>
                    {FACE_SORT_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            {selectedFaceGroup ? (
              <button
                type="button"
                className={css.clearFaceFilterButton}
                onClick={onClearSelectedFaceGroup}
              >
                Show all faces
              </button>
            ) : null}
          </div>
        </div>
        {selectedFaceGroupLoading || loadingFaces ? (
          <div className={css.spinnerWrap}>
            <Spinner size="small" />
          </div>
        ) : (
          <>
            <div className={css.faceGrid}>
              {renderedFaces.map((face, index) => (
                <FaceThumb
                  key={`${face.photo.path}-${index}`}
                  face={face}
                  label={face.photo.name}
                  onClick={() => handleFaceClick(face)}
                  onExclude={READ_ONLY ? undefined : () => handleExcludeFace(face)}
                  excluding={excludingFaceId === face.faceId}
                />
              ))}
            </div>
            {hasMoreFaces && (
              <div ref={faceLoadMoreSentinelRef} className={css.faceGridSentinel}>
                <Spinner size="extra-tiny" />
              </div>
            )}
          </>
        )}
      </section>
      )}
    </div>
  );
};
