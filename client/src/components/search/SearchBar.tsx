import { useEffect, useRef, useState } from "react";
import {
  ClosedCaption24Regular,
  Dismiss24Regular,
  Image24Regular,
  MusicNote224Regular,
  Search24Regular,
  Sparkle24Filled,
  Sparkle24Regular,
  Tag24Regular,
} from "@fluentui/react-icons";
import {
  SEARCH_SOURCES,
  type SearchSource,
  type InterpretedFilterChip,
  type InterpretedPersonAlternative,
  type InterpretedSearchFilter,
} from "../../../../shared/filter-contract/src";
import { interpretSearchQuery } from "../../api/naturalLanguageSearch";
import { useFilter, type FilterState } from "../filter/FilterContext";
import { SearchInterpretationChips } from "./SearchInterpretationChips";
import css from "./SearchBar.module.css";
import { SearchStatusIcon } from "./SearchStatus";
import { readStorage, writeStorage } from "../../storage";

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

// Feedback #102: AI interpretation is on by default (that's the whole point
// of the feature — type a sentence, get a filter back) but some searches are
// better served by the plain per-modality vector search below it, so this is
// a persistent opt-out rather than a one-off toggle.
const AI_SEARCH_STORAGE_KEY = "photrix_ai_search_enabled";

const readAiSearchPreference = (): boolean => readStorage(AI_SEARCH_STORAGE_KEY) !== "false";

const writeAiSearchPreference = (enabled: boolean): void =>
  writeStorage(AI_SEARCH_STORAGE_KEY, String(enabled));

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

const PERSON_CHIP_FIELDS = new Set(["faceClusterFilter", "peopleInImageFilter"]);

const isPersonChip = (chip: InterpretedFilterChip): boolean =>
  chip.value !== undefined && PERSON_CHIP_FIELDS.has(chip.field);

/**
 * Whether the filter still carries what this chip added. Other controls (the
 * face filter panel, the date histogram) edit the same fields, so a chip can
 * be undone from outside the search bar (feedback #166).
 */
const isChipStillApplied = (
  chip: InterpretedFilterChip,
  filter: FilterState,
  previous: InterpretedSearchFilter,
): boolean => {
  if (chip.value !== undefined) {
    const key = chip.field === "faceClusterFilter" ? "faceClusterFilter" : "peopleInImageFilter";
    return (filter[key] ?? []).includes(chip.value);
  }
  if (chip.field === "path") {
    return filter.path !== previous.path || filter.includeSubfolders !== previous.includeSubfolders;
  }
  const field = chip.field as keyof InterpretedSearchFilter;
  return JSON.stringify(filter[field]) !== JSON.stringify(previous[field]);
};

/**
 * The words of the typed query that named this person: "rachel" for a chip
 * labelled "Rachel Johnson Shepherd". Falls back to the label itself. Only
 * needed when the server didn't say which words a chip came from.
 */
const typedTermForChip = (query: string, chip: InterpretedFilterChip): string => {
  const nameWords = new Set(chip.label.toLowerCase().split(/\s+/).filter(Boolean));
  const typed = query
    .split(/\s+/)
    .filter((word) => nameWords.has(word.toLowerCase().replace(/['’]s$|[^\p{L}\p{N}'’-]/gu, "")));
  return typed.length > 0
    ? typed.map((word) => word.replace(/['’]s$|[^\p{L}\p{N}'’-]/gu, "")).join(" ")
    : chip.label;
};

/**
 * Feedback #184: what a removed chip hands back to the free-text search. The
 * server says which typed words produced it ("christmas" for a December date);
 * the free-text chip itself has nothing to hand back.
 */
const textForChip = (query: string, chip: InterpretedFilterChip): string | undefined => {
  if (chip.field === "semanticQuery") return undefined;
  if (chip.sourceText) return chip.sourceText;
  return isPersonChip(chip) ? typedTermForChip(query, chip) : undefined;
};

/** Append `extra` to `text`, skipping words the text already has. */
const appendWords = (text: string | undefined, extra: string): string | undefined => {
  const have = new Set((text ?? "").toLowerCase().split(/\s+/).filter(Boolean));
  const added = extra.split(/\s+/).filter((word) => word && !have.has(word.toLowerCase()));
  return [text, ...added].filter(Boolean).join(" ") || undefined;
};

type ActiveInterpretation = {
  /** The query the user typed, kept so "Undo" can restore it verbatim. */
  query: string;
  chips: InterpretedFilterChip[];
  ignored: string[];
  /** Filter values from before the interpretation was applied. */
  previous: InterpretedSearchFilter;
};

