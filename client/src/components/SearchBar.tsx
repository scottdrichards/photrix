import { useEffect, useRef, useState } from "react";
import {
  ClosedCaption24Regular,
  Dismiss24Regular,
  Image24Regular,
  MusicNote224Regular,
  Search24Regular,
  Sparkle24Filled,
  Sparkle24Regular,
} from "@fluentui/react-icons";
import {
  SEARCH_SOURCES,
  type InterpretedFilterChip,
  type InterpretedSearchFilter,
  type SearchSource,
} from "../../../shared/filter-contract/src";
import { interpretSearchQuery } from "../api/naturalLanguageSearch";
import { useFilter, type FilterState } from "./filter/FilterContext";
import { SearchInterpretationChips } from "./SearchInterpretationChips";
import css from "./SearchBar.module.css";

const SEARCH_EXAMPLES = [
  "sunset on the beach",
  "birthday cake with candles",
  "kids playing in the snow",
  "hiking in the mountains",
  "family at the dinner table",
  "dog at the park",
  "city lights at night",
  "flowers in bloom",
];

const WIDE_BREAKPOINT = "(min-width: 700px)";

// Feedback #102: AI interpretation is on by default (that's the whole point
// of the feature — type a sentence, get a filter back) but some searches are
// better served by the plain per-modality vector search below it, so this is
// a persistent opt-out rather than a one-off toggle.
const AI_SEARCH_STORAGE_KEY = "photrix_ai_search_enabled";

