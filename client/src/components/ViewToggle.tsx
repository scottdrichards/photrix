import css from "./ViewToggle.module.css";

type ViewToggleProps = {
  view: "library" | "people";
  onViewChange: (view: "library" | "people") => void;
};

export const ViewToggle = ({ view, onViewChange }: ViewToggleProps) => {
  return (
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
  );
};
