import { useEffect, useRef, useState } from "react";
import {
  ClosedCaption24Regular,
  Dismiss24Regular,
  Image24Regular,
  MusicNote224Regular,
  Search24Regular,
} from "@fluentui/react-icons";
import { SEARCH_SOURCES, type SearchSource } from "../../../shared/filter-contract/src";
import { useFilter } from "./filter/FilterContext";
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

const SOURCE_TOGGLES: { source: SearchSource; label: string; icon: React.ReactNode }[] = [
  { source: "image", label: "Image vector", icon: <Image24Regular fontSize={18} /> },
  { source: "audio", label: "Audio vector", icon: <MusicNote224Regular fontSize={18} /> },
  { source: "transcript", label: "Transcript", icon: <ClosedCaption24Regular fontSize={18} /> },
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

  const hasActiveQuery = !!query;
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = inputRef.current?.value.trim() ?? "";
    setFilter({ semanticQuery: value || undefined });
    if (!value && !isWide) setIsExpanded(false);
  };

  const handleClear = () => {
    if (inputRef.current) inputRef.current.value = "";
    setFilter({ semanticQuery: undefined });
    if (!isWide) setIsExpanded(false);
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

  const toggleSource = (source: SearchSource) => {
    const isActive = activeSources.includes(source);
    const next = isActive
      ? activeSources.filter((s) => s !== source)
      : SEARCH_SOURCES.filter((s) => activeSources.includes(s) || s === source);
    if (next.length === 0) return;
    setFilter({ searchSources: next.length === SEARCH_SOURCES.length ? undefined : next });
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
        onKeyDown={handleKeyDown}
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
        <div className={css.sourceToggles} role="group" aria-label="Search sources">
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
    </div>
  );
};
