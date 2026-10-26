import { useRef } from "react";
import type { PersonCluster } from "../../api";
import { isSharedView } from "../../hooks/useShareFilter";
import css from "../PeopleView.module.css";
import { FaceImage } from "./FaceThumb";
import { InlineNameEditor } from "./InlineNameEditor";

const READ_ONLY = isSharedView();

type ClusterCardProps = {
  cluster: PersonCluster;
  isSelected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onLongPress: () => void;
  onToggleSelect: () => void;
  onRename: (name: string | null) => void;
};

export const ClusterCard = ({
  cluster,
  isSelected,
  onClick,
  onLongPress,
  onToggleSelect,
  onRename,
}: ClusterCardProps) => {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handlePointerDown = () => {
    // Selection exists only to pick people for merging, which read-only share
    // views can't do — so skip it entirely.
    if (READ_ONLY) return;
    longPressTimer.current = setTimeout(() => {
      onLongPress();
    }, 500);
  };

  const handlePointerUp = () => {
    clearTimeout(longPressTimer.current);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (READ_ONLY) return;
    e.preventDefault();
    onToggleSelect();
  };

  return (
    <div
      className={`${css.clusterCard} ${isSelected ? css.clusterCardSelected : ""}`}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        className={css.clusterButton}
        onClick={onClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        aria-pressed={isSelected}
      >
        <div className={css.clusterFaceWrap}>
          <FaceImage face={cluster.representative} className={css.clusterFaceImage} />
          {isSelected && <div className={css.selectedOverlay}>✓</div>}
        </div>
        <span className={css.clusterCount}>{cluster.count} faces</span>
      </button>
      <InlineNameEditor name={cluster.name} onSave={onRename} />
    </div>
  );
};
