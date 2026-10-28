import { useCallback, useState } from "react";
import { updatePhotoMetadata, type PhotoMetadataPatch } from "../../api";
import { logFailure } from "../../logFailure";
import { attempt } from "../../result";
import { useSelectionContext, type PhotoMetadataOverride } from "./SelectionContext";

export type MetadataChange = {
  path: string;
  patch: PhotoMetadataPatch;
  /** What the grid and viewer show at once, before the server answers. */
  shown: PhotoMetadataOverride;
  /** What they go back to if the server rejects the change. */
  previous: PhotoMetadataOverride;
};

/**
 * Saves photo metadata optimistically: the change shows at once, and if the
 * server rejects it the previous values come back and `error` says so — rather
 * than the edit quietly vanishing at the next refetch.
 */
export const useMetadataSave = () => {
  const { applyMetadataOverride } = useSelectionContext();
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    (changes: MetadataChange[]) => {
      setError(null);
      for (const { path, shown } of changes) applyMetadataOverride([path], shown);
      void Promise.all(
        changes.map(async ({ path, patch, previous }) => {
          const saved = await attempt(updatePhotoMetadata(path, patch));
          if (saved.ok) return true;
          applyMetadataOverride([path], previous);
          logFailure("metadata.save.failed", "Saving photo metadata failed")(saved.error);
          return false;
        }),
      ).then((results) => {
        const failed = results.filter((ok) => !ok).length;
        if (failed === 0) return;
        setError(
          results.length === 1
            ? "Couldn't save that change"
            : `Couldn't save ${failed} of ${results.length} changes`,
        );
      });
    },
    [applyMetadataOverride],
  );

  return { save, error };
};
