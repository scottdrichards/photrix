import { ArrowDownload24Regular, Dismiss24Regular, Share24Regular } from "@fluentui/react-icons";
import { useMemo, useState } from "react";
import { ShareOptionsModal } from "./ShareOptionsModal";
import { useSelectionContext } from "./selection/SelectionContext";
import css from "./ViewToggle.module.css";

type ViewToggleProps = {
  view: "library" | "people";
  onViewChange: (view: "library" | "people") => void;
};

// Feedback #121/#122/#123/#127: this used to hide on scroll-down and
// reappear on any scroll-up (not just reaching the top), so it could pop
// back over a photo anywhere in a long grid. It now lives in a bar fixed to
// the bottom of the viewport, shown only near the top of the page — see
// App.tsx's `nearTop` and .floatingBarDock/.floatingBarDockHidden in
// App.module.css. The show/hide lives one level up (in the shared dock, not
// per-component) so it applies uniformly whether this renders alongside
// SortControl or on its own.
export const ViewToggle = ({ view, onViewChange }: ViewToggleProps) => {
  const [exportMode, setExportMode] = useState<"share" | "download" | null>(null);
  const { selectionMode, checkedPaths, exitSelectionMode, items } = useSelectionContext();

  const selectedPhotos = useMemo(
    () => items.filter((item) => checkedPaths.has(item.path)),
    [items, checkedPaths],
  );

  return (
    <>
      {exportMode && (
        <ShareOptionsModal
          photos={selectedPhotos}
          mode={exportMode}
          onClose={() => setExportMode(null)}
        />
      )}
      <div className={css.toggleWrapper}>
        {selectionMode ? (
          <div className={css.selectionBar}>
            <span className={css.selectionCount}>{checkedPaths.size} selected</span>
            <button
              className="btn btn-subtle"
              onClick={() => setExportMode("share")}
              disabled={checkedPaths.size === 0}
            >
              <Share24Regular fontSize={18} />
              Share
            </button>
            <button
              className="btn btn-subtle"
              onClick={() => setExportMode("download")}
              disabled={checkedPaths.size === 0}
            >
              <ArrowDownload24Regular fontSize={18} />
              Download
            </button>
            <button className="btn btn-subtle" onClick={exitSelectionMode}>
              <Dismiss24Regular fontSize={18} />
              Clear
            </button>
          </div>
        ) : (
          <div className={css.toggleContainer} role="tablist" aria-label="Current view">
            <div className={css.toggleTrack}>
              <div
                className={css.toggleSlider}
                data-active={view}
              />
              <button
                type="button"
                className={css.toggleButton}
                onClick={() => onViewChange("library")}
                role="tab"
                aria-selected={view === "library"}
              >
                Thumbnails
              </button>
              <button
                type="button"
                className={css.toggleButton}
                onClick={() => onViewChange("people")}
                role="tab"
                aria-selected={view === "people"}
              >
                People
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
};
