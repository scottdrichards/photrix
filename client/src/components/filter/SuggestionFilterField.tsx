import {
  Button,
  Input,
  Spinner,
  Subtitle2,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useEffect, useMemo, useState } from "react";
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

const useStyles = makeStyles({
  section: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalS,
  },
  textFilterInput: {
    width: "100%",
  },
  selectedRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
  },
  selectedButton: {
    paddingInline: tokens.spacingHorizontalS,
  },
  controlsRow: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
});

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
  const styles = useStyles();
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
    <div className={styles.section}>
      <Subtitle2>{title}</Subtitle2>
      {selectedValues.length > 0 ? (
        <div className={styles.selectedRow}>
          {selectedValues.map((value) => (
            <Button
              key={value}
              size="small"
              appearance="secondary"
              className={styles.selectedButton}
              onClick={() => handleRemoveValue(value)}
            >
              {value} ×
            </Button>
          ))}
        </div>
      ) : null}
      <Input
        className={styles.textFilterInput}
        value={searchText}
        onChange={(_, data) => setSearchText(data.value)}
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
        <div className={styles.controlsRow}>
          <Button size="small" appearance="subtle" onClick={handleClear}>
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
};
