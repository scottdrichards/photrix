import { useEffect, useMemo, useState } from "react";
import { Spinner } from "../../Spinner";
import css from "./SuggestionFilterField.module.css";
import {
  fetchSuggestionsWithCounts,
  SuggestionsField,
  SuggestionWithCount,
} from "../../api";
import type {
  ApiFilterOptions,
  DateRangeFilter,
  GeoBoundsLike as GeoBounds,
  MediaTypeFilter,
  RatingFilter,
} from "../../../../shared/filter-contract/src";
import { OptionListWithCounts } from "./OptionListWithCounts";

type SuggestionFilterFieldProps = {
  title: string;
  placeholder: string;
  loadingLabel: string;
  field: Extract<SuggestionsField, "personInImage" | "cameraModel" | "lens">;
  selectedValues: string[];
  onSelectedValuesChange: (nextValues: string[]) => void;
  isActive: boolean;
  includeSubfolders?: boolean;
  path?: string;
  ratingFilter?: RatingFilter | null;
  mediaTypeFilter?: MediaTypeFilter;
  locationBounds?: GeoBounds | null;
  dateRange?: DateRangeFilter | null;
  peopleInImageFilter?: Exclude<ApiFilterOptions["peopleInImageFilter"], string | null>;
  cameraModelFilter?: Exclude<ApiFilterOptions["cameraModelFilter"], string | null>;
  lensFilter?: Exclude<ApiFilterOptions["lensFilter"], string | null>;
};

export const SuggestionFilterField = ({
  title,
  placeholder,
  loadingLabel,
  field,
  selectedValues,
  onSelectedValuesChange,
  isActive,
  includeSubfolders = false,
  path,
  ratingFilter,
  mediaTypeFilter,
  locationBounds,
  dateRange,
  peopleInImageFilter = [],
  cameraModelFilter = [],
  lensFilter = [],
}: SuggestionFilterFieldProps) => {
  const [searchText, setSearchText] = useState("");
  const [suggestions, setSuggestions] = useState<SuggestionWithCount[]>([]);
  const [loading, setLoading] = useState(false);

  const selectedLookup = useMemo(
    () => new Set(selectedValues.map((value) => value.toLocaleLowerCase())),
    [selectedValues],
  );

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const abortController = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setLoading(true);
      try {
        const result = await fetchSuggestionsWithCounts({
          field,
          q: searchText.trim(),
          allowBlankQuery: true,
          includeCounts: true,
          limit: 8,
          includeSubfolders,
          path,
          ratingFilter,
          mediaTypeFilter,
          locationBounds,
          dateRange,
          peopleInImageFilter,
          cameraModelFilter,
          lensFilter,
          signal: abortController.signal,
        });

        setSuggestions(
          result.filter(
            (suggestion) => !selectedLookup.has(suggestion.value.toLocaleLowerCase()),
          ),
        );
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          return;
        }
        console.error(`Failed to load ${field} suggestions:`, error);
        setSuggestions([]);
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    }, 200);

    return () => {
      window.clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [
    isActive,
    field,
    searchText,
    includeSubfolders,
    path,
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
    cameraModelFilter,
    lensFilter,
    selectedLookup,
  ]);

  const handleAddValue = (value: string) => {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      return;
    }

    const duplicate = selectedValues.some(
      (candidate) => candidate.toLocaleLowerCase() === normalizedValue.toLocaleLowerCase(),
    );
    if (duplicate) {
      return;
    }

    onSelectedValuesChange([...selectedValues, normalizedValue]);
    setSearchText("");
  };

  const handleRemoveValue = (value: string) => {
    onSelectedValuesChange(selectedValues.filter((entry) => entry !== value));
  };

  const handleClear = () => {
    setSearchText("");
    onSelectedValuesChange([]);
  };

  const hasInteraction = selectedValues.length > 0 || searchText.trim().length > 0;

  return (
    <div className={css.section}>
      <h3>{title}</h3>
      {selectedValues.length > 0 ? (
        <div className={css.selectedRow}>
          {selectedValues.map((value) => (
            <button
              key={value}
              className={`btn btn-sm ${css.selectedButton}`}
              onClick={() => handleRemoveValue(value)}
            >
              {value} ×
            </button>
          ))}
        </div>
      ) : null}
      <input
        className={`input ${css.textFilterInput}`}
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            handleAddValue(searchText);
          }
        }}
        placeholder={placeholder}
      />
      {loading ? <Spinner size="tiny" label={loadingLabel} /> : null}
      <OptionListWithCounts
        options={suggestions.map((suggestion) => ({
          key: suggestion.value,
          label: suggestion.value,
          count: suggestion.count,
          selected: false,
        }))}
        onSelect={handleAddValue}
      />
      {hasInteraction ? (
        <div className={css.controlsRow}>
          <button className="btn btn-sm btn-subtle" onClick={handleClear}>
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
};
