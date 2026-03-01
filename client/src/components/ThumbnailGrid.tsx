import { Spinner, Subtitle2, makeStyles, tokens } from "@fluentui/react-components";
import { memo, useEffect, useRef, useState } from "react";
import type { PhotoItem } from "../api";
import { fetchPhotos } from "../api";
import { useFilterContext } from "./filter/FilterContext";
import { ThumbnailTile } from "./ThumbnailTile";

export const useStyles = makeStyles({
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
    marginBlockEnd: tokens.spacingHorizontalS,
  },
  grid: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "stretch",
    gap: tokens.spacingHorizontalM,
    paddingBlockEnd: tokens.spacingHorizontalXXL,
    "--thumbnail-size": "clamp(150px, 20vw, 260px)",
  },
  sentinel: {
    flexBasis: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: tokens.spacingHorizontalL,
    color: tokens.colorNeutralForeground3,
  },
});

const PAGE_SIZE = 200;

const ThumbnailGridComponent = () => {
  const styles = useStyles();
  const { filter } = useFilterContext();
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{items: PhotoItem[]; total: number, filterUsed: typeof filter}|null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading]= useState(false);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  
  useEffect(() => {
    const abortOnDisposed = 'disposed';
    const filterChanged = filter !== data?.filterUsed;
    const abortController = new AbortController();
    if (filterChanged) {
      setPage(0);
      setData(null);
    }
    setLoading(true);
    fetchPhotos({ page:filterChanged?0:page, pageSize: PAGE_SIZE, signal: abortController.signal, ...filter }).then((result) => {
      setData({ ...result, filterUsed: filter });
    }).catch((err) => {
      if (err === 'disposed') return;
      if (err.name === "AbortError") return;
      setError("Failed to fetch photos");
      console.error("Failed to fetch photos:", err);
    }).finally(() => {
      setLoading(false);
    });
    return () => {
      abortController.abort(abortOnDisposed);
    };
  }, [filter, page]);

  useEffect(() => {
    if (!loadMoreSentinelRef.current || loading){
      return;
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setPage((prev) => prev + 1);
      }
    }, {
      rootMargin: "200px",
    });
    observer.observe(loadMoreSentinelRef.current);
    return () => {
      observer.disconnect();
    };
  }, [loading, loadMoreSentinelRef.current]);

  return (
    <>
      {error ? <Subtitle2>{error}</Subtitle2> : null}
      <div className={styles.grid}>
        {data?.items.map((item) => (
          <ThumbnailTile key={item.path} photo={item}/>
        ))}
        {(data && data.items.length < data.total) && (
          <div ref={loadMoreSentinelRef} className={styles.sentinel}>
            {loading && <Spinner size="extra-tiny" />}
          </div>
        )}
      </div>
      {data && data.items.length === 0 && <Subtitle2>No photos yet. Upload some to get started.</Subtitle2>}
    </>
  );
};

export const ThumbnailGrid = memo(ThumbnailGridComponent);

