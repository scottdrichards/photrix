import { memo, useEffect, useState } from "react";
import type { ClusterFace, PersonCluster, PersonClusterWithFaces, PeopleClustersResult } from "../api";
import { buildFaceCropUrl, fetchClusterDetail, fetchPeopleClusters } from "../api";
import { Spinner } from "../Spinner";
import { useFilter } from "./filter/FilterContext";
import { useSelectionContext } from "./selection/SelectionContext";
import { ViewToggle } from "./ViewToggle";
import css from "./PeopleView.module.css";

type FaceImageProps = {
  face: ClusterFace;
  className: string;
};

// The server returns a JPEG cropped to the padded face region, so the browser
// only downloads the face and just needs object-fit: cover to fill the square
// viewport — no zoom/pan transform or aspect-ratio compensation required.
const FaceImage = ({ face, className }: FaceImageProps) => (
  <img
    src={buildFaceCropUrl(face)}
    alt={face.photo.name}
    className={className}
    loading="lazy"
  />
);

type FaceThumbProps = {
  face: ClusterFace;
  label: string;
  onClick: () => void;
};

const FaceThumb = ({ face, label, onClick }: FaceThumbProps) => (
  <button
    type="button"
    className={css.faceThumbButton}
    onClick={onClick}
    aria-label={label}
  >
    <div className={css.faceThumbViewport}>
      <FaceImage face={face} className={css.faceThumbImage} />
    </div>
  </button>
);

type PersonDetailProps = {
  cluster: PersonClusterWithFaces;
  onBack: () => void;
};

const PersonDetail = ({ cluster, onBack }: PersonDetailProps) => {
  const { setItems, setSelected } = useSelectionContext();

  useEffect(() => {
    setItems(cluster.faces.map((face) => face.photo));
    return () => setItems([]);
  }, [cluster, setItems]);

  const handleFaceClick = (face: ClusterFace) => {
    setSelected(face.photo);
  };

  return (
    <div className={css.personDetail}>
      <div className={css.personDetailHeader}>
        <button type="button" className={css.backButton} onClick={onBack}>
          ← Back
        </button>
        <span className={css.personDetailCount}>{cluster.count} faces</span>
      </div>
      <div className={css.faceGrid}>
        {cluster.faces.map((face, index) => (
          <FaceThumb
            key={`${face.photo.path}-${index}`}
            face={face}
            label={face.photo.name}
            onClick={() => handleFaceClick(face)}
          />
        ))}
      </div>
    </div>
  );
};

type PeopleViewProps = {
  view: "library" | "people";
  onViewChange: (view: "library" | "people") => void;
};

const PeopleViewComponent = ({ view, onViewChange }: PeopleViewProps) => {
  const { filter } = useFilter();
  const { setItems } = useSelectionContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PeopleClustersResult | null>(null);
  const [personDetail, setPersonDetail] = useState<PersonClusterWithFaces | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Load cluster summaries
  useEffect(() => {
    const abortOnDisposed = "disposed";
    const abortController = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const load = (initial: boolean) => {
      if (initial) {
        setLoading(true);
        setError(null);
      }

      fetchPeopleClusters({
        signal: abortController.signal,
        ...filter,
      })
        .then((result) => {
          setData(result);
          // While the background clustering task is still assigning faces,
          // refresh periodically so newly formed clusters appear on their own.
          if (result.pendingFaces > 0 && !abortController.signal.aborted) {
            refreshTimer = setTimeout(() => load(false), 10_000);
          }
        })
        .catch((err) => {
          if (err === abortOnDisposed || err.name === "AbortError") {
            return;
          }
          setError("Failed to fetch people clusters");
        })
        .finally(() => {
          if (initial) {
            setLoading(false);
          }
        });
    };

    load(true);

    return () => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      abortController.abort(abortOnDisposed);
    };
  }, [filter]);

  const handleClusterClick = (cluster: PersonCluster) => {
    const abortController = new AbortController();
    setDetailLoading(true);

    fetchClusterDetail({
      clusterId: cluster.id,
      signal: abortController.signal,
      ...filter,
    })
      .then((result) => {
        if (result.cluster) {
          setPersonDetail(result.cluster);
        }
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        console.error("Failed to fetch cluster detail:", err);
      })
      .finally(() => {
        setDetailLoading(false);
      });
  };

  const handleBack = () => {
    setPersonDetail(null);
    setItems([]);
  };

  if (personDetail) {
    return (
      <section className={css.peopleView}>
        <ViewToggle view={view} onViewChange={onViewChange} />
        <PersonDetail cluster={personDetail} onBack={handleBack} />
      </section>
    );
  }

  return (
    <section className={css.peopleView}>
      <ViewToggle view={view} onViewChange={onViewChange} />
      <div className={css.summaryRow}>
        <h3>People</h3>
        {data ? (
          <small>
            {data.totalClusters} clusters • {data.totalFaces} faces
            {data.pendingFaces > 0
              ? ` • clustering ${data.pendingFaces.toLocaleString()} more…`
              : ""}
          </small>
        ) : null}
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

      {data && data.clusters.length > 0 ? (
        <div className={css.clusterList}>
          {data.clusters.map((cluster) => (
            <button
              key={cluster.id}
              type="button"
              className={css.clusterButton}
              onClick={() => handleClusterClick(cluster)}
            >
              <div className={css.clusterFaceWrap}>
                <FaceImage
                  face={cluster.representative}
                  className={css.clusterFaceImage}
                />
              </div>
              <span className={css.clusterLabel}>{cluster.count} faces</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
};

export const PeopleView = memo(PeopleViewComponent);
