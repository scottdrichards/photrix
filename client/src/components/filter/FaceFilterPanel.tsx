import { useEffect, useState } from "react";
import {
  FACE_ATTRIBUTE_KEYS,
  type FaceAttributeKey,
} from "../../../../shared/filter-contract/src";
import type { PersonCluster } from "../../api";
import { buildFaceCropUrl, fetchPeopleClusters, fetchStatus } from "../../api";
import { Spinner } from "../../Spinner";
import { useFilter } from "./FilterContext";
import css from "./FaceFilterPanel.module.css";

type FaceFilterPanelProps = {
  isActive: boolean;
};

// Must match the `name` the server registers the backfill task under in
// server/src/main.ts. There is no shared constant for this today (the same
// string-matching pattern is used server-side in statusRequestHandler.ts to
// spot the EXIF task), so keep the two in sync by hand if either changes.
const FACE_ATTRIBUTES_TASK_NAME = "Face attributes (photo ready)";

const ATTRIBUTE_LABELS: Record<FaceAttributeKey, string> = {
  smiling: "Smiling",
  eyesOpen: "Eyes open",
  inFocus: "In focus",
  wellExposed: "Well exposed",
};

const ATTRIBUTE_HINTS: Record<FaceAttributeKey, string> = {
  smiling: "Mouth corners raised and widened",
  eyesOpen: "Neither eye caught mid-blink",
  inFocus: "Sharp for the size the face appears at",
  wellExposed: "Not lost to shadow or blown-out highlights",
};

/**
 * Lets the user filter the library by a face, picking from the same clustered
 * faces the People tab shows, and optionally by how that face looks.
 *
 * The two halves compose into one constraint: picking Ana plus "Smiling"
 * matches photos where *Ana's own face* is smiling, not photos of Ana that
 * merely also contain somebody smiling.
 */
