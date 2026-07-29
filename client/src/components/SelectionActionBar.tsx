import { Dismiss24Regular } from "@fluentui/react-icons";
import { updatePhotoMetadata } from "../api";
import { useSelectionContext } from "./selection/SelectionContext";
import { StarRating } from "./StarRating";
import { TagEditor } from "./TagEditor";
import css from "./SelectionActionBar.module.css";

/**
 * Floating bar shown while items are checked in selection mode. Applies a star
 * rating or a label to every checked photo at once (optimistic + persisted).
 */
export function SelectionActionBar() {
  const { selectionMode, checkedPaths, items, applyMetadataOverride, exitSelectionMode } =
    useSelectionContext();

  if (!selectionMode || checkedPaths.size === 0) return null;

  const paths = [...checkedPaths];
  const byPath = new Map(items.map((item) => [item.path, item]));

  // Reflect a common rating across the selection; mixed ratings show as unrated.
  const ratings = new Set(
    paths.map((path) => {
      const r = byPath.get(path)?.metadata?.rating;
      return typeof r === "number" && r > 0 ? r : 0;
    }),
  );
  const commonRating = ratings.size === 1 ? [...ratings][0] : 0;

  const setRating = (rating: number) => {
    applyMetadataOverride(paths, { rating: rating > 0 ? rating : null });
    paths.forEach((path) => {
      void updatePhotoMetadata(path, { rating }).catch(() => {});
    });
  };

  const addLabel = (label: string) => {
    const trimmed = label.trim();
    if (!trimmed) return;
    paths.forEach((path) => {
      const existing = byPath.get(path)?.metadata?.tags;
      const tags = Array.isArray(existing) ? (existing as string[]) : [];
      if (tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) return;
      const next = [...tags, trimmed];
      applyMetadataOverride([path], { tags: next });
      void updatePhotoMetadata(path, { tags: next }).catch(() => {});
    });
  };

  return (
    <div className={css.bar} role="toolbar" aria-label="Selection tagging actions">
      <span className={css.count}>{checkedPaths.size} selected</span>
      <span className={css.divider} aria-hidden="true" />
      <StarRating
        value={commonRating}
        onChange={setRating}
        label="Rate selected photos"
      />
      <span className={css.divider} aria-hidden="true" />
      <TagEditor
        tags={[]}
        onChange={(next) => {
          const added = next[next.length - 1];
          if (added) addLabel(added);
        }}
        placeholder="Label selected…"
      />
      <button
        type="button"
        className={css.close}
        onClick={exitSelectionMode}
        aria-label="Exit selection"
        title="Exit selection"
      >
        <Dismiss24Regular />
      </button>
    </div>
  );
}