const readAiSearchPreference = (): boolean => {
  try {
    return window.localStorage.getItem(AI_SEARCH_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
};

const writeAiSearchPreference = (enabled: boolean): void => {
  try {
    window.localStorage.setItem(AI_SEARCH_STORAGE_KEY, String(enabled));
  } catch {
    // Ignore storage failures — the toggle still works for this session.
  }
};

/**
 * Filter fields a query interpretation is allowed to touch. Snapshotting exactly
 * these before applying is what makes "Undo" and per-chip removal exact rather
 * than a guess at what the previous state was.
 */
const snapshotInterpretedFields = (state: FilterState): InterpretedSearchFilter => ({
  path: state.path,
  includeSubfolders: state.includeSubfolders,
  mediaTypeFilter: state.mediaTypeFilter,
  peopleInImageFilter: state.peopleInImageFilter,
  faceClusterFilter: state.faceClusterFilter,
  ratingFilter: state.ratingFilter,
  dateRange: state.dateRange,
  semanticQuery: state.semanticQuery,
});

type ActiveInterpretation = {
  /** The query the user typed, kept so "Undo" can restore it verbatim. */
  query: string;
  chips: InterpretedFilterChip[];
  ignored: string[];
  /** Filter values from before the interpretation was applied. */
  previous: InterpretedSearchFilter;
};

const SOURCE_TOGGLES: { source: SearchSource; label: string; icon: React.ReactNode }[] = [
  { source: "image", label: "Image vector", icon: <Image24Regular fontSize={18} /> },
  { source: "audio", label: "Audio vector", icon: <MusicNote224Regular fontSize={18} /> },
  {
    source: "transcript",
    label: "Transcript",
    icon: <ClosedCaption24Regular fontSize={18} />,
  },
];

export const SearchBar = () => {
  const { filter, setFilter } = useFilter();
  const query = filter.semanticQuery ?? "";
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isWide, setIsWide] = useState(() => window.matchMedia(WIDE_BREAKPOINT).matches);
  const [exampleIdx, setExampleIdx] = useState(0);
  const [exampleVisible, setExampleVisible] = useState(true);
  const [isFocused, setIsFocused] = useState(false);
  const [interpretation, setInterpretation] = useState<ActiveInterpretation | null>(null);
  const [aiSearchEnabled, setAiSearchEnabled] = useState(readAiSearchPreference);
  // Only the newest submit may apply an interpretation; an older, slower one
  // must never reach in and re-filter results the user has moved on from.
  const submitSeq = useRef(0);
  // The interpretation lands one round-trip after submit, and the snapshot it
  // reverts to has to be the filter as it is *then*, not as it was at submit.
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    const id = setInterval(() => {
      setExampleVisible(false);
      setTimeout(() => {
        setExampleIdx((i) => (i + 1) % SEARCH_EXAMPLES.length);
        setExampleVisible(true);
      }, 500);
    }, 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(WIDE_BREAKPOINT);
    const handler = (e: MediaQueryListEvent) => setIsWide(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const hasActiveQuery = !!query || !!interpretation;
  const showExpanded = isExpanded || hasActiveQuery || isWide;

  const activeSources = filter.searchSources ?? SEARCH_SOURCES;

  const expand = () => {
    setIsExpanded(true);
    // Focus input after the CSS transition starts
    requestAnimationFrame(() => {
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  };

  const collapse = () => {
    if (!hasActiveQuery && !isWide) setIsExpanded(false);
  };

  /** Put every field an interpretation changed back the way it was. */
  const revertInterpretation = (
    active: ActiveInterpretation,
    overrides: Partial<InterpretedSearchFilter> = {},
  ) => {
    setFilter((prev) => ({ ...prev, ...active.previous, ...overrides }));
    setInterpretation(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = inputRef.current?.value.trim() ?? "";

    // The plain search runs immediately and unconditionally — exactly as it did
    // before this feature. Interpretation is a later, optional refinement.
    if (interpretation) revertInterpretation(interpretation, { semanticQuery: value });
    else setFilter({ semanticQuery: value || undefined });
    if (!value && !isWide) setIsExpanded(false);

    const seq = ++submitSeq.current;
    if (!value || !aiSearchEnabled) return;

    void interpretSearchQuery(value).then((result) => {
      // Discard a response the user has already moved past, and never apply one
      // that failed schema validation server-side (`interpreted: false`).
      if (seq !== submitSeq.current || !result.interpreted) return;
      setInterpretation({
        query: value,
        chips: result.chips,
        ignored: result.ignored,
        previous: snapshotInterpretedFields(filterRef.current),
      });
      setFilter((prev) => ({
        ...prev,
        ...result.filter,
        // Absent in the payload means "no free text left over"; spreading alone
        // would leave the whole sentence as the CLIP query.
        semanticQuery: result.filter.semanticQuery,
      }));
    });
  };

  const handleClear = () => {
    if (inputRef.current) inputRef.current.value = "";
    submitSeq.current += 1;
    if (interpretation)
      revertInterpretation(interpretation, { semanticQuery: undefined });
    else setFilter({ semanticQuery: undefined });
    if (!isWide) setIsExpanded(false);
  };

  /** Drop one derived filter, keeping the rest of the interpretation in place. */
  const handleRemoveChip = (chip: InterpretedFilterChip) => {
    const active = interpretation;
    if (!active) return;

    const remaining = active.chips.filter(
      (candidate) =>
        candidate.field !== chip.field ||
        (chip.value !== undefined && candidate.value !== chip.value),
    );

    setFilter((prev) => {
      const next: FilterState = { ...prev };
      if (chip.value !== undefined) {
        // Array-valued field: take out just this entry, restore the pre-search
        // value once the last one goes.
        const key =
          chip.field === "faceClusterFilter"
            ? "faceClusterFilter"
            : "peopleInImageFilter";
        const kept = (prev[key] ?? []).filter((entry) => entry !== chip.value);
        next[key] = kept.length > 0 ? kept : active.previous[key];
      } else if (chip.field === "path") {
        next.path = active.previous.path;
        next.includeSubfolders = active.previous.includeSubfolders;
      } else {
        next[chip.field] = active.previous[chip.field] as never;
      }
      return next;
    });

    setInterpretation(remaining.length > 0 ? { ...active, chips: remaining } : null);
  };

  const handleUndoInterpretation = () => {
    if (!interpretation) return;
    if (inputRef.current) inputRef.current.value = interpretation.query;
    revertInterpretation(interpretation, { semanticQuery: interpretation.query });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      inputRef.current?.blur();
      collapse();
    }
  };

  // Collapse on outside click (only matters on narrow screens where collapse is possible)
  useEffect(() => {
    if (!showExpanded || isWide) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) collapse();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [showExpanded, hasActiveQuery, isWide]);

  const toggleAiSearch = () => {
    const next = !aiSearchEnabled;
    setAiSearchEnabled(next);
    writeAiSearchPreference(next);
    // Turning AI off mid-search shouldn't leave a stale AI-derived filter
    // behind — fall back to the originally-typed query exactly like "Undo"
    // does (not filter.semanticQuery, which by now holds only the leftover
    // free text the interpretation didn't consume).
    if (!next && interpretation) {
      if (inputRef.current) inputRef.current.value = interpretation.query;
      revertInterpretation(interpretation, { semanticQuery: interpretation.query });
    }
  };

  const toggleSource = (source: SearchSource) => {
    const isActive = activeSources.includes(source);
    const next = isActive
      ? activeSources.filter((s) => s !== source)
      : SEARCH_SOURCES.filter((s) => activeSources.includes(s) || s === source);
    if (next.length === 0) return;
    setFilter({
      searchSources: next.length === SEARCH_SOURCES.length ? undefined : next,
    });
  };

  return (
    <div
      ref={containerRef}
      className={`${css.searchWrapper} ${showExpanded ? css.searchWrapperExpanded : ""}`}
    >
      {/* Icon-only button shown when collapsed */}
      <button
        type="button"
        className={css.iconBtn}
        onClick={expand}
        aria-label="Search your photos"
        aria-expanded={showExpanded}
      >
        <Search24Regular />
      </button>

      {/* Expandable form */}
      <form
        className={css.searchBar}
        onSubmit={handleSubmit}
        role="search"
        aria-hidden={!showExpanded}
      >
        <Search24Regular className={css.searchIcon} />
        <div className={css.inputWrap}>
          <input
            ref={inputRef}
            className={css.input}
            type="search"
            placeholder=""
            defaultValue={query}
            aria-label="Search your photos"
            tabIndex={showExpanded ? 0 : -1}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
          />
          {!hasActiveQuery && !isFocused && (
            <span
              className={`${css.examplePlaceholder} ${exampleVisible ? css.examplePlaceholderVisible : ""}`}
              aria-hidden
            >
              e.g. &ldquo;{SEARCH_EXAMPLES[exampleIdx]}&rdquo;
            </span>
          )}
        </div>
        {hasActiveQuery && (
          <button
            type="button"
            className={css.clearBtn}
            onClick={handleClear}
            aria-label="Clear search"
            tabIndex={showExpanded ? 0 : -1}
          >
            <Dismiss24Regular />
          </button>
        )}
        <div className={css.aiToggleGroup}>
          <button
            type="button"
            className={`${css.sourceToggle} ${aiSearchEnabled ? css.sourceToggleActive : ""}`}
            onClick={toggleAiSearch}
            aria-pressed={aiSearchEnabled}
            title={`AI search: ${aiSearchEnabled ? "on" : "off"}`}
            tabIndex={showExpanded ? 0 : -1}
          >
            {aiSearchEnabled ? <Sparkle24Filled /> : <Sparkle24Regular />}
          </button>
        </div>
        <div
          className={css.sourceToggles}
          role="group"
          aria-label="Search sources"
          title={
            aiSearchEnabled
              ? "Modalities the AI interpretation's leftover free text is matched against"
              : "Modalities searched"
          }
        >
          {SOURCE_TOGGLES.map(({ source, label, icon }) => {
            const isActive = activeSources.includes(source);
            return (
              <button
                key={source}
                type="button"
                className={`${css.sourceToggle} ${isActive ? css.sourceToggleActive : ""}`}
                onClick={() => toggleSource(source)}
                aria-pressed={isActive}
                title={`${label}: ${isActive ? "on" : "off"}`}
                tabIndex={showExpanded ? 0 : -1}
              >
                {icon}
              </button>
            );
          })}
        </div>
      </form>

      {interpretation && (
        <SearchInterpretationChips
          query={interpretation.query}
          chips={interpretation.chips}
          ignored={interpretation.ignored}
          onRemoveChip={handleRemoveChip}
          onUndo={handleUndoInterpretation}
        />
      )}
    </div>
  );
};
