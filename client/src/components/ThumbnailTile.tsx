import { makeStyles, tokens } from "@fluentui/react-components";
import { CheckmarkCircle20Filled, PlayCircle24Regular } from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import type { PhotoItem } from "../api";
import { useSelectionContext } from "./selection/SelectionContext";

const DEFAULT_RATIO = 1;
const LONG_PRESS_MS = 450;
const clampRatio = (value: number): number => Math.min(Math.max(value, 0.25), 4);

const getAspectRatio = (photo: PhotoItem): number => {
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
  // Server now provides post-rotation dimensions, so no need to check orientation
  const width = toFiniteNumber(photo.metadata?.dimensionWidth);
  const height = toFiniteNumber(photo.metadata?.dimensionHeight);

  if (width && height) {
    return clampRatio(width / height);
  }

  return DEFAULT_RATIO;
};

const useStyles = makeStyles({
  tile: {
    borderRadius:tokens.borderRadiusMedium,
    overflow:"hidden",
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-start",
    cursor: "pointer",
    minHeight: "var(--thumbnail-size)",
    minWidth: "calc(min(100%, calc(var(--thumbnail-size) * var(--ratio))))",
    flexBasis: "calc(var(--thumbnail-size) * var(--ratio))",
    flexGrow: "var(--ratio)",
    flexShrink: 1,
    maxWidth: "min(100%, calc(var(--thumbnail-size) * var(--ratio) * 1.5))",
    transitionProperty: "transform, box-shadow",
    transitionDuration: tokens.durationUltraFast,
    transitionTimingFunction: tokens.curveAccelerateMid,
    backgroundColor: tokens.colorNeutralBackground4,
    border: "none",
    padding: 0,
    position: "relative",
    ":hover": {
      transform: "scale(1.02)",
      boxShadow: tokens.shadow16,
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorBrandBackground}`,
      outlineOffset: "2px",
    },
  },
  tileSelected: {
    boxShadow: `inset 0 0 0 2px ${tokens.colorBrandStroke1}`,
  },
  
  image: {
    width: "100%",
    height: "100%",
    display: "block",
    flexGrow: 1,
    objectFit: "cover",
  },
  caption: {
    display: "none",
  },
  videoBadge: {
    position: "absolute",
    top: tokens.spacingHorizontalXXS,
    right: tokens.spacingHorizontalXXS,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    borderRadius: tokens.borderRadiusCircular,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacingHorizontalXS,
    boxShadow: tokens.shadow4,
    opacity: 0.86,
    zIndex: 1,
  },
  selectedBadge: {
    position: "absolute",
    top: tokens.spacingHorizontalXXS,
    left: tokens.spacingHorizontalXXS,
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusCircular,
    zIndex: 2,
    display: "flex",
  },
});

type Props =  {
  photo: PhotoItem;
};

export const ThumbnailTile:React.FC<Props> = (props) => {
    const { photo } = props;
    const styles = useStyles();
  const [isHovered, setIsHovered] = useState(false);
  const [loadedRatio, setLoadedRatio] = useState<number | null>(null);
  const { isSelected, selectionMode, setSelected, setSelectionMode, toggleSelected } = useSelectionContext();
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
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight) {
      const actualRatio = clampRatio(img.naturalWidth / img.naturalHeight);
      // Only update if significantly different from current ratio
      if (Math.abs(actualRatio - ratio) > 0.01) {
        setLoadedRatio(actualRatio);
      }
    }
  };

  return (
    <button
      type="button"
      className={`${styles.tile} ${selected ? styles.tileSelected : ""}`}
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
        <span className={styles.selectedBadge} aria-hidden="true">
          <CheckmarkCircle20Filled />
        </span>
      ) : null}
      {photo.mediaType === "video" ? (
        <>
          <span className={styles.videoBadge} aria-hidden="true">
            <PlayCircle24Regular />
          </span>
          <img
            src={photo.thumbnailUrl}
            alt={photo.name}
            loading="lazy"
            className={styles.image}
            onLoad={handleImageLoad} />
          {isHovered && (
            <video
              src={photo.videoPreviewUrl}
              className={styles.image}
              style={{ position: "absolute", top: 0, left: 0 }}
              muted
              loop
              playsInline
              autoPlay />
          )}
        </>
      ) : (
        <img
          src={photo.thumbnailUrl}
          alt={photo.name}
          loading="lazy"
          className={styles.image}
          onLoad={handleImageLoad} />
      )}
    </button>
  );
};
