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

  const value = useMemo(
    () => ({
      items,
      selected,
      setSelected,
      setItems,
      selectNext,
      selectPrevious,
    }),
    [items, selected, setSelected, setItems, selectNext, selectPrevious],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
};
