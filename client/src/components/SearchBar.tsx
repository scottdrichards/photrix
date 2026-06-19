import { useRef } from "react";
import { Search24Regular, Dismiss24Regular } from "@fluentui/react-icons";
import { useFilter } from "./filter/FilterContext";
import css from "./SearchBar.module.css";

export const SearchBar = () => {
  const { filter, setFilter } = useFilter();
  const query = filter.semanticQuery ?? "";
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = inputRef.current?.value.trim() ?? "";
    setFilter({ semanticQuery: value || undefined });
  };

  const handleClear = () => {
    if (inputRef.current) inputRef.current.value = "";
    setFilter({ semanticQuery: undefined });
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
    </form>
  );
};
