import {
  ArrowDown16Regular,
  ArrowUp16Regular,
  Calendar20Regular,
  Sparkle20Regular,
  Star20Regular,
} from "@fluentui/react-icons";
import { useEffect } from "react";
import { DEFAULT_SORT, type SortOption } from "../../../shared/filter-contract/src";
import { useFilter } from "./filter/FilterContext";
import css from "./SortControl.module.css";

type SortField = SortOption["field"];
type Direction = SortOption["direction"];

type SortFieldDef = {
  field: SortField;
  label: string;
  Icon: typeof Calendar20Regular;
  /** Direction applied when this field is first selected. */
  defaultDirection: Direction;
  /** Tooltip halves describing what each direction means. */
  directionHint: { asc: string; desc: string };
  /** Only offered while a semantic search is active (relevance has no meaning otherwise). */
  searchOnly?: boolean;
  /** Relevance only makes sense descending, so it has no direction toggle. */
  fixedDirection?: boolean;
};

// Ordered left-to-right in the segmented control.
const SORT_FIELDS: SortFieldDef[] = [
  {
    field: "relevance",
    label: "Best match",
    Icon: Sparkle20Regular,
    defaultDirection: "desc",
    directionHint: { asc: "Best match", desc: "Best match" },
    searchOnly: true,
    fixedDirection: true,
  },
  {
    field: "date",
    label: "Date",
    Icon: Calendar20Regular,
    defaultDirection: "desc",
    directionHint: { asc: "Oldest first", desc: "Newest first" },
  },
  {
    field: "rating",
    label: "Rating",
    Icon: Star20Regular,
    defaultDirection: "desc",
    directionHint: { asc: "Lowest rated", desc: "Highest rated" },
  },
];

/**
 * Sort-order control for the thumbnail grid.
 *
 * Rendered as a segmented group of icon buttons — one per sort field. The active
 * field is highlighted and shows a direction arrow; clicking it again toggles
 * ascending/descending. Clicking an inactive field selects it at its default
 * direction.
 *
 * The default is server-driven: no explicit `sortBy` means newest-first when
 * browsing and best-match while a search is active. Selecting an option pins it
 * in filter state (and thus the URL). "Best match" is only shown during a search
 * because relevance is meaningless without a query; if a pinned relevance sort
 * outlives its search, we reset it so library browsing falls back to date order.
 */
export const SortControl = () => {
  const { filter, setFilter } = useFilter();
  const searchActive = Boolean(filter.semanticQuery);

  useEffect(() => {
    if (!searchActive && filter.sortBy?.field === "relevance") {
      setFilter({ sortBy: undefined });
    }
  }, [searchActive, filter.sortBy, setFilter]);

  const activeSort: SortOption = filter.sortBy
    ? filter.sortBy
    : searchActive
      ? { field: "relevance", direction: "desc" }
      : DEFAULT_SORT;

  const fields = SORT_FIELDS.filter((def) => searchActive || !def.searchOnly);

  const selectField = (def: SortFieldDef) => {
    const isActive = def.field === activeSort.field;
    if (isActive && !def.fixedDirection) {
      // Toggle direction on the already-selected field.
      setFilter({
        sortBy: {
          field: def.field,
          direction: activeSort.direction === "asc" ? "desc" : "asc",
        },
      });
      return;
    }
    setFilter({ sortBy: { field: def.field, direction: def.defaultDirection } });
  };

  return (
    <div className={css.sortControl} role="group" aria-label="Sort results">
      <span className={css.label}>Sort</span>
      <div className={css.segments}>
        {fields.map((def) => {
          const isActive = def.field === activeSort.field;
          const direction = isActive ? activeSort.direction : def.defaultDirection;
          const hint = def.directionHint[direction];
          const canToggle = isActive && !def.fixedDirection;
          const title = canToggle
            ? `${hint} — click to reverse`
            : hint;
          const Arrow = direction === "asc" ? ArrowUp16Regular : ArrowDown16Regular;
          return (
            <button
              key={def.field}
              type="button"
              className={css.segment}
              data-active={isActive}
              aria-pressed={isActive}
              title={title}
              onClick={() => selectField(def)}
            >
              <def.Icon className={css.fieldIcon} />
              <span className={css.segmentLabel}>{def.label}</span>
              {isActive && !def.fixedDirection && (
                <Arrow className={css.arrow} aria-hidden />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
