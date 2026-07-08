import { Dismiss24Regular, Share24Regular } from "@fluentui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { ShareOptionsModal } from "./ShareOptionsModal";
import { useSelectionContext } from "./selection/SelectionContext";
import css from "./ViewToggle.module.css";

type ViewToggleProps = {
  view: "library" | "people";
  onViewChange: (view: "library" | "people") => void;
};

export const ViewToggle = ({ view, onViewChange }: ViewToggleProps) => {
  const [hidden, setHidden] = useState(false);
  const [stickyTop, setStickyTop] = useState(0);
  const [showShareModal, setShowShareModal] = useState(false);
  const lastScrollY = useRef(0);
  const { selectionMode, checkedPaths, exitSelectionMode, items } = useSelectionContext();

  const selectedPhotos = useMemo(
    () => items.filter((item) => checkedPaths.has(item.path)),
    [items, checkedPaths],
  );

  useEffect(() => {
    const header = document.querySelector("header");
    if (header) setStickyTop(header.getBoundingClientRect().height);
  }, []);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      if (y < 10) setHidden(false);
      else if (y > lastScrollY.current) setHidden(true);
      else setHidden(false);
      lastScrollY.current = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      {showShareModal && (
        <ShareOptionsModal
          photos={selectedPhotos}
          onClose={() => setShowShareModal(false)}
        />
      )}
      <div
        className={
          hidden ? `${css.toggleWrapper} ${css.toggleWrapperHidden}` : css.toggleWrapper
        }
        style={{ top: stickyTop }}
      >
        {selectionMode ? (
          <div className={css.selectionBar}>
            <span className={css.selectionCount}>{checkedPaths.size} selected</span>
            <button
              className="btn btn-subtle"
              onClick={() => setShowShareModal(true)}
              disabled={checkedPaths.size === 0}
            >
              <Share24Regular fontSize={18} />
              Share
            </button>
            <button className="btn btn-subtle" onClick={exitSelectionMode}>
              <Dismiss24Regular fontSize={18} />
              Clear
            </button>
          </div>
        ) : (
          <div className={css.toggleContainer} role="tablist" aria-label="Current view">
            <div className={css.toggleTrack}>
              <div className={css.toggleSlider} data-active={view} />
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
