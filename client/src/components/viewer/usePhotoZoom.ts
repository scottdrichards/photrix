import { useCallback, useEffect, useState } from "react";

const PHOTO_ZOOM_DEFAULT_SCALE = 2.5;
const PHOTO_ZOOM_MIN_SCALE = 1;
const PHOTO_ZOOM_MAX_SCALE = 6;
const PHOTO_ZOOM_STEP = 0.25;

const UNZOOMED = {
  isZoomed: false,
  originXPercent: 50,
  originYPercent: 50,
  scale: PHOTO_ZOOM_DEFAULT_SCALE,
};

/**
 * Click-to-zoom and wheel-to-scale for the edit preview. Zoom resets when the
 * viewer moves to another photo, and is ignored while a crop is being drawn.
 */
export const usePhotoZoom = (photoPath: string | null, cropActive: boolean) => {
  const [photoZoom, setPhotoZoom] = useState(UNZOOMED);

  useEffect(() => {
    setPhotoZoom(UNZOOMED);
  }, [photoPath]);

  const collapseZoom = useCallback(() => {
    setPhotoZoom((z) => ({ ...z, isZoomed: false }));
  }, []);

  const handlePhotoClick = (e: React.MouseEvent<HTMLElement>) => {
    if (cropActive) return;
    if (photoZoom.isZoomed) {
      collapseZoom();
      return;
    }

    const bounds = e.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) {
      return;
    }

    const originXPercent = ((e.clientX - bounds.left) / bounds.width) * 100;
    const originYPercent = ((e.clientY - bounds.top) / bounds.height) * 100;

    setPhotoZoom({
      isZoomed: true,
      originXPercent: Math.min(Math.max(originXPercent, 0), 100),
      originYPercent: Math.min(Math.max(originYPercent, 0), 100),
      scale: PHOTO_ZOOM_DEFAULT_SCALE,
    });
  };

  const handlePhotoWheel = (e: React.WheelEvent<HTMLElement>) => {
    if (cropActive || !photoZoom.isZoomed) {
      return;
    }

    setPhotoZoom((current) => {
      const direction = e.deltaY < 0 ? 1 : -1;
      const nextScale = Math.min(
        PHOTO_ZOOM_MAX_SCALE,
        Math.max(PHOTO_ZOOM_MIN_SCALE, current.scale + direction * PHOTO_ZOOM_STEP),
      );
      return {
        ...current,
        scale: nextScale,
        isZoomed: nextScale > PHOTO_ZOOM_MIN_SCALE,
      };
    });
  };

  const zoomStyle = {
    "--zoom-origin-x": `${photoZoom.originXPercent}%`,
    "--zoom-origin-y": `${photoZoom.originYPercent}%`,
    "--zoom-scale": photoZoom.isZoomed ? photoZoom.scale.toString() : "1",
    "--zoom-cursor": cropActive ? "default" : photoZoom.isZoomed ? "zoom-out" : "zoom-in",
    // Counter-scale for face labels: they must stay a fixed screen size while
    // the photo (and their own anchor position) zooms in, otherwise a crowded
    // photo becomes *harder* to read the more you zoom in on it.
    "--label-counter-scale": photoZoom.isZoomed ? (1 / photoZoom.scale).toString() : "1",
  } as React.CSSProperties;

  return {
    isZoomed: photoZoom.isZoomed,
    zoomStyle,
    collapseZoom,
    handlePhotoClick,
    handlePhotoWheel,
  };
};
