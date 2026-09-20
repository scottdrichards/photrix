import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { FaceAnomalyFlag, PersonReview, ReviewFace } from "../api";
import {
  applyPersonCutoff,
  buildFaceCropUrl,
  fetchPersonReview,
  setFaceVerdicts,
} from "../api";
import { Spinner } from "../Spinner";
import css from "./PersonReviewPanel.module.css";

/**
 * "Which of these aren't actually this person?" — the repair view for a face
 * cluster.
 *
 * Its one structural idea is the **cut line**. Faces are laid out in order of
 * distance from the person's reference point, so the ones that don't belong
 * collect at the end; the user drops a line somewhere in that tail and
 * everything after it leaves in one action. That is the difference between
 * fixing a contaminated cluster in a click and fixing it in sixty, and it is
 * only honest because the ordering is real: the server measures against the
 * faces the user has *confirmed* where it can, not against a centroid the
 * intruders have already dragged towards themselves.
 *
 * Two smaller ideas hang off it:
 *
 * - **Confirm is a first-class action, not just the absence of reject.** A
 *   confirmed face sharpens the reference for everyone else and is immune to
 *   any later cut, which makes dragging the line safe to experiment with.
 * - **Flags are shown, never acted on.** Date/location/folder anomalies catch
 *   the look-alike that sits comfortably inside the similarity band, but each
 *   has an innocent explanation often enough that the tool's job is to surface
 *   the evidence and let the user look, not to remove anything by itself.
 */

type PersonReviewPanelProps = {
  personId: string;
  onClose: () => void;
  /** Fired after any change that makes the surrounding person view stale. */
  onChanged: () => void;
};

const FLAG_LABEL: Record<FaceAnomalyFlag, string> = {
  "low-similarity": "Looks least like this person",
  date: "Taken outside this person's usual dates",
  location: "Far from anywhere else they appear",
  folder: "Their only appearance in this folder",
};

const FLAG_ICON: Record<FaceAnomalyFlag, string> = {
  "low-similarity": "◌",
  date: "🗓",
  location: "📍",
  folder: "🗂",
};

const formatSimilarity = (value: number | null) =>
  value === null ? "—" : value.toFixed(2);

/**
 * The threshold that puts the cut exactly between face `index - 1` and face
 * `index`: the midpoint, so no face sits on the boundary and the server's
 * strict "below the threshold" test can't round one of them the wrong way.
 */
const thresholdForCutAt = (faces: ReviewFace[], index: number): number | null => {
  if (index <= 0 || index > faces.length) return null;
  const above = faces[index - 1]?.similarity;
  if (above == null) return null;
  const below = index < faces.length ? faces[index]?.similarity : null;
  // Cutting below the last face keeps everyone; a hair under the lowest
  // similarity is the threshold that expresses "this group is already correct".
  return below == null ? above - 0.001 : (above + below) / 2;
};

type SortMode = "distance" | "suspicion";

