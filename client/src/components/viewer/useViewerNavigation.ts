import { useEffect, useState } from "react";
import type { PhotoItem } from "../../api";

const SWIPE_THRESHOLD_PX = 60;

/**
 * Moving between photos: arrow keys, Escape, and the touch swipe that backs up
 * the carousel for video, live photos and editing. Also reports where the open
 * photo sits in the grid so the prev/next buttons and carousel know their neighbours.
 */
export const useViewerNavigation = ({
  photo,
  items,
  editMode,
  setEditMode,
  setSelected,
  selectNext,
  selectPrevious,
}: {
  photo: PhotoItem | null;
  items: PhotoItem[];
  editMode: boolean;
  setEditMode: (editMode: boolean) => void;
  setSelected: (photo: PhotoItem | null) => void;
  selectNext: () => void;
  selectPrevious: () => void;
}) => {
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!photo) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (editMode) {
          setEditMode(false);
        } else {
          setSelected(null);
        }
        return;
      }
      if (editMode) return;
      if (e.key === "ArrowRight") { e.preventDefault(); selectNext(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); selectPrevious(); }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [photo, editMode, setEditMode, selectNext, selectPrevious, setSelected]);

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.changedTouches[0];
    setTouchStart({ x: touch.clientX, y: touch.clientY });
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!touchStart) {
      return;
    }

    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = touch.clientY - touchStart.y;
    setTouchStart(null);

    const isHorizontalSwipe = Math.abs(deltaX) > Math.abs(deltaY);
    if (!isHorizontalSwipe || Math.abs(deltaX) < SWIPE_THRESHOLD_PX) {
      return;
    }

    if (deltaX < 0) {
      selectNext();
      return;
    }

    selectPrevious();
  };

  const currentIndex = photo ? items.findIndex((item) => item.path === photo.path) : -1;
  const prevPhoto = currentIndex > 0 ? items[currentIndex - 1] : null;
  const nextPhoto =
    currentIndex >= 0 && currentIndex < items.length - 1 ? items[currentIndex + 1] : null;

  return { handleTouchStart, handleTouchEnd, currentIndex, prevPhoto, nextPhoto };
};
