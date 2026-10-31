import type { ClusterFace } from "../../api";
import { FaceCropImage } from "./FaceCropImage";
import css from "./PeopleView.module.css";

type FaceImageProps = {
  face: ClusterFace;
  className: string;
  /**
   * Feedback #134: the match-group / suggested-match crops sit above the "All
   * faces" grid and are only a handful, but they used to queue behind (and
   * compete for the browser's per-host connection cap and the server's crop
   * decode with) up to a page of grid thumbnails that all start at once, so
   * the small, important section painted last. "high" fetches eagerly at high
   * priority; the grid passes "low".
   */
  priority?: "high" | "low";
};

export const FaceImage = ({ face, className, priority }: FaceImageProps) => (
  <FaceCropImage
    face={face}
    alt={face.photo.name}
    className={className}
    loading={priority === "high" ? "eager" : "lazy"}
    fetchPriority={priority}
    decoding="async"
  />
);

type FaceThumbProps = {
  face: ClusterFace;
  label: string;
  onClick: () => void;
  /** feedback #90 — omitted (e.g. in a shared view) hides the exclude affordance. */
  onExclude?: () => void;
  excluding?: boolean;
};

// Not a <button> at the root: the exclude control below has to be a real
// nested <button>, and interactive content can't nest inside <button> (some
// browsers silently break the click). A div with the same role/keyboard
// handling stays accessible without that trap.
export const FaceThumb = ({ face, label, onClick, onExclude, excluding }: FaceThumbProps) => (
  <div
    role="button"
    tabIndex={0}
    className={css.faceThumbButton}
    onClick={onClick}
    onKeyDown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    }}
    aria-label={label}
  >
    <div className={css.faceThumbViewport}>
      <FaceImage face={face} className={css.faceThumbImage} priority="low" />
      {onExclude && (
        <button
          type="button"
          className={css.faceThumbExclude}
          aria-label="This isn't the right person — remove from this group"
          title="This isn't the right person — remove from this group"
          disabled={excluding}
          onClick={(e) => {
            e.stopPropagation();
            onExclude();
          }}
        >
          {excluding ? "…" : "✕"}
        </button>
      )}
    </div>
  </div>
);
