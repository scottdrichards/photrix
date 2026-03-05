import {
  Button,
  Caption1,
  Input,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Spinner,
  Subtitle2,
  Switch,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  Calendar24Regular,
  Folder24Regular,
  Image24Regular,
  Location24Regular,
  Person24Regular,
  Star24Filled,
  Star24Regular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchFolders, fetchSuggestions } from "../../api";
import { DateHistogram } from "../DateHistogram";
import { MapFilter } from "../MapFilter";
import { MediaTypeFilter, useFilterContext } from "./FilterContext";

type FilterPanel = "folders" | "type" | "people" | "rating" | "date" | "map";

const useStyles = makeStyles({
  iconBar: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
  },
  filterIconButton: {
    minWidth: "36px",
    width: "36px",
    height: "36px",
    padding: 0,
  },
  panelSurface: {
    width: "min(92vw, 440px)",
    maxHeight: "70vh",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalM,
  },
  mapPanelSurface: {
    width: "min(92vw, 620px)",
    maxHeight: "80vh",
    overflowY: "auto",
  },
  panelSection: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalS,
  },
  controlsRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  textFilterInput: {
    width: "100%",
  },
  suggestionsList: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalXS,
  },
  suggestionButton: {
    justifyContent: "flex-start",
  },
  selectedPeopleRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
  },
  selectedPersonButton: {
    paddingInline: tokens.spacingHorizontalS,
  },
  ratingFilter: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
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
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: tokens.spacingHorizontalS,
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
  const {
    includeSubfolders,
    ratingFilter,
    mediaTypeFilter,
    path,
    peopleInImageFilter = [],
    locationBounds,
    dateRange,
  } = filter;

  const selectedPeople = useMemo(() => {
    return peopleInImageFilter;
  }, [peopleInImageFilter]);

  const ratingValue = ratingFilter?.rating ?? null;
  const ratingAtLeast = ratingFilter?.atLeast ?? true;

  const [activePanel, setActivePanel] = useState<FilterPanel | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [peopleSuggestions, setPeopleSuggestions] = useState<string[]>([]);
  const [loadingPeopleSuggestions, setLoadingPeopleSuggestions] = useState(false);
  const [peopleSearchText, setPeopleSearchText] = useState("");

  const currentPath = path?.replace(/\/$/, "");
  const isFolderFilterActive = Boolean(currentPath) || includeSubfolders === false;
  const isMediaTypeFilterActive = Boolean(mediaTypeFilter && mediaTypeFilter !== "all");
  const isPeopleFilterActive = selectedPeople.length > 0;
  const isRatingFilterActive = ratingFilter !== null && ratingFilter !== undefined;
  const isDateFilterActive = dateRange !== null && dateRange !== undefined;
  const isMapFilterActive = locationBounds !== undefined;

  const handleRatingClick = (star: number) => {
    if (ratingValue === star) {
      setFilter({ ratingFilter: null });
      return;
    }

    setFilter({ ratingFilter: { rating: star, atLeast: ratingAtLeast } });
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

  const handleAddPerson = (value: string) => {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      return;
    }

    setFilter((previous) => {
      const existing = previous.peopleInImageFilter ?? [];

      const hasDuplicate = existing.some(
        (person) => person.toLocaleLowerCase() === normalizedValue.toLocaleLowerCase(),
      );
      return hasDuplicate
        ? previous
        : { ...previous, peopleInImageFilter: [...existing, normalizedValue] };
    });

    setPeopleSearchText("");
  };

  const handleRemovePerson = (value: string) => {
    setFilter((previous) => {
      const existing = previous.peopleInImageFilter ?? [];

      return {
        ...previous,
        peopleInImageFilter: existing.filter((person) => person !== value),
      };
    });
  };

  const handleClearPeople = () => {
    setPeopleSearchText("");
    setFilter({ peopleInImageFilter: [] });
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

    void loadFolders();
  }, [currentPath]);

  useEffect(() => {
    if (activePanel !== "people") {
      return;
    }

    const searchText = peopleSearchText.trim();
    if (searchText.length === 0) {
      setPeopleSuggestions([]);
      setLoadingPeopleSuggestions(false);
      return;
    }

    const abortController = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setLoadingPeopleSuggestions(true);
      try {
        const result = await fetchSuggestions({
          field: "personInImage",
          q: searchText,
          limit: 8,
          includeSubfolders,
          path,
          ratingFilter,
          mediaTypeFilter,
          locationBounds,
          dateRange,
          peopleInImageFilter: selectedPeople,
          signal: abortController.signal,
        });
        const selectedPeopleLookup = new Set(
          selectedPeople.map((person) => person.toLocaleLowerCase()),
        );
        setPeopleSuggestions(
          result.filter(
            (person) => !selectedPeopleLookup.has(person.toLocaleLowerCase()),
          ),
        );
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          return;
        }
        console.error("Failed to load people suggestions:", error);
        setPeopleSuggestions([]);
      } finally {
        if (!abortController.signal.aborted) {
          setLoadingPeopleSuggestions(false);
        }
      }
    }, 200);

    return () => {
      window.clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [
    activePanel,
    peopleSearchText,
    selectedPeople,
    includeSubfolders,
    path,
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
  ]);

  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [];
    return currentPath.split("/");
  }, [currentPath]);

  const handleFolderClick = useCallback(
    (folderName: string) => {
      const newPath = currentPath ? `${currentPath}/${folderName}` : folderName;
      setFilter({ path: `${newPath}/` });
    },
    [currentPath, setFilter],
  );

  const handleBreadcrumbClick = useCallback(
    (index: number) => {
      const pathParts = currentPath?.split("/");
      const newPath = pathParts?.slice(0, index + 1).join("/");
      setFilter({ path: newPath ? `${newPath}/` : "" });
    },
    [currentPath, setFilter],
  );

  return (
    <div className={styles.iconBar}>
      <Popover
        open={activePanel === "folders"}
        onOpenChange={(_, data) => setActivePanel(data.open ? "folders" : null)}
        positioning="below-start"
      >
        <PopoverTrigger disableButtonEnhancement>
          <Tooltip content="Folders" relationship="label">
            <Button
              aria-label="Folders filter"
              icon={<Folder24Regular />}
              aria-pressed={isFolderFilterActive}
              appearance={activePanel === "folders" || isFolderFilterActive ? "primary" : "subtle"}
              className={styles.filterIconButton}
            />
          </Tooltip>
        </PopoverTrigger>
        <PopoverSurface className={styles.panelSurface}>
          <div className={styles.panelSection}>
            <Subtitle2>Folders</Subtitle2>
            <Switch
              checked={includeSubfolders}
              onChange={(_, data) => setFilter({ includeSubfolders: data.checked })}
              label="Include subfolders"
            />
            {currentPath ? (
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
            ) : null}
            {loadingFolders ? (
              <Spinner size="small" label="Loading folders..." />
            ) : folders.length > 0 ? (
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
            ) : (
              <Caption1>No folders found.</Caption1>
            )}
          </div>
        </PopoverSurface>
      </Popover>

      <Popover
        open={activePanel === "type"}
        onOpenChange={(_, data) => setActivePanel(data.open ? "type" : null)}
        positioning="below-start"
      >
        <PopoverTrigger disableButtonEnhancement>
          <Tooltip content="Media type" relationship="label">
            <Button
              aria-label="Media type filter"
              icon={<Image24Regular />}
              aria-pressed={isMediaTypeFilterActive}
              appearance={activePanel === "type" || isMediaTypeFilterActive ? "primary" : "subtle"}
              className={styles.filterIconButton}
            />
          </Tooltip>
        </PopoverTrigger>
        <PopoverSurface className={styles.panelSurface}>
          <div className={styles.panelSection}>
            <Subtitle2>Media type</Subtitle2>
            <div className={styles.controlsRow}>
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
          </div>
        </PopoverSurface>
      </Popover>

      <Popover
        open={activePanel === "people"}
        onOpenChange={(_, data) => setActivePanel(data.open ? "people" : null)}
        positioning="below-start"
      >
        <PopoverTrigger disableButtonEnhancement>
          <Tooltip content="People in image" relationship="label">
            <Button
              aria-label="People in image filter"
              icon={<Person24Regular />}
              aria-pressed={isPeopleFilterActive}
              appearance={activePanel === "people" || isPeopleFilterActive ? "primary" : "subtle"}
              className={styles.filterIconButton}
            />
          </Tooltip>
        </PopoverTrigger>
        <PopoverSurface className={styles.panelSurface}>
          <div className={styles.panelSection}>
            <Subtitle2>People in image</Subtitle2>
            {selectedPeople.length > 0 ? (
              <div className={styles.selectedPeopleRow}>
                {selectedPeople.map((person) => (
                  <Button
                    key={person}
                    size="small"
                    appearance="secondary"
                    className={styles.selectedPersonButton}
                    onClick={() => handleRemovePerson(person)}
                  >
                    {person} ×
                  </Button>
                ))}
              </div>
            ) : null}
            <Input
              className={styles.textFilterInput}
              value={peopleSearchText}
              onChange={(_, data) => setPeopleSearchText(data.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleAddPerson(peopleSearchText);
                }
              }}
              placeholder="Search names (e.g. Scott)"
            />
            {loadingPeopleSuggestions ? (
              <Spinner size="tiny" label="Finding people..." />
            ) : null}
            {peopleSuggestions.length > 0 ? (
              <div className={styles.suggestionsList}>
                {peopleSuggestions.map((person) => (
                  <Button
                    key={person}
                    size="small"
                    appearance="subtle"
                    className={styles.suggestionButton}
                    onClick={() => handleAddPerson(person)}
                  >
                    {person}
                  </Button>
                ))}
              </div>
            ) : null}
            {selectedPeople.length > 0 || peopleSearchText.trim().length > 0 ? (
              <div className={styles.controlsRow}>
                <Button size="small" appearance="subtle" onClick={handleClearPeople}>
                  Clear
                </Button>
              </div>
            ) : null}
          </div>
        </PopoverSurface>
      </Popover>

      <Popover
        open={activePanel === "rating"}
        onOpenChange={(_, data) => setActivePanel(data.open ? "rating" : null)}
        positioning="below-start"
      >
        <PopoverTrigger disableButtonEnhancement>
          <Tooltip content="Rating" relationship="label">
            <Button
              aria-label="Rating filter"
              icon={<Star24Regular />}
              aria-pressed={isRatingFilterActive}
              appearance={activePanel === "rating" || isRatingFilterActive ? "primary" : "subtle"}
              className={styles.filterIconButton}
            />
          </Tooltip>
        </PopoverTrigger>
        <PopoverSurface className={styles.panelSurface}>
          <div className={styles.panelSection}>
            <Subtitle2>Rating</Subtitle2>
            <div className={styles.ratingFilter}>
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
              {ratingFilter !== null ? (
                <Tooltip
                  content={ratingAtLeast ? "At least this rating" : "Exactly this rating"}
                  relationship="label"
                >
                  <Button
                    size="small"
                    appearance={ratingAtLeast ? "primary" : "subtle"}
                    onClick={handleAtLeastToggle}
                    className={styles.atLeastButton}
                  >
                    ≥
                  </Button>
                </Tooltip>
              ) : null}
              {ratingFilter !== null ? (
                <Button size="small" appearance="subtle" onClick={handleClearRating}>
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </PopoverSurface>
      </Popover>

      <Popover
        open={activePanel === "date"}
        onOpenChange={(_, data) => setActivePanel(data.open ? "date" : null)}
        positioning="below-start"
      >
        <PopoverTrigger disableButtonEnhancement>
          <Tooltip content="Date" relationship="label">
            <Button
              aria-label="Date filter"
              icon={<Calendar24Regular />}
              aria-pressed={isDateFilterActive}
              appearance={activePanel === "date" || isDateFilterActive ? "primary" : "subtle"}
              className={styles.filterIconButton}
            />
          </Tooltip>
        </PopoverTrigger>
        <PopoverSurface className={styles.panelSurface}>
          <DateHistogram label="Date taken" />
        </PopoverSurface>
      </Popover>

      <Popover
        open={activePanel === "map"}
        onOpenChange={(_, data) => setActivePanel(data.open ? "map" : null)}
        positioning="below-start"
      >
        <PopoverTrigger disableButtonEnhancement>
          <Tooltip content="Map" relationship="label">
            <Button
              aria-label="Map filter"
              icon={<Location24Regular />}
              aria-pressed={isMapFilterActive}
              appearance={activePanel === "map" || isMapFilterActive ? "primary" : "subtle"}
              className={styles.filterIconButton}
            />
          </Tooltip>
        </PopoverTrigger>
        <PopoverSurface className={styles.mapPanelSurface}>
          <MapFilter compact />
        </PopoverSurface>
      </Popover>
    </div>
  );
};