export const PersonReviewPanel = ({
  personId,
  onClose,
  onChanged,
}: PersonReviewPanelProps) => {
  const [review, setReview] = useState<PersonReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("distance");
  /**
   * Index of the first face *below* the line, or null for no line. Starts at
   * the server's suggestion so the common case is one click: look, then apply.
   */
  const [cutIndex, setCutIndex] = useState<number | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const next = await fetchPersonReview(personId, signal);
        if (signal?.aborted) return;
        setReview(next);
        setCutIndex(next.suggestedCutoff?.keepCount ?? null);
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load review");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [personId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Sorting by suspicion reorders the grid, and a cut line through a list that
  // is no longer ordered by distance would remove an arbitrary set. So the line
  // only exists in distance order; switching away drops it.
  const faces = useMemo(() => {
    if (!review) return [];
    if (sortMode === "distance") return review.faces;
    return [...review.faces].sort((a, b) => b.anomalyScore - a.anomalyScore);
  }, [review, sortMode]);

  const cutThreshold =
    sortMode === "distance" && cutIndex !== null && review
      ? thresholdForCutAt(review.faces, cutIndex)
      : null;

  // What the button will actually do. Confirmed faces are exempt from a cut, so
  // this is not simply "everything after the line" — showing the real number
  // keeps the label honest.
  const doomedCount = useMemo(() => {
    if (!review || cutIndex === null) return 0;
    return review.faces.slice(cutIndex).filter((face) => face.verdict !== "confirmed")
      .length;
  }, [review, cutIndex]);

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const handleVerdict = (face: ReviewFace, verdict: "confirmed" | "rejected") =>
    runAction(() =>
      setFaceVerdicts([face.faceId], face.verdict === verdict ? null : verdict),
    );

  const handleApplyCut = () => {
    if (cutThreshold === null) return;
    return runAction(() =>
      applyPersonCutoff({ clusterId: personId, threshold: cutThreshold }),
    );
  };

  const handleClearRadius = () =>
    runAction(() => applyPersonCutoff({ clusterId: personId, threshold: null }));

  const handleRestore = (face: ReviewFace) =>
    runAction(() => setFaceVerdicts([face.faceId], null));

  if (loading && !review) {
    return (
      <div className={css.panel}>
        <Spinner size="small" />
      </div>
    );
  }

  if (!review) {
    return (
      <div className={css.panel}>
        <p className={css.error}>{error ?? "No review available"}</p>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className={css.panel}>
      <header className={css.header}>
        <div>
          <h3 className={css.title}>Review {review.name ?? "this group"}</h3>
          <p className={css.subtitle}>
            {review.anchored
              ? `Distances measured from ${review.anchorCount} confirmed face${
                  review.anchorCount === 1 ? "" : "s"
                }.`
              : "Distances measured from the group average — confirm a few good faces to sharpen it."}
            {review.radius !== null
              ? ` Faces below ${review.radius.toFixed(2)} are kept out.`
              : ""}
          </p>
        </div>
        <button type="button" className={css.closeButton} onClick={onClose}>
          Done
        </button>
      </header>

      {error && <p className={css.error}>{error}</p>}

      <div className={css.toolbar}>
        <div className={css.sortToggle} role="group" aria-label="Order faces by">
          <button
            type="button"
            className={sortMode === "distance" ? css.sortActive : css.sortButton}
            onClick={() => setSortMode("distance")}
          >
            By distance
          </button>
          <button
            type="button"
            className={sortMode === "suspicion" ? css.sortActive : css.sortButton}
            onClick={() => setSortMode("suspicion")}
          >
            Most suspicious
          </button>
        </div>

        <div className={css.cutControls}>
          {sortMode === "distance" ? (
            <>
              <span className={css.cutSummary}>
                {cutIndex === null
                  ? "No cut line — click “cut here” on a face"
                  : `Cut below ${cutIndex} face${cutIndex === 1 ? "" : "s"}`}
              </span>
              <button
                type="button"
                className={css.applyButton}
                disabled={busy || cutThreshold === null || doomedCount === 0}
                onClick={handleApplyCut}
              >
                {busy
                  ? "Working…"
                  : `Remove ${doomedCount} face${doomedCount === 1 ? "" : "s"}`}
              </button>
            </>
          ) : (
            <span className={css.cutSummary}>
              Cut lines only make sense in distance order.
            </span>
          )}
          {review.radius !== null && (
            <button
              type="button"
              className={css.secondaryButton}
              disabled={busy}
              onClick={handleClearRadius}
            >
              Clear limit
            </button>
          )}
        </div>
      </div>

      <div className={css.grid}>
        {faces.map((face, index) => {
          const belowCut =
            sortMode === "distance" && cutIndex !== null && index >= cutIndex;
          const showLineBefore = sortMode === "distance" && cutIndex === index;
          return (
            // Fragment rather than a wrapper element: the cut line and the card
            // are both direct children of the grid, and the line spans its full
            // width. A wrapper would make each pair its own grid cell.
            <Fragment key={face.faceId}>
              {showLineBefore && (
                <div className={css.cutLine} role="separator">
                  <span>everything below is not {review.name ?? "this person"}</span>
                </div>
              )}
              <figure
                className={[
                  css.card,
                  belowCut ? css.cardBelow : "",
                  face.verdict === "confirmed" ? css.cardConfirmed : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <img
                  src={buildFaceCropUrl(face)}
                  alt={face.photo.name}
                  className={css.image}
                  loading="lazy"
                />
                <figcaption className={css.caption}>
                  <span className={css.similarity}>
                    {formatSimilarity(face.similarity)}
                  </span>
                  <span className={css.flags}>
                    {face.flags.map((flag, flagIndex) => (
                      <span
                        key={flag}
                        className={css.flag}
                        title={`${FLAG_LABEL[flag]} — ${face.reasons[flagIndex] ?? ""}`}
                        aria-label={FLAG_LABEL[flag]}
                      >
                        {FLAG_ICON[flag]}
                      </span>
                    ))}
                  </span>
                </figcaption>
                <div className={css.actions}>
                  <button
                    type="button"
                    className={
                      face.verdict === "confirmed" ? css.confirmActive : css.confirm
                    }
                    disabled={busy}
                    title="Yes, this is them — pins the face and sharpens the reference"
                    aria-label="Confirm this face"
                    onClick={() => handleVerdict(face, "confirmed")}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    className={css.reject}
                    disabled={busy}
                    title="Not them — remove from this group"
                    aria-label="Reject this face"
                    onClick={() => handleVerdict(face, "rejected")}
                  >
                    ✕
                  </button>
                  {sortMode === "distance" && (
                    <button
                      type="button"
                      className={css.cutHere}
                      title="This face, and every face after it, is not this person"
                      aria-label="Set the cut line here"
                      onClick={() => setCutIndex(index)}
                    >
                      cut here
                    </button>
                  )}
                </div>
              </figure>
            </Fragment>
          );
        })}
      </div>

      {review.rejected.length > 0 && (
        <section className={css.rejectedSection}>
          <h4 className={css.rejectedTitle}>
            Removed from this group ({review.rejected.length})
          </h4>
          <div className={css.grid}>
            {review.rejected.map((face) => (
              <figure key={face.faceId} className={`${css.card} ${css.cardRejected}`}>
                <img
                  src={buildFaceCropUrl(face)}
                  alt={face.photo.name}
                  className={css.image}
                  loading="lazy"
                />
                <div className={css.actions}>
                  <button
                    type="button"
                    className={css.secondaryButton}
                    disabled={busy}
                    title="Put this face back and let clustering decide again"
                    onClick={() => handleRestore(face)}
                  >
                    Undo
                  </button>
                </div>
              </figure>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
