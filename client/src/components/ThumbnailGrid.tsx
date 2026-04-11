import { Spinner, Subtitle2, makeStyles, tokens } from "@fluentui/react-components";
import { memo, useEffect, useRef, useState } from "react";
import type { PhotoItem } from "../api";
import { fetchPhotos } from "../api";
import { useFilterContext } from "./filter/FilterContext";
import { useSelectionContext } from "./selection/SelectionContext";
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
    setData(null);
  }, [filter]);

  useEffect(() => {
    const abortOnDisposed = "disposed";
    const abortController = new AbortController();

    setLoading(true);
    fetchPhotos({
      page,
      pageSize: PAGE_SIZE,
      signal: abortController.signal,
      ...filter,
    })
      .then((result) => {
        setData((previousData) => {
          if (page === 1 || !previousData) {
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
        setError("Failed to fetch photos");
        console.error("Failed to fetch photos:", err);
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
    if (!sentinel || loading) {
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
  }, [loading, data?.items.length, data?.total]);

  return (
    <>
      {error ? <Subtitle2>{error}</Subtitle2> : null}
      <div className={styles.grid}>
        {data?.items.map((item) => (
          <ThumbnailTile key={item.path} photo={item} />
        ))}
        {data && data.items.length < data.total && (
          <div ref={loadMoreSentinelRef} className={styles.sentinel}>
            {loading && <Spinner size="extra-tiny" />}
          </div>
        )}
      </div>
      {data && data.items.length === 0 && (
        <Subtitle2>No photos yet. Upload some to get started.</Subtitle2>
      )}
    </>
  );
};

export const ThumbnailGrid = memo(ThumbnailGridComponent);
