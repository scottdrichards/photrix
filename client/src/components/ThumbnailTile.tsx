import { CheckCircle, Film, PlayCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PhotoItem } from "../api";
import { useSelectionContext } from "./selection/SelectionContext";
import css from "./ThumbnailTile.module.css";

const DEFAULT_RATIO = 1;
const LONG_PRESS_MS = 450;
const RATIO_MISMATCH_LOG_THRESHOLD = 0.01;
const clampRatio = (value: number): number => Math.min(Math.max(value, 0.25), 4);

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const getAspectRatio = (photo: PhotoItem): number => {
  const width = toFiniteNumber(photo.metadata?.dimensionWidth);
  const height = toFiniteNumber(photo.metadata?.dimensionHeight);

  if (width && height) {
    return clampRatio(width / height);
  }

  return DEFAULT_RATIO;
};

type Props = {
  photo: PhotoItem;
};

export const ThumbnailTile: React.FC<Props> = (props) => {
  const { photo } = props;
  const tileRef = useRef<HTMLButtonElement | null>(null);
  const supportsIntersectionObserver = typeof IntersectionObserver !== "undefined";
  const [isNearViewport, setIsNearViewport] = useState(!supportsIntersectionObserver);
  const [canRequestThumbnail, setCanRequestThumbnail] = useState(!supportsIntersectionObserver);
  const [isHovered, setIsHovered] = useState(false);
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  const [loadedRatio, setLoadedRatio] = useState<number | null>(null);
  const { isSelected, selectionMode, setSelected, setSelectionMode, toggleSelected } =
    useSelectionContext();
  const longPressTimeoutRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);
  const metadataRatio = getAspectRatio(photo);
  const ratio = loadedRatio ?? metadataRatio;
  const selected = isSelected(photo.path);

  useEffect(() => {
    return () => {
      if (longPressTimeoutRef.current) {
        window.clearTimeout(longPressTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setIsImageLoaded(false);
  }, [photo.thumbnailUrl]);

  useEffect(() => {
    if (!supportsIntersectionObserver) {
      setIsNearViewport(true);
      setCanRequestThumbnail(true);
      return;
    }

    const tile = tileRef.current;
    if (!tile) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(({ isIntersecting }) => {
          setIsNearViewport(isIntersecting);
          if (isIntersecting) {
            setCanRequestThumbnail(true);
          }
        });
      },
      { rootMargin: "300px" },
    );

    observer.observe(tile);
    return () => {
      observer.disconnect();
    };
  }, [supportsIntersectionObserver]);

  const clearLongPressTimeout = () => {
    if (!longPressTimeoutRef.current) {
      return;
    }

    window.clearTimeout(longPressTimeoutRef.current);
    longPressTimeoutRef.current = null;
  };

  const handleClick = () => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }

    if (selectionMode) {
      toggleSelected(photo);
      return;
    }

    setSelected(photo);
  };

  const handleTouchStart = () => {
    if (selectionMode) {
      return;
    }

    clearLongPressTimeout();
    longPressTimeoutRef.current = window.setTimeout(() => {
      suppressNextClickRef.current = true;
      setSelectionMode(true);
      setSelected(photo);
      longPressTimeoutRef.current = null;
    }, LONG_PRESS_MS);
  };

  const handleTouchEnd = () => {
    clearLongPressTimeout();
  };

  const handleTouchMove = () => {
    clearLongPressTimeout();
  };

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setIsImageLoaded(true);
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight) {
      const actualRatio = clampRatio(img.naturalWidth / img.naturalHeight);
      const ratioDeltaFromDisplayed = Math.abs(actualRatio - ratio);

      // Only update if significantly different from current ratio
      if (ratioDeltaFromDisplayed > RATIO_MISMATCH_LOG_THRESHOLD) {
        setLoadedRatio(actualRatio);
      }
    }
  };

  const loading = isNearViewport ? "eager" : "lazy";
  const fetchPriority = isNearViewport ? "high" : "low";
  const thumbnailUrl = canRequestThumbnail ? photo.thumbnailUrl : undefined;

  return (
    <button
      type="button"
      ref={tileRef}
      className={`${css.tile} ${selected ? css.tileSelected : ""}`}
      style={{ "--ratio": ratio.toString() } as React.CSSProperties}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onTouchMove={handleTouchMove}
      aria-label={photo.name}
      aria-pressed={selected}
    >
      {selected ? (
        <span className={css.selectedBadge} aria-hidden="true">
          <CheckCircle size={20} fill="currentColor" />
        </span>
      ) : null}
      {photo.livePhotoUrl && !selected ? (
        <span className={css.livePhotoBadge} aria-label="Live photo" title="Live photo">
          <Film size={14} />
        </span>
      ) : null}
      {photo.mediaType === "video" ? (
        <>
          <span className={css.videoBadge} aria-hidden="true">
            <PlayCircle size={24} />
          </span>
          <img
            src={thumbnailUrl}
            alt={photo.name}
            loading={loading}
            fetchPriority={fetchPriority}
            className={css.image}
            style={{ opacity: isImageLoaded ? 1 : 0, transition: "opacity 200ms ease-in" }}
            onLoad={handleImageLoad}
          />
          {isHovered && (
            <video
              src={photo.videoPreviewUrl}
              className={css.image}
              style={{ position: "absolute", top: 0, left: 0 }}
              muted
              loop
              playsInline
              autoPlay
            />
          )}
        </>
      ) : (
        <img
          src={thumbnailUrl}
          alt={photo.name}
          loading={loading}
          fetchPriority={fetchPriority}
          className={css.image}
          style={{ opacity: isImageLoaded ? 1 : 0, transition: "opacity 200ms ease-in" }}
          onLoad={handleImageLoad}
        />
      )}
    </button>
  );
};
