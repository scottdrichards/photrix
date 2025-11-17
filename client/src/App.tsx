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
import { ArrowClockwise24Regular, Folder24Regular } from "@fluentui/react-icons";
import { fetchFolders, fetchPhotos, PhotoItem } from "./api";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { FullscreenViewer } from "./components/FullscreenViewer";

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
  
  // Initialize state from URL
  const [includeSubfolders, setIncludeSubfolders] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("includeSubfolders") === "true";
  });
  const [currentPath, setCurrentPath] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("path") || "";
  });
  const [folders, setFolders] = useState<string[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);

  const loadInitial = useCallback(async (signal: AbortSignal) => {
    setInitialLoading(true);
    setError(null);
    try {
      const path = currentPath ? `${currentPath}/` : "";
      const result = await fetchPhotos({ page: 1, pageSize: PAGE_SIZE, includeSubfolders, signal, path });
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
  }, [includeSubfolders, currentPath]);

  // Sync URL with state
  useEffect(() => {
    const params = new URLSearchParams();
    if (currentPath) {
      params.set("path", currentPath);
    }
    if (includeSubfolders) {
      params.set("includeSubfolders", "true");
    }
    const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname;
    window.history.replaceState(null, "", newUrl);
  }, [currentPath, includeSubfolders]);

  useEffect(() => {
    const controller = new AbortController();
    loadInitial(controller.signal);
    return () => controller.abort();
  }, [loadInitial, refreshToken]);

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
      setCurrentPath(params.get("path") || "");
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
      const path = currentPath ? `${currentPath}/` : "";
      const result = await fetchPhotos({ page: nextPage, pageSize: PAGE_SIZE, includeSubfolders, path });
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
  }, [hasMore, loadingMore, initialLoading, page, includeSubfolders, currentPath]);

  const handleRefresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

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

      <div className={styles.controlsRow}>
        <Switch
          checked={includeSubfolders}
          onChange={(_, data) => setIncludeSubfolders(data.checked)}
          label="Include subfolders"
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

      <FullscreenViewer photo={selected} onDismiss={() => setSelected(null)} />
    </div>
  );
}