// Feedback #199 (which brought this back after #131 removed it): the owner
// wants to switch kinds of matching off, e.g. audio, when a search is noisy.
const SOURCE_TOGGLES: { source: SearchSource; label: string; icon: React.ReactNode }[] = [
  { source: "image", label: "Image content", icon: <Image24Regular fontSize={18} /> },
  { source: "audio", label: "Audio content", icon: <MusicNote224Regular fontSize={18} /> },
  {
    source: "transcript",
    label: "Speech transcript",
    icon: <ClosedCaption24Regular fontSize={18} />,
  },
  { source: "metadata", label: "Names and tags", icon: <Tag24Regular fontSize={18} /> },
];

export const SearchBar = () => {
  const { filter, setFilter } = useFilter();
  const query = filter.semanticQuery ?? "";
  const inputRef = useRef<HTMLInputElement>(null);
  const [exampleIdx, setExampleIdx] = useState(0);
  const [exampleVisible, setExampleVisible] = useState(true);
  const [isFocused, setIsFocused] = useState(false);
  const [interpretation, setInterpretation] = useState<ActiveInterpretation | null>(null);
  const [aiSearchEnabled, setAiSearchEnabled] = useState(readAiSearchPreference);
  // True from submit until the model has answered (feedback #196).
  const [isInterpreting, setIsInterpreting] = useState(false);
  // Only the newest submit may apply an interpretation; an older, slower one
  // must never reach in and re-filter results the user has moved on from.
  const submitSeq = useRef(0);
  // The interpretation lands one round-trip after submit, and the snapshot it
  // reverts to has to be the filter as it is *then*, not as it was at submit.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const interpretationRef = useRef(interpretation);
  interpretationRef.current = interpretation;

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

  const activeSources = filter.searchSources ?? SEARCH_SOURCES;
  const hasActiveQuery = !!query || !!interpretation;

  /** The box shows whatever free text is still being searched for. */
  const showLeftoverQuery = (semanticQuery: string | undefined) => {
    if (inputRef.current) inputRef.current.value = semanticQuery ?? "";
  };

  // Feedback #166: a derived filter removed from somewhere else (the face
  // filter panel) takes its chip with it, and once nothing derived is left the
  // box stops showing a query that is no longer being searched.
  useEffect(() => {
    if (!interpretation) return;
    const live = interpretation.chips.filter((chip) =>
      isChipStillApplied(chip, filter, interpretation.previous),
    );
    if (live.length === interpretation.chips.length) return;
    if (live.length > 0) {
      setInterpretation({ ...interpretation, chips: live });
      return;
    }
    setInterpretation(null);
    showLeftoverQuery(filter.semanticQuery);
  }, [filter, interpretation]);

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
    const seq = ++submitSeq.current;

    if (!value || !aiSearchEnabled) {
      // Nothing for the model to do: search as typed, straight away.
      setIsInterpreting(false);
      if (interpretation) revertInterpretation(interpretation, { semanticQuery: value });
      else setFilter({ semanticQuery: value || undefined });
      return;
    }

    // Feedback #196: wait for the model before touching the filter. Running the
    // plain text search first and then swapping in the interpreted one made the
    // grid change twice, and the first answer was the wrong one. Whatever was on
    // screen stays until the one answer is ready.
    setIsInterpreting(true);
    void interpretSearchQuery(value).then((result) => {
      // A newer submit or a clear owns the filter now.
      if (seq !== submitSeq.current) return;
      setIsInterpreting(false);
      const active = interpretationRef.current;

      // Never apply one that failed schema validation server-side
      // (`interpreted: false`): search the typed text, as without AI.
      if (!result.interpreted) {
        if (active) revertInterpretation(active, { semanticQuery: value });
        else setFilter({ semanticQuery: value });
        return;
      }

      // The newest interpretation replaces the previous one outright, so the
      // fields to snapshot and to revert to are those from before the first.
      const base = active ? { ...filterRef.current, ...active.previous } : filterRef.current;
      setInterpretation({
        query: value,
        chips: result.chips,
        ignored: result.ignored,
        previous: snapshotInterpretedFields(base),
      });
      setFilter((prev) => ({
        ...prev,
        ...(active ? active.previous : {}),
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
    setIsInterpreting(false);
    if (interpretation)
      revertInterpretation(interpretation, { semanticQuery: undefined });
    else setFilter({ semanticQuery: undefined });
  };

  /**
   * Drop one derived filter, keeping the rest of the interpretation in place.
   * The words it came from go back into the free-text search (feedback #184):
   * "christmas lights" read as December, and removing that should leave a
   * search for christmas lights, not just "lights".
   */
  const handleRemoveChip = (chip: InterpretedFilterChip) => {
    const active = interpretation;
    if (!active) return;
    const extraText = textForChip(active.query, chip);
    const leftover = extraText ? appendWords(filter.semanticQuery, extraText) : filter.semanticQuery;

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
      if (extraText) next.semanticQuery = leftover;
      return next;
    });

    setInterpretation(remaining.length > 0 ? { ...active, chips: remaining } : null);
    // With the last derived filter gone, the box shows what is still searched.
    if (remaining.length === 0 || extraText) showLeftoverQuery(leftover);
  };

  /**
   * Feedback #170: the typed name matched several people and the model picked
   * one. Swap the filter to the one the user meant; the chip they swapped away
   * from becomes an alternative, so the choice can be undone the same way.
   */
  const handleSwapPerson = (chip: InterpretedFilterChip, to: InterpretedPersonAlternative) => {
    const active = interpretation;
    if (!active || !isPersonChip(chip) || chip.value === undefined) return;
    const from = chip.value;
    const fromKey = chip.field as InterpretedPersonAlternative["field"];

    setFilter((prev) => {
      const next: FilterState = { ...prev };
      const without = (prev[fromKey] ?? []).filter((entry) => entry !== from);
      // Applying the interpretation replaced the field outright, so a field
      // only the swap target uses starts empty, not from the pre-search value.
      const target =
        to.field === fromKey
          ? without
          : active.chips.some((other) => other.field === to.field)
            ? (prev[to.field] ?? [])
            : [];
      if (to.field !== fromKey) {
        next[fromKey] = without.length > 0 ? without : active.previous[fromKey];
      }
      next[to.field] = target.includes(to.value) ? target : [...target, to.value];
      return next;
    });

    const swapped: InterpretedFilterChip = {
      ...to,
      alternatives: [
        { field: fromKey, label: chip.label, value: from },
        ...(chip.alternatives ?? []).filter(
          (other) => other.field !== to.field || other.value !== to.value,
        ),
      ],
    };
    setInterpretation({
      ...active,
      chips: active.chips.map((other) =>
        other.field === chip.field && other.value === from ? swapped : other,
      ),
    });
  };

  const handleUndoInterpretation = () => {
    if (!interpretation) return;
    if (inputRef.current) inputRef.current.value = interpretation.query;
    revertInterpretation(interpretation, { semanticQuery: interpretation.query });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      inputRef.current?.blur();
    }
  };

  const toggleSource = (source: SearchSource) => {
    const isActive = activeSources.includes(source);
    const next = isActive
      ? activeSources.filter((s) => s !== source)
      : SEARCH_SOURCES.filter((s) => activeSources.includes(s) || s === source);
    // Search needs at least one source; the last one stays on.
    if (next.length === 0) return;
    setFilter({ searchSources: next.length === SEARCH_SOURCES.length ? undefined : next });
  };

  const toggleAiSearch = () => {
    const next = !aiSearchEnabled;
    setAiSearchEnabled(next);
    writeAiSearchPreference(next);
    if (!next) {
      submitSeq.current += 1;
      setIsInterpreting(false);
    }
    // Turning AI off mid-search shouldn't leave a stale AI-derived filter
    // behind — fall back to the originally-typed query exactly like "Undo"
    // does (not filter.semanticQuery, which by now holds only the leftover
    // free text the interpretation didn't consume).
    if (!next && interpretation) {
      if (inputRef.current) inputRef.current.value = interpretation.query;
      revertInterpretation(interpretation, { semanticQuery: interpretation.query });
    }
  };

  return (
    // Always a visible field: on phones it gets a full-width row of its own
    // in the header, so there is no collapsed icon-only mode to manage.
    <div className={css.searchWrapper}>
      <form
        className={css.searchBar}
        onSubmit={handleSubmit}
        role="search"
        aria-busy={isInterpreting}
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
          >
            <Dismiss24Regular />
          </button>
        )}
        <SearchStatusIcon />
        <div className={css.aiToggleGroup}>
          <button
            type="button"
            className={`${css.sourceToggle} ${aiSearchEnabled ? css.sourceToggleActive : ""}`}
            onClick={toggleAiSearch}
            aria-pressed={aiSearchEnabled}
            title={
              isInterpreting
                ? "AI search: working out your filters…"
                : `AI search: ${aiSearchEnabled ? "on" : "off"}`
            }
            data-busy={isInterpreting || undefined}
          >
            {aiSearchEnabled ? <Sparkle24Filled /> : <Sparkle24Regular />}
          </button>
        </div>
        <div
          className={css.sourceToggles}
          role="group"
          aria-label="Search sources"
          title="Kinds of matching a search uses"
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
          onSwapPerson={handleSwapPerson}
          onUndo={handleUndoInterpretation}
        />
      )}
    </div>
  );
};
