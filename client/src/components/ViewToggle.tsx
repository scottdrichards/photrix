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
//
// Feedback #142: this used to swap to a "N selected / Share / Download /
// Clear" bar during selection mode — a second, independent floating pill
// duplicating the "N selected" count SelectionActionBar already shows, with
// its own Share/Download/exit actions living apart from that bar's
// rating/tag ones. Selection actions now live in exactly one place
// (SelectionActionBar); this component just keeps showing the ordinary
// Thumbnails/People toggle regardless of selection mode.
export const ViewToggle = ({ view, onViewChange }: ViewToggleProps) => {
  return (
    <div className={css.toggleWrapper}>
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
    </div>
  );
};
