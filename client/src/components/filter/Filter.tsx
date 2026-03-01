import {
  Button,
  Caption1,
  Divider,
  Switch,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Star24Regular, Star24Filled } from "@fluentui/react-icons";
import { useFilterContext, MediaTypeFilter } from "./FilterContext";
import { DateHistogram } from "../DateHistogram";
import { MapFilter } from "../MapFilter";
import { Folder24Regular } from "@fluentui/react-icons";
import { Spinner, Subtitle2 } from "@fluentui/react-components";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchFolders } from "../../api";

const useStyles = makeStyles({
  controlsRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
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

export const Filter = () => {
  const styles = useStyles();
  const { filter, setFilter } = useFilterContext();
  const { includeSubfolders, ratingFilter, mediaTypeFilter, locationBounds, dateRange, path } = filter;

  const ratingValue = ratingFilter?.rating ?? null;
  const ratingAtLeast = ratingFilter?.atLeast ?? true;

  const [folders, setFolders] = useState<string[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);

  const currentPath = path?.replace(/\/$/, "");

  const handleRatingClick = (star: number) => {
    if (ratingValue === star) {
      setFilter({ ratingFilter: null });
    } else {
      setFilter({ ratingFilter: { rating: star, atLeast: ratingAtLeast } });
    }
  };

  const handleAtLeastToggle = () => {
    if (ratingFilter) {
      setFilter({ ratingFilter: { ...ratingFilter, atLeast: !ratingFilter.atLeast } });
    }
  };

  const handleClearRating = () => {
    setFilter({ ratingFilter: null });
  };

  const handleMediaTypeChange = (type: MediaTypeFilter) => {
    setFilter({ mediaTypeFilter: type });
  };

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
    }, [currentPath]);

    const breadcrumbs = useMemo(() => {
      if (!currentPath) return [];
      return currentPath.split("/");
    }, [currentPath]);

    const handleFolderClick = useCallback((folderName: string) => {
      const newPath = currentPath ? `${currentPath}/${folderName}` : folderName;
      setFilter({ path: `${newPath}/` });
    }, [currentPath, setFilter]);

    const handleBreadcrumbClick = useCallback((index: number) => {
      const pathParts = currentPath?.split("/");
      const newPath = pathParts?.slice(0, index + 1).join("/");
      setFilter({ path: newPath ? `${newPath}/` : "" });
    }, [currentPath, setFilter]);

  return (
    <>
      <div className={styles.controlsRow}>
        <Switch
          checked={includeSubfolders}
          onChange={(_, data) => setFilter({ includeSubfolders: data.checked })}
          label="Include subfolders"
        />
        <Divider vertical />
        <div className={styles.ratingFilter}>
          <Caption1>Type:</Caption1>
          <Button
            size="small"
            appearance={mediaTypeFilter === "all" ? "primary" : "subtle"}
            onClick={() => handleMediaTypeChange("all")}
          >
            All
          </Button>
          <Button
            size="small"
            appearance={mediaTypeFilter === "photo" ? "primary" : "subtle"}
            onClick={() => handleMediaTypeChange("photo")}
          >
            Photo
          </Button>
          <Button
            size="small"
            appearance={mediaTypeFilter === "video" ? "primary" : "subtle"}
            onClick={() => handleMediaTypeChange("video")}
          >
            Video
          </Button>
          <Button
            size="small"
            appearance={mediaTypeFilter === "other" ? "primary" : "subtle"}
            onClick={() => handleMediaTypeChange("other")}
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
              onClick={() => handleRatingClick(star)}
              title={`${star} star${star > 1 ? "s" : ""}`}
            >
              {ratingValue !== null && star <= ratingValue ? (
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
                onClick={handleAtLeastToggle}
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
              onClick={handleClearRating}
            >
              Clear
            </Button>
          )}
        </div>

        <Divider vertical />

        <DateHistogram label="Date taken" />
      </div>

      <div className={styles.mapSection}>
        <MapFilter />
      </div>

      {currentPath && (
        <div className={styles.breadcrumbRow}>
          <Button appearance="transparent" onClick={() => setFilter({ path: "" })}>
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
    </>
  );
};