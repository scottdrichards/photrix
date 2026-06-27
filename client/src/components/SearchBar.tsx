import { useRef } from "react";
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

const SOURCE_TOGGLES: { source: SearchSource; label: string; icon: React.ReactNode }[] = [
  { source: "image", label: "Image vector", icon: <Image24Regular fontSize={18} /> },
  { source: "audio", label: "Audio vector", icon: <MusicNote224Regular fontSize={18} /> },
  { source: "transcript", label: "Transcript", icon: <ClosedCaption24Regular fontSize={18} /> },
];

export const SearchBar = () => {
  const { filter, setFilter } = useFilter();
  const query = filter.semanticQuery ?? "";
  const inputRef = useRef<HTMLInputElement>(null);

  // `undefined` means every source is active; materialise it to the full list so
  // the toggles render the default-on state.
  const activeSources = filter.searchSources ?? SEARCH_SOURCES;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = inputRef.current?.value.trim() ?? "";
    setFilter({ semanticQuery: value || undefined });
  };

  const handleClear = () => {
    if (inputRef.current) inputRef.current.value = "";
    setFilter({ semanticQuery: undefined });
  };

  const toggleSource = (source: SearchSource) => {
    const isActive = activeSources.includes(source);
    const next = isActive
      ? activeSources.filter((s) => s !== source)
      : SEARCH_SOURCES.filter((s) => activeSources.includes(s) || s === source);
    // Keep at least one source on — an empty set can never return results.
    if (next.length === 0) return;
    // Collapse the full set back to `undefined` so the URL/state stay clean.
    setFilter({ searchSources: next.length === SEARCH_SOURCES.length ? undefined : next });
  };

  return (
    <form className={css.searchBar} onSubmit={handleSubmit} role="search">
      <Search24Regular className={css.searchIcon} />
      <input
        ref={inputRef}
        className={css.input}
        type="search"
        placeholder="Semantic search… (e.g. sunset on the beach)"
        defaultValue={query}
        aria-label="Semantic search"
      />
      {query && (
        <button
          type="button"
          className={css.clearBtn}
          onClick={handleClear}
          aria-label="Clear search"
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
            >
              {icon}
            </button>
          );
        })}
      </div>
    </form>
  );
};
