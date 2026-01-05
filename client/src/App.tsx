import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Caption1,
  Divider,
  Spinner,
  Subtitle2,
  Switch,
  Title2,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Info24Regular, Folder24Regular, Star24Regular, Star24Filled } from "@fluentui/react-icons";
import { fetchFolders, fetchGeotaggedPhotos, fetchPhotos, GeoBounds, GeoPoint, PhotoItem } from "./api";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { FullscreenViewer } from "./components/FullscreenViewer";
import { MapFilter } from "./components/MapFilter";
import { StatusModal } from "./components/StatusModal";

const useStyles = makeStyles({
  app: {
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
  controlsRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
  },
  breadcrumbRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
  },
  folderGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: tokens.spacingHorizontalM,
  },
  folderCard: {
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  ratingFilter: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  mapSection: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalS,
  },
  starButton: {
    cursor: "pointer",
    border: "none",
    background: "none",
    padding: "2px",
    display: "flex",
    alignItems: "center",
    color: tokens.colorBrandForeground1,
    ":hover": {
      transform: "scale(1.1)",
    },
  },
  atLeastButton: {
    minWidth: "32px",
    height: "32px",
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
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  
  // Initialize state from URL
  const [includeSubfolders, setIncludeSubfolders] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("includeSubfolders") === "true";
  });
  const [ratingFilter, setRatingFilter] = useState<number | null>(null);
  const [ratingAtLeast, setRatingAtLeast] = useState(true);
  const [mediaTypeFilter, setMediaTypeFilter] = useState<"all" | "photo" | "video" | "other">("all");
  const [mapBounds, setMapBounds] = useState<GeoBounds | undefined>(undefined);
  const [geoPins, setGeoPins] = useState<GeoPoint[]>([]);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapTotals, setMapTotals] = useState<{ total: number; truncated: boolean }>({ total: 0, truncated: false });
  const [currentPath, setCurrentPath] = useState<string>(() => {
    const path = window.location.pathname.slice(1); // Remove leading slash
    return decodeURIComponent(path);
  });
  const [folders, setFolders] = useState<string[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);

  const ratingFilterValue = useMemo(
    () => (ratingFilter ? { rating: ratingFilter, atLeast: ratingAtLeast } : null),
    [ratingFilter, ratingAtLeast],
  );

  const currentPathWithSlash = useMemo(
    () => (currentPath ? `${currentPath}/` : ""),
    [currentPath],
  );

  const loadPhotos = useCallback(async (signal: AbortSignal) => {
    setInitialLoading(true);
    setError(null);
    try {
      const path = currentPathWithSlash;
      const result = await fetchPhotos({
        page: 1,
        pageSize: PAGE_SIZE,
        includeSubfolders,
        signal,
        path,
        ratingFilter: ratingFilterValue,
        mediaTypeFilter,
        locationBounds: mapBounds,
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
  }, [includeSubfolders, currentPathWithSlash, ratingFilterValue, mediaTypeFilter, mapBounds]);

  // Sync URL with state
  useEffect(() => {
    const params = new URLSearchParams();
    if (includeSubfolders) {
      params.set("includeSubfolders", "true");
    }

    const currentPathname = window.location.pathname.slice(1); // Remove leading slash
    const currentInclude = new URLSearchParams(window.location.search).get("includeSubfolders") === "true";

    // Decode currentPathname to compare with currentPath (which is likely unencoded in state)
    if (decodeURIComponent(currentPathname) !== currentPath || currentInclude !== includeSubfolders) {
      const queryString = params.toString() ? `?${params.toString()}` : "";
      // Encode the path segments
      const encodedPath = currentPath.split('/').map(encodeURIComponent).join('/');
      const newUrl = `/${encodedPath}${queryString}`;
      window.history.pushState(null, "", newUrl);
    }
  }, [currentPath, includeSubfolders]);

  useEffect(() => {
    const controller = new AbortController();
    loadPhotos(controller.signal);
    return () => controller.abort();
  }, [loadPhotos, refreshToken]);

  useEffect(() => {
    const controller = new AbortController();
    const loadMapPoints = async () => {
      setMapLoading(true);
      setMapError(null);
      try {
        const result = await fetchGeotaggedPhotos({
          includeSubfolders,
          path: currentPathWithSlash,
          ratingFilter: ratingFilterValue,
          mediaTypeFilter,
          signal: controller.signal,
        });
        setGeoPins(result.points);
        setMapTotals({ total: result.total, truncated: result.truncated });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return;
        }
        console.error(err);
        setMapError((err as Error).message ?? "Failed to load map data");
      } finally {
        if (!controller.signal.aborted) {
          setMapLoading(false);
        }
      }
    };

    loadMapPoints();

    return () => controller.abort();
  }, [includeSubfolders, currentPathWithSlash, ratingFilterValue, mediaTypeFilter, refreshToken]);

  useEffect(() => {
    const loadFolders = async () => {
      setLoadingFolders(true);
      try {
        const folderList = await fetchFolders(currentPath);
        setFolders(folderList);
      } catch (err) {
        console.error("Failed to load folders:", err);
      } finally {
        setLoadingFolders(false);
      }
    };
    loadFolders();
  }, [currentPath, refreshToken]);

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      setCurrentPath(decodeURIComponent(window.location.pathname.slice(1)));
      setIncludeSubfolders(params.get("includeSubfolders") === "true");
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const handleLoadMore = useCallback(async () => {
    if (!hasMore || loadingMore || initialLoading) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      const nextPage = page + 1;
      const path = currentPathWithSlash;
      const result = await fetchPhotos({
        page: nextPage,
        pageSize: PAGE_SIZE,
        includeSubfolders,
        path,
        ratingFilter: ratingFilterValue,
        mediaTypeFilter,
        locationBounds: mapBounds,
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
  }, [hasMore, loadingMore, initialLoading, page, includeSubfolders, currentPathWithSlash, ratingFilterValue, mediaTypeFilter, mapBounds]);

  const handleFolderClick = useCallback((folderName: string) => {
    const newPath = currentPath ? `${currentPath}/${folderName}` : folderName;
    setCurrentPath(newPath);
  }, [currentPath]);

  const handleBreadcrumbClick = useCallback((index: number) => {
    const pathParts = currentPath.split("/");
    const newPath = pathParts.slice(0, index + 1).join("/");
    setCurrentPath(newPath);
  }, [currentPath]);

  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [];
    return currentPath.split("/");
  }, [currentPath]);

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

  const handleNext = useCallback(() => {
    if (!selected) return;
    const index = photos.findIndex((p) => p.path === selected.path);
    if (index !== -1 && index < photos.length - 1) {
      setSelected(photos[index + 1]);
    }
  }, [selected, photos]);

  const handlePrevious = useCallback(() => {
    if (!selected) return;
    const index = photos.findIndex((p) => p.path === selected.path);
    if (index > 0) {
      setSelected(photos[index - 1]);
    }
  }, [selected, photos]);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div>
          <Title2>Photrix Library</Title2>
          <Caption1>Browse the catalog generated by the server indexer.</Caption1>
        </div>
        <Tooltip content="Server Status" relationship="description">
          <Button
            icon={<Info24Regular />}
            onClick={() => setIsStatusOpen(true)}
            appearance="subtle"
          >
            Status
          </Button>
        </Tooltip>
      </header>

      <StatusModal isOpen={isStatusOpen} onDismiss={() => setIsStatusOpen(false)} />

      <Divider />

      <div className={styles.controlsRow}>
        <Switch
          checked={includeSubfolders}
          onChange={(_, data) => setIncludeSubfolders(data.checked)}
          label="Include subfolders"
        />
        <Divider vertical />
        <div className={styles.ratingFilter}>
          <Caption1>Type:</Caption1>
          <Button
            size="small"
            appearance={mediaTypeFilter === "all" ? "primary" : "subtle"}
            onClick={() => setMediaTypeFilter("all")}
          >
            All
          </Button>
          <Button
            size="small"
            appearance={mediaTypeFilter === "photo" ? "primary" : "subtle"}
            onClick={() => setMediaTypeFilter("photo")}
          >
            Photo
          </Button>
          <Button
            size="small"
            appearance={mediaTypeFilter === "video" ? "primary" : "subtle"}
            onClick={() => setMediaTypeFilter("video")}
          >
            Video
          </Button>
          <Button
            size="small"
            appearance={mediaTypeFilter === "other" ? "primary" : "subtle"}
            onClick={() => setMediaTypeFilter("other")}
          >
            Other
          </Button>
        </div>
        <Divider vertical />
        <div className={styles.ratingFilter}>
          <Caption1>Rating:</Caption1>
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              className={styles.starButton}
              onClick={() => setRatingFilter(ratingFilter === star ? null : star)}
              title={`${star} star${star > 1 ? 's' : ''}`}
            >
              {ratingFilter !== null && star <= ratingFilter ? (
                <Star24Filled />
              ) : (
                <Star24Regular />
              )}
            </button>
          ))}
          {ratingFilter !== null && (
            <Tooltip content={ratingAtLeast ? "At least this rating" : "Exactly this rating"} relationship="label">
              <Button
                size="small"
                appearance={ratingAtLeast ? "primary" : "subtle"}
                onClick={() => setRatingAtLeast(!ratingAtLeast)}
                className={styles.atLeastButton}
              >
                ≥
              </Button>
            </Tooltip>
          )}
          {ratingFilter !== null && (
            <Button
              size="small"
              appearance="subtle"
              onClick={() => {
                setRatingFilter(null);
                setRatingAtLeast(true);
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      <div className={styles.mapSection}>
        <MapFilter
          points={geoPins}
          bounds={mapBounds}
          onBoundsChange={setMapBounds}
          loading={mapLoading}
          error={mapError}
          totalPins={mapTotals.total}
          truncated={mapTotals.truncated}
        />
      </div>

      {currentPath && (
        <div className={styles.breadcrumbRow}>
          <Button appearance="transparent" onClick={() => setCurrentPath("")}>
            Home
          </Button>
          {breadcrumbs.map((part, index) => (
            <span key={index}>
              <span>/</span>
              <Button
                appearance="transparent"
                onClick={() => handleBreadcrumbClick(index)}
              >
                {part}
              </Button>
            </span>
          ))}
        </div>
      )}

      {loadingFolders ? (
        <Spinner size="small" label="Loading folders..." />
      ) : folders.length > 0 ? (
        <div>
          <Subtitle2>Folders</Subtitle2>
          <div className={styles.folderGrid}>
            {folders.map((folder) => (
              <div
                key={folder}
                className={styles.folderCard}
                onClick={() => handleFolderClick(folder)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleFolderClick(folder);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <Folder24Regular />
                <span>{folder}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

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

      <FullscreenViewer
        photo={selected}
        onDismiss={() => setSelected(null)}
        onNext={handleNext}
        onPrevious={handlePrevious}
      />
    </div>
  );
}
