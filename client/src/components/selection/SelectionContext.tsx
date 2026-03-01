import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from "react";
import type { PhotoItem } from "../../api";

export type SelectionContextValue = {
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
  const [selected, setSelected] = useState<PhotoItem | null>(null);
  const [items, setItems] = useState<PhotoItem[]>([]);

  const selectNext = useCallback(() => {
    if (!selected) return;
    const index = items.findIndex((item) => item.path === selected.path);
    if (index === -1 || index >= items.length - 1) return;
    setSelected(items[index + 1]);
  }, [items, selected]);

  const selectPrevious = useCallback(() => {
    if (!selected) return;
    const index = items.findIndex((item) => item.path === selected.path);
    if (index <= 0) return;
    setSelected(items[index - 1]);
  }, [items, selected]);

  const value = useMemo(
    () => ({ selected, setSelected, setItems, selectNext, selectPrevious }),
    [selected, setItems, selectNext, selectPrevious],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
};
