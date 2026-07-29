import { Dismiss24Regular, Share24Regular } from "@fluentui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { ShareOptionsModal } from "./ShareOptionsModal";
import { useSelectionContext } from "./selection/SelectionContext";
import css from "./ViewToggle.module.css";

type ViewToggleProps = {
  view: "library" | "people";
  onViewChange: (view: "library" | "people") => void;
};

// Below this scroll offset we treat the page as "at the top" and always
// show the pill anchored just under the header, regardless of direction.
const NEAR_TOP_THRESHOLD_PX = 24;

export const ViewToggle = ({ view, onViewChange }: ViewToggleProps) => {
  const [hidden, setHidden] = useState(false);
  const [anchorTop, setAnchorTop] = useState(0);
  const [showShareModal, setShowShareModal] = useState(false);
  const lastScrollYRef = useRef(0);
  const { selectionMode, checkedPaths, exitSelectionMode, items } = useSelectionContext();

  const selectedPhotos = useMemo(
    () => items.filter((item) => checkedPaths.has(item.path)),
    [items, checkedPaths],
  );

  useEffect(() => {
    const computeTopAnchor = () => {
      const header = document.querySelector("header");
      const headerHeight = header ? header.getBoundingClientRect().height : 0;
      return headerHeight + 12;
    };

    setAnchorTop(computeTopAnchor());

    const onScroll = () => {
      const y = window.scrollY;
      const previousY = lastScrollYRef.current;
      lastScrollYRef.current = y;

      if (y <= NEAR_TOP_THRESHOLD_PX) {
        setHidden(false);
        setAnchorTop(computeTopAnchor());
        return;
      }

      if (y > previousY) {
        // Scrolling down: hide completely (no layout or hit-test footprint).
        setHidden(true);
        return;
      }

      if (y < previousY) {
        // Scrolling up from further down the page: reappear roughly halfway
        // down the viewport rather than snapping back under the header.
        setHidden(false);
        setAnchorTop(Math.round(window.innerHeight / 2));
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
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
        className={hidden ? `${css.toggleWrapper} ${css.toggleWrapperHidden}` : css.toggleWrapper}
        style={{ top: anchorTop }}
        aria-hidden={hidden}
      >
        {selectionMode ? (
          <div className={css.selectionBar}>
            <span className={css.selectionCount}>{checkedPaths.size} selected</span>
            <button
              className="btn btn-subtle"
              onClick={() => setShowShareModal(true)}
              disabled={checkedPaths.size === 0}
              tabIndex={hidden ? -1 : 0}
            >
              <Share24Regular fontSize={18} />
              Share
            </button>
            <button
              className="btn btn-subtle"
              onClick={exitSelectionMode}
              tabIndex={hidden ? -1 : 0}
            >
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
                tabIndex={hidden ? -1 : 0}
              >
                Thumbnails
              </button>
              <button
                type="button"
                className={css.toggleButton}
                onClick={() => onViewChange("people")}
                role="tab"
                aria-selected={view === "people"}
                tabIndex={hidden ? -1 : 0}
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
