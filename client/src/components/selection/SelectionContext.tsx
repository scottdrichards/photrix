import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  ReactNode,
} from "react";
import type { PhotoItem } from "../../api";

export type SelectionContextValue = {
  items: PhotoItem[];
  selected: PhotoItem | null;
  setSelected: (photo: PhotoItem | null) => void;
  setItems: (items: PhotoItem[]) => void;
  selectNext: () => void;
  selectPrevious: () => void;
  selectionMode: boolean;
  checkedPaths: Set<string>;
  enterSelectionMode: () => void;
  exitSelectionMode: () => void;
  toggleChecked: (photo: PhotoItem) => void;
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(new Set());

  const selected = useMemo(() => {
    if (!selectedPath) return null;
    return items.find((item) => item.path === selectedPath) ?? null;
  }, [items, selectedPath]);

  const setSelected = useCallback((photo: PhotoItem | null) => {
    setSelectedPath(photo?.path ?? null);
  }, []);

  const selectNext = useCallback(() => {
    if (!selectedPath) return;
    const index = items.findIndex((item) => item.path === selectedPath);
    if (index === -1 || index >= items.length - 1) return;
    setSelectedPath(items[index + 1].path);
  }, [items, selectedPath]);

  const selectPrevious = useCallback(() => {
    if (!selectedPath) return;
    const index = items.findIndex((item) => item.path === selectedPath);
    if (index <= 0) return;
    setSelectedPath(items[index - 1].path);
  }, [items, selectedPath]);

  const enterSelectionMode = useCallback(() => {
    setSelectionMode(true);
  }, []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setCheckedPaths(new Set());
  }, []);

  const toggleChecked = useCallback((photo: PhotoItem) => {
    setCheckedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(photo.path)) {
        next.delete(photo.path);
      } else {
        next.add(photo.path);
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      items,
      selected,
      setSelected,
      setItems,
      selectNext,
      selectPrevious,
      selectionMode,
      checkedPaths,
      enterSelectionMode,
      exitSelectionMode,
      toggleChecked,
    }),
    [items, selected, setSelected, setItems, selectNext, selectPrevious, selectionMode, checkedPaths, enterSelectionMode, exitSelectionMode, toggleChecked],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
};
