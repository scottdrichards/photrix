import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import { cx } from "./cx";
import css from "./App.module.css";
import { FullscreenViewer } from "./components/FullscreenViewer";
import { StatusModal } from "./components/StatusModal";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { Filter } from "./components/filter/Filter";
import { FilterProvider } from "./components/filter/FilterContext";
import {
  SelectionProvider,
  useSelectionContext,
} from "./components/selection/SelectionContext";
import { probeVideoPlaybackProfile } from "./videoPlaybackProfile";

const AppContent = () => {
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const { clearSelection, selectedItems, selectionMode, setSelectionMode } =
    useSelectionContext();

  useEffect(() => {
    void probeVideoPlaybackProfile();
  }, []);

  const canUseNativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";
  const supportsFileShare = (() => {
    if (!canUseNativeShare || typeof navigator.canShare !== "function") {
      return false;
    }

    try {
      return navigator.canShare({
        files: [new File([""], "share-check.txt", { type: "text/plain" })],
      });
    } catch {
      return false;
    }
  })();

  const handleSelectionModeChange = (nextSelectionMode: boolean) => {
    setSelectionMode(nextSelectionMode);
    clearSelection();
  };

  const handleShare = async () => {
    if (
      !canUseNativeShare ||
      !supportsFileShare ||
      selectedItems.length === 0 ||
      isSharing
    ) {
      return;
    }

    try {
      setIsSharing(true);
      const files = await Promise.all(
        selectedItems.map(async (item) => {
          const response = await fetch(item.originalUrl);
          if (!response.ok) {
            throw new Error(
              `Failed to fetch file for sharing (status ${response.status})`,
            );
          }

          const blob = await response.blob();
          const mimeType = blob.type || item.metadata?.mimeType || undefined;
          return mimeType
            ? new File([blob], item.name, { type: mimeType })
            : new File([blob], item.name);
        }),
      );

      if (!navigator.canShare({ files })) {
        throw new Error("Native share does not support the selected files");
      }

      await navigator.share({
        files,
        title: files.length === 1 ? files[0].name : `${files.length} items from Photrix`,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      console.error("Native share failed", error);
    } finally {
      setIsSharing(false);
    }
  };

  return (
    <div className={css.app}>
      <header className={cx(css.header, isStatusOpen ? css.headerStatusOpen : undefined)}>
        <div className={css.headerTitle}>
          <h2>Photrix</h2>
          <small>A better way to view photos.</small>
        </div>

        <div className={css.headerActions}>
          <Filter />
          {selectionMode ? (
            <>
              <small>{selectedItems.length} selected</small>
              <button
                onClick={handleShare}
                className="btn btn-primary"
                disabled={
                  !canUseNativeShare ||
                  !supportsFileShare ||
                  selectedItems.length === 0 ||
                  isSharing
                }
              >
                {isSharing ? "Preparing…" : "Share"}
              </button>
              <button
                onClick={() => handleSelectionModeChange(false)}
                className="btn btn-subtle"
              >
                Done
              </button>
            </>
          ) : (
            <button
              onClick={() => handleSelectionModeChange(true)}
              className="btn btn-subtle"
            >
              Select
            </button>
          )}
          <button
            title="Server Status"
            className="btn btn-subtle"
            onClick={() => setIsStatusOpen(true)}
          >
            <Info size={20} />
            Status
          </button>
        </div>
      </header>

      <StatusModal isOpen={isStatusOpen} onDismiss={() => setIsStatusOpen(false)} />

      <ThumbnailGrid />
      <FullscreenViewer />
    </div>
  );
};

export default function App() {
  return (
    <FilterProvider>
      <SelectionProvider>
        <AppContent />
      </SelectionProvider>
    </FilterProvider>
  );
}
