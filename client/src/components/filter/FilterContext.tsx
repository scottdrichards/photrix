import {
  createContext,
  useContext,
  useState,
  useMemo,
  useCallback,
  ReactNode,
} from "react";
import { GeoBounds } from "../../api";

export type MediaTypeFilter = "all" | "photo" | "video" | "other";

/** null means filtering for items without that property */
type NullableFilter = {
  ratingFilter: { rating: number; atLeast: boolean };
  locationBounds: GeoBounds | undefined;
  dateRange: { start: number; end: number };
};

export type FilterState = Partial<
  {
    includeSubfolders: boolean;
    path: string;
    mediaTypeFilter: MediaTypeFilter;
    peopleInImageFilter: string[];
  } & {
    [K in keyof NullableFilter]: NullableFilter[K] | null;
  }
>;

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

const createInitialFilter = (): FilterState => {
  const pathFromLocation = decodeURIComponent(window.location.pathname.slice(1));
  const path = pathFromLocation ? pathFromLocation + "/" : "";

  const includeSubfolders =
    new URLSearchParams(window.location.search).get("includeSubfolders") !== "false";
  return {
    includeSubfolders,
    path,
    ratingFilter: null,
    mediaTypeFilter: "all",
    peopleInImageFilter: [],
    locationBounds: undefined,
    dateRange: null,
  };
};

type FilterProviderProps = {
  children: ReactNode;
};

export const FilterProvider = ({ children }: FilterProviderProps) => {
  const [filter, setFilterState] = useState<FilterState>(createInitialFilter);

  const setFilter = useCallback(
    (update: Partial<FilterState> | ((prev: FilterState) => FilterState)) => {
      setFilterState((prev) =>
        typeof update === "function" ? update(prev) : { ...prev, ...update },
      );
    },
    [],
  );

  const value = useMemo(() => ({ filter, setFilter }), [filter, setFilter]);

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
};
