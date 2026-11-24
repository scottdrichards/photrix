import { useCallback, useEffect, useMemo } from "react";
import type { PhotoItem } from "../../api";
import { isSharedView } from "../../hooks/useShareFilter";
import { useMetadataSave } from "../selection/useMetadataSave";
import type { PhotoMetadataOverride } from "../selection/SelectionContext";

// Star ratings and tags persist to the DB via PATCH, which the server rejects
// for share tokens — so the tagging controls are hidden in a shared view.
const READ_ONLY = isSharedView();

export type TaggingPatch = { rating?: number; tags?: string[]; description?: string | null };

/** The open photo's rating, tags and description: what is shown, how a change is saved, and the 0-5 shortcut keys. */
export const useViewerTagging = (photo: PhotoItem | null, editMode: boolean) => {
  const meta = photo?.metadata;

  const currentRating =
    typeof meta?.rating === "number" && meta.rating > 0 ? meta.rating : 0;
  const currentTags = useMemo(
    () => (Array.isArray(meta?.tags) ? (meta.tags as string[]) : []),
    [meta?.tags],
  );

  // Optimistically apply a tagging change to the selected item, then persist it.
  // The override survives grid re-pushes; a rejected save puts the previous
  // value back and shows metadataSaveError.
  const { save: saveMetadata, error: metadataSaveError } = useMetadataSave();
  const persistTagging = useCallback(
    (patch: TaggingPatch) => {
      const path = photo?.path;
      if (!path) return;
      const shown: PhotoMetadataOverride = {};
      const previous: PhotoMetadataOverride = {};
      if (patch.rating !== undefined) {
        shown.rating = patch.rating > 0 ? patch.rating : null;
        previous.rating = currentRating > 0 ? currentRating : null;
      }
      if (patch.tags !== undefined) {
        shown.tags = patch.tags;
        previous.tags = currentTags;
      }
      if (patch.description !== undefined) {
        shown.description = patch.description;
        previous.description = typeof meta?.description === "string" ? meta.description : null;
      }
      saveMetadata([{ path, patch, shown, previous }]);
    },
    [photo?.path, saveMetadata, currentRating, currentTags, meta?.description],
  );

  // Number keys 1–5 set the star rating, 0 clears it — quick tagging while
  // stepping through a slideshow. Ignored while typing in the label field.
  useEffect(() => {
    if (!photo || editMode || READ_ONLY) return;

    const handleRatingKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key >= "1" && e.key <= "5") {
        e.preventDefault();
        persistTagging({ rating: Number(e.key) });
      } else if (e.key === "0") {
        e.preventDefault();
        persistTagging({ rating: 0 });
      }
    };

    window.addEventListener("keydown", handleRatingKey);
    return () => window.removeEventListener("keydown", handleRatingKey);
  }, [photo, editMode, persistTagging]);

  return { currentRating, currentTags, persistTagging, saveMetadata, metadataSaveError };
};