export const FaceFilterPanel = ({ isActive }: FaceFilterPanelProps) => {
  const { filter, setFilter } = useFilter();
  const selected = filter.faceClusterFilter ?? [];
  const attributeFilter = filter.faceAttributeFilter ?? null;
  const activeAttributes = attributeFilter?.attributes ?? [];
  // Absent means the default: unscored faces still match.
  const includeUnknown = attributeFilter?.includeUnknown !== false;
  const allAttributesActive = FACE_ATTRIBUTE_KEYS.every((key) =>
    activeAttributes.includes(key),
  );
  const [clusters, setClusters] = useState<PersonCluster[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How many faces the "photo ready" backfill still has left to score, or
  // `null` once we know there is no backlog (or haven't checked yet). The
  // backfill task only appears in /api/status while it actually has unscored
  // faces to work through — see registerBackgroundTasks.ts's reentrant
  // wrapper — so its absence from the list *is* the "nothing left to do"
  // signal, not just a missing value.
  const [pendingFaceAttributes, setPendingFaceAttributes] = useState<number | null>(
    null,
  );

  const applyAttributes = (
    attributes: readonly FaceAttributeKey[],
    nextIncludeUnknown = includeUnknown,
  ) => {
    setFilter({
      faceAttributeFilter:
        attributes.length > 0
          ? {
              attributes: [...attributes],
              // Only carry the flag when it is not the default, so the filter
              // state stays minimal and comparable.
              ...(nextIncludeUnknown ? {} : { includeUnknown: false }),
            }
          : null,
    });
  };

  const toggleAttribute = (key: FaceAttributeKey) => {
    applyAttributes(
      activeAttributes.includes(key)
        ? activeAttributes.filter((active) => active !== key)
        : FACE_ATTRIBUTE_KEYS.filter(
            (candidate) => candidate === key || activeAttributes.includes(candidate),
          ),
    );
  };

  const togglePhotoReady = () => {
    applyAttributes(allAttributesActive ? [] : FACE_ATTRIBUTE_KEYS);
  };

  const hasAnyFilter = selected.length > 0 || activeAttributes.length > 0;

  const getClusterLabel = (cluster: PersonCluster) => cluster.name ?? `${cluster.count} faces`;

  // Scope the pick list to everything in the current filter — including any
  // already-selected faces. With AND semantics that narrows the choices to
  // faces that co-occur with the current selection (people photographed
  // together), so each pick refines toward the intended set.
  const queryKey = JSON.stringify(filter);

  useEffect(() => {
    if (!isActive) return;
    const abortController = new AbortController();
    setLoading(true);
    setError(null);

    fetchPeopleClusters({ signal: abortController.signal, ...filter })
      .then((result) => {
        const sorted = [...result.clusters].sort(
          (a, b) => (b.name != null ? 1 : 0) - (a.name != null ? 1 : 0) || b.count - a.count,
        );
        setClusters(sorted);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setError("Failed to load faces");
      })
      .finally(() => {
        if (!abortController.signal.aborted) setLoading(false);
      });

    return () => abortController.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, queryKey]);

  // Only relevant once the "hide unscored" control is actually on screen (an
  // attribute filter is active). Checked once when it appears rather than
  // polled, since this is a one-line disclaimer, not a live progress bar —
  // the Server Status panel already covers live progress.
  const showUnknownControl = activeAttributes.length > 0;
  useEffect(() => {
    if (!isActive || !showUnknownControl) return;
    let cancelled = false;

    fetchStatus()
      .then((status) => {
        if (cancelled) return;
        const task = status.backgroundTasks.find(
          (candidate) => candidate.name === FACE_ATTRIBUTES_TASK_NAME,
        );
        const remaining =
          task?.total != null && task?.itemsProcessed != null
            ? Math.max(0, task.total - task.itemsProcessed)
            : null;
        setPendingFaceAttributes(remaining && remaining > 0 ? remaining : null);
      })
      .catch(() => {
        if (!cancelled) setPendingFaceAttributes(null);
      });

    return () => {
      cancelled = true;
    };
  }, [isActive, showUnknownControl]);

  const toggleCluster = (clusterId: string) => {
    const next = selected.includes(clusterId)
      ? selected.filter((id) => id !== clusterId)
      : [...selected, clusterId];
    setFilter({ faceClusterFilter: next.length > 0 ? next : null });
  };

  return (
    <div className={css.panelSection}>
      <div className={css.header}>
        <h3>People face</h3>
        {hasAnyFilter ? (
          <button
            type="button"
            className="btn btn-sm btn-subtle"
            onClick={() =>
              setFilter({ faceClusterFilter: null, faceAttributeFilter: null })
            }
          >
            Clear
          </button>
        ) : null}
      </div>

      {loading ? <Spinner size="small" label="Loading faces..." /> : null}
      {error ? <small>{error}</small> : null}

      {!loading && !error && clusters.length === 0 ? (
        <small>No clustered faces for the current filter.</small>
      ) : null}

      {clusters.length > 0 ? (
        <div className={css.faceGrid}>
          {clusters.map((cluster) => {
            const isSelected = selected.includes(cluster.id);
            const label = getClusterLabel(cluster);
            const description = cluster.name ? `${cluster.name}, ${cluster.count} faces` : label;
            return (
              <button
                key={cluster.id}
                type="button"
                className={`${css.faceButton} ${isSelected ? css.faceButtonSelected : ""}`}
                onClick={() => toggleCluster(cluster.id)}
                aria-pressed={isSelected}
                aria-label={description}
                title={description}
              >
                <div className={css.faceWrap}>
                  <img
                    src={buildFaceCropUrl(cluster.representative)}
                    alt=""
                    className={css.faceImage}
                    loading="lazy"
                  />
                </div>
                <span className={css.faceLabel}>{label}</span>
                {cluster.name ? <span className={css.faceMeta}>{cluster.count} faces</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className={css.attributeSection}>
        <div className={css.attributeHeader}>
          <span className={css.attributeTitle}>
            {selected.length > 0 ? "Only when they are" : "Only faces that are"}
          </span>
          <button
            type="button"
            className={`${css.chip} ${css.photoReadyChip} ${
              allAttributesActive ? css.chipSelected : ""
            }`}
            onClick={togglePhotoReady}
            aria-pressed={allAttributesActive}
            title="Smiling, eyes open, in focus and well exposed"
          >
            Photo ready
          </button>
        </div>

        <div className={css.chipRow}>
          {FACE_ATTRIBUTE_KEYS.map((key) => {
            const isSelected = activeAttributes.includes(key);
            return (
              <button
                key={key}
                type="button"
                className={`${css.chip} ${isSelected ? css.chipSelected : ""}`}
                onClick={() => toggleAttribute(key)}
                aria-pressed={isSelected}
                title={ATTRIBUTE_HINTS[key]}
              >
                {ATTRIBUTE_LABELS[key]}
              </button>
            );
          })}
        </div>

        {activeAttributes.length > 0 ? (
          <label className={css.unknownRow}>
            <input
              type="checkbox"
              checked={!includeUnknown}
              onChange={(event) =>
                applyAttributes(activeAttributes, !event.target.checked)
              }
            />
            <span>
              Hide faces not yet analysed
              {pendingFaceAttributes ? (
                <small className={css.note}>
                  {pendingFaceAttributes.toLocaleString()} older face
                  {pendingFaceAttributes === 1 ? "" : "s"} still need scoring in the
                  background (see Status for progress). Until scored, a face counts as
                  a match — unknown is not the same as no.
                </small>
              ) : (
                <small className={css.note}>
                  Unknown is not the same as no, so an unscored face still counts as a
                  match by default.
                </small>
              )}
            </span>
          </label>
        ) : null}
      </div>
    </div>
  );
};
