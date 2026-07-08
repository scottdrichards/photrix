import { useEffect, useState } from "react";
import type { PersonCluster } from "../../api";
import { buildFaceCropUrl, fetchPeopleClusters } from "../../api";
import { Spinner } from "../../Spinner";
import { useFilter } from "./FilterContext";
import css from "./FaceFilterPanel.module.css";

type FaceFilterPanelProps = {
  isActive: boolean;
};

/**
 * Lets the user filter the library by a face, picking from the same clustered
 * faces the People tab shows. Selecting one or more clusters constrains results
 * to files containing a face assigned to any selected cluster.
 */
export const FaceFilterPanel = ({ isActive }: FaceFilterPanelProps) => {
  const { filter, setFilter } = useFilter();
  const selected = filter.faceClusterFilter ?? [];
  const [clusters, setClusters] = useState<PersonCluster[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      .then((result) => setClusters(result.clusters))
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
        {selected.length > 0 ? (
          <button
            type="button"
            className="btn btn-sm btn-subtle"
            onClick={() => setFilter({ faceClusterFilter: null })}
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
    </div>
  );
};
