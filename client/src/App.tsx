import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Caption1,
  Divider,
  Spinner,
  Subtitle2,
  Title2,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowClockwise24Regular } from "@fluentui/react-icons";
import { fetchPhotos, PhotoItem } from "./api";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { FullscreenViewer } from "./components/FullscreenViewer";
import { FilterPanel } from "./components/filters/FilterPanel";
import type { FilterState } from "./types/filters";

const useStyles = makeStyles({
  app: {
    maxWidth: "1200px",
    margin: "0 auto",
    padding: tokens.spacingHorizontalXL,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalXL,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground2,
  },
});

export default function App() {
  const PAGE_SIZE = 200;
  const styles = useStyles();
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PhotoItem | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [filters, setFilters] = useState<FilterState>({});

  const loadInitial = useCallback(async (signal: AbortSignal) => {
    setInitialLoading(true);
    setError(null);
    try {
      const apiFilter = {
        directory: filters.directories,
        cameraMake: filters.cameraMake,
        cameraModel: filters.cameraModel,
        location: filters.location,
        dateRange: filters.dateRange,
        rating: filters.minRating !== undefined ? { min: filters.minRating } : undefined,
        tags: filters.tags,
      };
      const result = await fetchPhotos({ 
        page: 1, 
        pageSize: PAGE_SIZE, 
        filter: apiFilter,
        signal 
      });
      if (signal.aborted) {
        return;
      }
      setPhotos(result.items);
      setTotal(result.total);
      setPage(result.page);
      setHasMore(result.items.length > 0 && result.items.length < result.total);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return;
      }
      console.error(err);
      setError((err as Error).message ?? "Failed to load photos");
    } finally {
      if (!signal.aborted) {
        setInitialLoading(false);
      }
    }
  }, [filters]);

  useEffect(() => {
    const controller = new AbortController();
    loadInitial(controller.signal);
    return () => controller.abort();
  }, [loadInitial, refreshToken]);

  const handleLoadMore = useCallback(async () => {
    if (!hasMore || loadingMore || initialLoading) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      const nextPage = page + 1;
      const apiFilter = {
        directory: filters.directories,
        cameraMake: filters.cameraMake,
        cameraModel: filters.cameraModel,
        location: filters.location,
        dateRange: filters.dateRange,
        rating: filters.minRating !== undefined ? { min: filters.minRating } : undefined,
        tags: filters.tags,
      };
      const result = await fetchPhotos({ 
        page: nextPage, 
        pageSize: PAGE_SIZE,
        filter: apiFilter,
      });
      setPhotos((current) => {
        const next = [...current, ...result.items];
        const hasNext = result.items.length > 0 && next.length < result.total;
        setHasMore(hasNext);
        return next;
      });
      setPage(result.page);
      setTotal(result.total);
    } catch (err) {
      console.error(err);
      setError((err as Error).message ?? "Failed to load more photos");
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, initialLoading, page, filters]);

  const handleRefresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

  const handleFilterChange = useCallback((newFilters: FilterState) => {
    setFilters(newFilters);
    setRefreshToken((value) => value + 1);
  }, []);

  const handleClearFilters = useCallback(() => {
    setFilters({});
    setRefreshToken((value) => value + 1);
  }, []);

  const statusMessage = useMemo(() => {
    if (initialLoading) {
      return "Loading media...";
    }
    if (error) {
      return error;
    }
    const label = total === 1 ? "item" : "items";
    return `${total} ${label}`;
  }, [initialLoading, error, total]);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div>
          <Title2>Photrix Library</Title2>
          <Caption1>Browse the catalog generated by the server indexer.</Caption1>
        </div>
        <Tooltip content="Refresh" relationship="description">
          <Button
            icon={<ArrowClockwise24Regular />}
            onClick={handleRefresh}
            appearance="secondary"
          >
            Refresh
          </Button>
        </Tooltip>
      </header>

      <Divider />

      <FilterPanel 
        filters={filters} 
        onChange={handleFilterChange}
        onClear={handleClearFilters}
      />

      <Divider />

      <div className={styles.statusRow}>
  {initialLoading ? <Spinner size="extra-tiny" /> : <Subtitle2>📸🎬</Subtitle2>}
        <Subtitle2>{statusMessage}</Subtitle2>
      </div>

      <ThumbnailGrid
        items={photos}
        onSelect={setSelected}
        onLoadMore={handleLoadMore}
        hasMore={hasMore}
        loadingMore={loadingMore}
      />

      <FullscreenViewer photo={selected} onDismiss={() => setSelected(null)} />
    </div>
  );
}
