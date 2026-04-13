import {
  createContext,
  useContext,
  useState,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import type { ClientFilterState } from "../../../../shared/filter-contract/src";
export type { MediaTypeFilter } from "../../../../shared/filter-contract/src";

/**
 * null values means "find items with no value for this field".
 */
export type FilterState = ClientFilterState;

type FilterContextValue = {
  filter: FilterState;
  setFilter: (
    update: Partial<FilterState> | ((prev: FilterState) => FilterState),
  ) => void;
};

const FilterContext = createContext<FilterContextValue | null>(null);

export const useFilterContext = () => {
  const context = useContext(FilterContext);
  if (!context) {
    throw new Error("useFilterContext must be used within a FilterProvider");
  }
  return context;
};

const createInitialFilterFromURL = (): FilterState => {
  const pathFromLocation = decodeURIComponent(window.location.pathname.slice(1));
  const path = pathFromLocation ? pathFromLocation + "/" : "";

  return {
    includeSubfolders:
      new URLSearchParams(window.location.search).get("includeSubfolders") !== "false",
    path,
    mediaTypeFilter: "all",
  };
};

type FilterProviderProps = {
  children: ReactNode;
};

export const FilterProvider = ({ children }: FilterProviderProps) => {
  const [filter, setFilterState] = useState<FilterState>(createInitialFilterFromURL);

  type SetFilterUpdate = Partial<FilterState> | ((prev: FilterState) => FilterState);
  const setFilter = useCallback((update: SetFilterUpdate) => {
    setFilterState((prev) =>
      typeof update === "function" ? update(prev) : { ...prev, ...update },
    );
  }, []);

  const value = useMemo(() => ({ filter, setFilter }), [filter, setFilter]);

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
};
