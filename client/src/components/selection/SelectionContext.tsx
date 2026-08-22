import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  ReactNode,
} from "react";
import type { PhotoItem } from "../../api";
import { runWithViewTransition } from "../viewTransition";

export type PhotoMetadataOverride = {
  rating?: number | null;
  tags?: string[];
  description?: string | null;
};

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
  /**
   * Optimistically merges a tagging patch (rating/tags) onto the given paths.
   * Overrides are kept in a side map so they survive the grid re-pushing its
   * item list (e.g. on pagination) until the next full refetch reflects them.
   */
  applyMetadataOverride: (paths: string[], patch: PhotoMetadataOverride) => void;
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
  const [rawItems, setRawItems] = useState<PhotoItem[]>([]);
  const [overrides, setOverrides] = useState<Record<string, PhotoMetadataOverride>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(new Set());

  // Merge any optimistic tagging overrides onto the grid-provided items so the
  // viewer/tiles reflect edits immediately without waiting for a refetch.
  const items = useMemo(() => {
    if (Object.keys(overrides).length === 0) return rawItems;
    return rawItems.map((item) => {
      const override = overrides[item.path];
      if (!override) return item;
      return { ...item, metadata: { ...item.metadata, ...override } };
    });
  }, [rawItems, overrides]);

  const setItems = useCallback((next: PhotoItem[]) => {
    setRawItems(next);
  }, []);

  const applyMetadataOverride = useCallback(
    (paths: string[], patch: PhotoMetadataOverride) => {
      if (paths.length === 0) return;
      setOverrides((prev) => {
        const next = { ...prev };
        for (const path of paths) {
          next[path] = { ...next[path], ...patch };
        }
        return next;
      });
    },
    [],
  );

  const selected = useMemo(() => {
    if (!selectedPath) return null;
    return items.find((item) => item.path === selectedPath) ?? null;
  }, [items, selectedPath]);

  // Wrapped in a View Transition so opening a photo/video (a tile becoming
  // the fullscreen viewer's media) or closing it (the reverse) animates the
  // shared element expanding/collapsing into place instead of a hard cut —
  // see components/viewTransition.ts and FullscreenViewer's use of the same
  // per-photo name on its media element.
  const setSelected = useCallback((photo: PhotoItem | null) => {
    runWithViewTransition(() => setSelectedPath(photo?.path ?? null));
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
      applyMetadataOverride,
    }),
    [
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
      applyMetadataOverride,
    ],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
};
