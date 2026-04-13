import {
  Camera,
  Calendar,
  Folder,
  Image,
  MapPin,
  User,
  Star,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "../../Spinner";
import css from "./Filter.module.css";
import { fetchFolders, fetchSuggestionsWithCounts } from "../../api";
import type { MediaTypeFilter } from "../../../../shared/filter-contract/src";
import { DateHistogram } from "../DateHistogram";
import { MapFilter } from "../MapFilter";
import { OptionListWithCounts } from "./OptionListWithCounts";
import { useFilterContext } from "./FilterContext";
import { SuggestionFilterField } from "./SuggestionFilterField";

type FilterPanel =
  | "folders"
  | "type"
  | "people"
  | "gear"
  | "rating"
  | "date"
  | "map";

export const Filter = () => {
  const filterBarRef = useRef<HTMLDivElement>(null);
  const { filter, setFilter } = useFilterContext();
  const {
    includeSubfolders,
    ratingFilter,
    mediaTypeFilter,
    path,
    peopleInImageFilter,
    cameraModelFilter,
    lensFilter,
    locationBounds,
    dateRange,
  } = filter;

  const selectedPeople = peopleInImageFilter ?? [];
  const selectedCameraModels = cameraModelFilter ?? [];
  const selectedLensModels = lensFilter ?? [];

  const ratingValue = ratingFilter?.rating ?? null;
  const ratingAtLeast = ratingFilter?.atLeast ?? true;

  const [activePanel, setActivePanel] = useState<FilterPanel | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [ratingCounts, setRatingCounts] = useState<Record<number, number>>({});
  const [loadingRatingCounts, setLoadingRatingCounts] = useState(false);

  useEffect(() => {
    if (!activePanel) return;
    const handle = (e: MouseEvent) => {
      if (!filterBarRef.current?.contains(e.target as Node)) setActivePanel(null);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [activePanel]);

  const currentPath = path?.replace(/\/$/, "");
  const isFolderFilterActive = Boolean(currentPath) || includeSubfolders === false;
  const isMediaTypeFilterActive = Boolean(mediaTypeFilter && mediaTypeFilter !== "all");
  const isPeopleFilterActive = selectedPeople.length > 0;
  const isGearFilterActive =
    selectedCameraModels.length > 0 || selectedLensModels.length > 0;
  const isRatingFilterActive = ratingFilter !== undefined;
  const isDateFilterActive = dateRange !== undefined;
  const isMapFilterActive = locationBounds !== undefined;

  const handleRatingClick = (star: number) => {
    if (ratingValue === star) {
      setFilter((prev) => {
        const { ratingFilter, ...rest } = prev;
        return rest;
      });
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
    setFilter((prev) => {
      const { ratingFilter, ...rest } = prev;
      return rest;
    });
  };

  const handleMediaTypeChange = (type: MediaTypeFilter) => {
    setFilter({ mediaTypeFilter: type });
  };

  const arrayFilterSetter = useCallback(
    (key: "peopleInImageFilter" | "cameraModelFilter" | "lensFilter") =>
      (nextValues: string[]) => setFilter({ [key]: nextValues }),
    [setFilter],
  );

  const setPeopleFilterValues = useMemo(
    () => arrayFilterSetter("peopleInImageFilter"),
    [arrayFilterSetter],
  );
  const setCameraModelFilterValues = useMemo(
    () => arrayFilterSetter("cameraModelFilter"),
    [arrayFilterSetter],
  );
  const setLensFilterValues = useMemo(
    () => arrayFilterSetter("lensFilter"),
    [arrayFilterSetter],
  );

  useEffect(() => {
    const abortController = new AbortController();

    const loadFolders = async () => {
      setLoadingFolders(true);
      try {
        const folderList = await fetchFolders(currentPath, abortController.signal);
        setFolders(folderList);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        console.error("Failed to load folders:", err);
      } finally {
        if (!abortController.signal.aborted) {
          setLoadingFolders(false);
        }
      }
    };

    void loadFolders();
    return () => abortController.abort();
  }, [currentPath]);

  useEffect(() => {
    if (activePanel !== "rating") {
      return;
    }

    const abortController = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setLoadingRatingCounts(true);
      try {
        const result = await fetchSuggestionsWithCounts({
          field: "rating",
          q: "",
          allowBlankQuery: true,
          includeCounts: true,
          limit: 5,
          includeSubfolders,
          path,
          ratingFilter: null,
          mediaTypeFilter,
          locationBounds,
          dateRange,
          peopleInImageFilter: selectedPeople,
          cameraModelFilter: selectedCameraModels,
          lensFilter: selectedLensModels,
          signal: abortController.signal,
        });

        const nextCounts = result.reduce<Record<number, number>>((acc, suggestion) => {
          const rating = Number.parseInt(suggestion.value, 10);
          if (Number.isFinite(rating) && rating >= 1 && rating <= 5) {
            acc[rating] = suggestion.count;
          }
          return acc;
        }, {});
        setRatingCounts(nextCounts);
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          return;
        }
        console.error("Failed to load rating counts:", error);
        setRatingCounts({});
      } finally {
        if (!abortController.signal.aborted) {
          setLoadingRatingCounts(false);
        }
      }
    }, 200);

    return () => {
      window.clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [
    activePanel,
    includeSubfolders,
    path,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    selectedPeople,
    selectedCameraModels,
    selectedLensModels,
  ]);

  const ratingOptions = useMemo(
    () =>
      [5, 4, 3, 2, 1].map((star) => ({
        key: String(star),
        label: `${"★".repeat(star)}${"☆".repeat(5 - star)}`,
        count: ratingCounts[star] ?? 0,
        selected: ratingValue === star,
      })),
    [ratingCounts, ratingValue],
  );

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
    <div ref={filterBarRef} className={css.iconBar}>
      {/* Folders */}
      <div className="popover-anchor">
        <button
          title="Folders"
          aria-label="Folders filter"
          aria-pressed={isFolderFilterActive}
          className={`btn btn-icon ${css.filterIconButton} ${activePanel === "folders" || isFolderFilterActive ? "btn-primary" : "btn-subtle"}`}
          onClick={() => setActivePanel(activePanel === "folders" ? null : "folders")}
        >
          <Folder size={20} />
        </button>
        {activePanel === "folders" && (
          <div className={`popover-surface ${css.panelSurface}`}>
            <div className={css.panelSection}>
              <h3>Folders</h3>
              <label className="switch-label">
                <input
                  type="checkbox"
                  role="switch"
                  className="switch-track"
                  checked={includeSubfolders}
                  onChange={(e) => setFilter({ includeSubfolders: e.target.checked })}
                />
                <span>Include subfolders</span>
              </label>
              {currentPath ? (
                <div className={css.breadcrumbRow}>
                  <button className="btn btn-transparent" onClick={() => setFilter({ path: "" })}>
                    Home
                  </button>
                  {breadcrumbs.map((part, index) => (
                    <span key={index}>
                      <span>/</span>
                      <button
                        className="btn btn-transparent"
                        onClick={() => handleBreadcrumbClick(index)}
                      >
                        {part}
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              {loadingFolders ? (
                <Spinner size="small" label="Loading folders..." />
              ) : folders.length > 0 ? (
                <div className={css.folderGrid}>
                  {folders.map((folder) => (
                    <div
                      key={folder}
                      className={css.folderCard}
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
                      <Folder size={20} />
                      <span>{folder}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <small>No folders found.</small>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Media type */}
      <div className="popover-anchor">
        <button
          title="Media type"
          aria-label="Media type filter"
          aria-pressed={isMediaTypeFilterActive}
          className={`btn btn-icon ${css.filterIconButton} ${activePanel === "type" || isMediaTypeFilterActive ? "btn-primary" : "btn-subtle"}`}
          onClick={() => setActivePanel(activePanel === "type" ? null : "type")}
        >
          <Image size={20} />
        </button>
        {activePanel === "type" && (
          <div className={`popover-surface ${css.panelSurface}`}>
            <div className={css.panelSection}>
              <h3>Media type</h3>
              <div className={css.controlsRow}>
                {(["all", "photo", "video", "other"] as const).map((type) => (
                  <button
                    key={type}
                    className={`btn btn-sm ${mediaTypeFilter === type ? "btn-primary" : "btn-subtle"}`}
                    onClick={() => handleMediaTypeChange(type)}
                  >
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* People */}
      <div className="popover-anchor">
        <button
          title="People in image"
          aria-label="People in image filter"
          aria-pressed={isPeopleFilterActive}
          className={`btn btn-icon ${css.filterIconButton} ${activePanel === "people" || isPeopleFilterActive ? "btn-primary" : "btn-subtle"}`}
          onClick={() => setActivePanel(activePanel === "people" ? null : "people")}
        >
          <User size={20} />
        </button>
        {activePanel === "people" && (
          <div className={`popover-surface ${css.panelSurface}`}>
            <SuggestionFilterField
              title="People in image"
              placeholder="Search names (e.g. Scott)"
              loadingLabel="Finding people..."
              field="personInImage"
              selectedValues={selectedPeople}
              onSelectedValuesChange={setPeopleFilterValues}
              isActive={activePanel === "people"}
              includeSubfolders={includeSubfolders}
              path={path}
              ratingFilter={ratingFilter}
              mediaTypeFilter={mediaTypeFilter}
              locationBounds={locationBounds}
              dateRange={dateRange}
              peopleInImageFilter={selectedPeople}
              cameraModelFilter={selectedCameraModels}
              lensFilter={selectedLensModels}
            />
          </div>
        )}
      </div>

      {/* Camera/Lens */}
      <div className="popover-anchor">
        <button
          title="Camera and lens"
          aria-label="Camera and lens filter"
          aria-pressed={isGearFilterActive}
          className={`btn btn-icon ${css.filterIconButton} ${activePanel === "gear" || isGearFilterActive ? "btn-primary" : "btn-subtle"}`}
          onClick={() => setActivePanel(activePanel === "gear" ? null : "gear")}
        >
          <Camera size={20} />
        </button>
        {activePanel === "gear" && (
          <div className={`popover-surface ${css.panelSurface}`}>
            <SuggestionFilterField
              title="Camera model"
              placeholder="Search camera model (e.g. R6 Mark II)"
              loadingLabel="Finding camera models..."
              field="cameraModel"
              selectedValues={selectedCameraModels}
              onSelectedValuesChange={setCameraModelFilterValues}
              isActive={activePanel === "gear"}
              includeSubfolders={includeSubfolders}
              path={path}
              ratingFilter={ratingFilter}
              mediaTypeFilter={mediaTypeFilter}
              locationBounds={locationBounds}
              dateRange={dateRange}
              peopleInImageFilter={selectedPeople}
              cameraModelFilter={selectedCameraModels}
              lensFilter={selectedLensModels}
            />

            <SuggestionFilterField
              title="Lens model"
              placeholder="Search lens model (e.g. RF 24-70mm F2.8)"
              loadingLabel="Finding lenses..."
              field="lens"
              selectedValues={selectedLensModels}
              onSelectedValuesChange={setLensFilterValues}
              isActive={activePanel === "gear"}
              includeSubfolders={includeSubfolders}
              path={path}
              ratingFilter={ratingFilter}
              mediaTypeFilter={mediaTypeFilter}
              locationBounds={locationBounds}
              dateRange={dateRange}
              peopleInImageFilter={selectedPeople}
              cameraModelFilter={selectedCameraModels}
              lensFilter={selectedLensModels}
            />
          </div>
        )}
      </div>

      {/* Rating */}
      <div className="popover-anchor">
        <button
          title="Rating"
          aria-label="Rating filter"
          aria-pressed={isRatingFilterActive}
          className={`btn btn-icon ${css.filterIconButton} ${activePanel === "rating" || isRatingFilterActive ? "btn-primary" : "btn-subtle"}`}
          onClick={() => setActivePanel(activePanel === "rating" ? null : "rating")}
        >
          <Star size={20} />
        </button>
        {activePanel === "rating" && (
          <div className={`popover-surface ${css.panelSurface}`}>
            <div className={css.panelSection}>
              <h3>Rating</h3>
              <div className={css.ratingFilter}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    className={css.starButton}
                    onClick={() => handleRatingClick(star)}
                    title={`${star} star${star > 1 ? "s" : ""}`}
                  >
                    {ratingValue !== null && star <= ratingValue ? (
                      <Star size={24} fill="currentColor" />
                    ) : (
                      <Star size={24} />
                    )}
                  </button>
                ))}
                {ratingFilter ? (
                  <button
                    title={ratingAtLeast ? "At least this rating" : "Exactly this rating"}
                    className={`btn btn-sm ${css.atLeastButton} ${ratingAtLeast ? "btn-primary" : "btn-subtle"}`}
                    onClick={handleAtLeastToggle}
                  >
                    ≥
                  </button>
                ) : null}
                {ratingFilter ? (
                  <button className="btn btn-sm btn-subtle" onClick={handleClearRating}>
                    Clear
                  </button>
                ) : null}
              </div>
              {loadingRatingCounts ? (
                <Spinner size="tiny" label="Loading rating counts..." />
              ) : null}
              <OptionListWithCounts
                options={ratingOptions}
                onSelect={(optionKey) => {
                  const selectedStar = Number.parseInt(optionKey, 10);
                  if (Number.isFinite(selectedStar)) {
                    handleRatingClick(selectedStar);
                  }
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Date */}
      <div className="popover-anchor">
        <button
          title="Date"
          aria-label="Date filter"
          aria-pressed={isDateFilterActive}
          className={`btn btn-icon ${css.filterIconButton} ${activePanel === "date" || isDateFilterActive ? "btn-primary" : "btn-subtle"}`}
          onClick={() => setActivePanel(activePanel === "date" ? null : "date")}
        >
          <Calendar size={20} />
        </button>
        {activePanel === "date" && (
          <div className={`popover-surface ${css.panelSurface}`}>
            <DateHistogram label="Date taken" />
          </div>
        )}
      </div>

      {/* Map */}
      <div className="popover-anchor">
        <button
          title="Map"
          aria-label="Map filter"
          aria-pressed={isMapFilterActive}
          className={`btn btn-icon ${css.filterIconButton} ${activePanel === "map" || isMapFilterActive ? "btn-primary" : "btn-subtle"}`}
          onClick={() => setActivePanel(activePanel === "map" ? null : "map")}
        >
          <MapPin size={20} />
        </button>
        {activePanel === "map" && (
          <div className={`popover-surface ${css.mapPanelSurface}`}>
            <MapFilter compact />
          </div>
        )}
      </div>
    </div>
  );
};
