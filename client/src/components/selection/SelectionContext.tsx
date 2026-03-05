import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  ReactNode,
  useEffect,
} from "react";
import type { PhotoItem } from "../../api";

export type SelectionContextValue = {
  items: PhotoItem[];
  selected: PhotoItem | null;
  selectedItems: PhotoItem[];
  selectedPaths: string[];
  selectionMode: boolean;
  setSelectionMode: (selectionMode: boolean) => void;
  setSelected: (photo: PhotoItem | null) => void;
  toggleSelected: (photo: PhotoItem) => void;
  clearSelection: () => void;
  isSelected: (path: string) => boolean;
  setItems: (items: PhotoItem[]) => void;
  selectNext: () => void;
  selectPrevious: () => void;
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

export const useSelectionContext = (): SelectionContextValue => {
  const ctx = useContext(SelectionContext);
  if (!ctx) {
    throw new Error("useSelectionContext must be used within a SelectionProvider");
  }
  return ctx;
};

export const SelectionProvider = ({ children }: { children: ReactNode }) => {
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [selectionMode, setSelectionModeState] = useState(false);

  const itemByPath = useMemo(
    () => new Map(items.map((item) => [item.path, item] as const)),
    [items],
  );

  const selectedItems = useMemo(
    () =>
      selectedPaths
        .map((path) => itemByPath.get(path))
        .filter((item): item is PhotoItem => Boolean(item)),
    [itemByPath, selectedPaths],
  );

  const selected = selectedItems.length === 1 ? selectedItems[0] : null;

  useEffect(() => {
    const validPaths = new Set(items.map((item) => item.path));
    setSelectedPaths((previousPaths) => {
      const filteredPaths = previousPaths.filter((path) => validPaths.has(path));
      return filteredPaths.length === previousPaths.length
        ? previousPaths
        : filteredPaths;
    });
  }, [items]);

  const setSelected = useCallback((photo: PhotoItem | null) => {
    if (!photo) {
      setSelectedPaths([]);
      return;
    }
    setSelectedPaths([photo.path]);
  }, []);

  const toggleSelected = useCallback((photo: PhotoItem) => {
    setSelectedPaths((previousPaths) =>
      previousPaths.includes(photo.path)
        ? previousPaths.filter((path) => path !== photo.path)
        : [...previousPaths, photo.path],
    );
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedPaths([]);
  }, []);

  const setSelectionMode = useCallback((nextSelectionMode: boolean) => {
    setSelectionModeState(nextSelectionMode);
  }, []);

  const isSelected = useCallback(
    (path: string) => selectedPaths.includes(path),
    [selectedPaths],
  );

  const selectNext = useCallback(() => {
    if (selectedPaths.length !== 1) return;
    const index = items.findIndex((item) => item.path === selectedPaths[0]);
    if (index === -1 || index >= items.length - 1) return;
    setSelectedPaths([items[index + 1].path]);
  }, [items, selectedPaths]);

  const selectPrevious = useCallback(() => {
    if (selectedPaths.length !== 1) return;
    const index = items.findIndex((item) => item.path === selectedPaths[0]);
    if (index <= 0) return;
    setSelectedPaths([items[index - 1].path]);
  }, [items, selectedPaths]);

  const value = useMemo(
    () => ({
      items,
      selected,
      selectedItems,
      selectedPaths,
      selectionMode,
      setSelectionMode,
      setSelected,
      toggleSelected,
      clearSelection,
      isSelected,
      setItems,
      selectNext,
      selectPrevious,
    }),
    [
      clearSelection,
      isSelected,
      items,
      selectNext,
      selectPrevious,
      selected,
      selectedItems,
      selectedPaths,
      selectionMode,
      setSelectionMode,
      setItems,
      setSelected,
      toggleSelected,
    ],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
};
