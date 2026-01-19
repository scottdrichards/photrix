import {
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { PlayCircle24Regular } from "@fluentui/react-icons";
import type { CSSProperties } from "react";
import { memo, useEffect, useRef, useState } from "react";
import type { PhotoItem } from "../api";

type TileStyle = CSSProperties & {
  "--ratio"?: string;
};

const DEFAULT_RATIO = 1;

const useStyles = makeStyles({
  grid: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "stretch",
    gap: tokens.spacingHorizontalM,
    paddingBlockEnd: tokens.spacingHorizontalXXL,
    "--thumbnail-size": "clamp(150px, 20vw, 260px)",
  },
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
  sentinel: {
    flexBasis: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: tokens.spacingHorizontalL,
    color: tokens.colorNeutralForeground3,
  },
});

export interface ThumbnailGridProps {
  items: PhotoItem[];
  onSelect: (photo: PhotoItem) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}

const ThumbnailTile = ({
  photo,
  onSelect,
  styles,
}: {
  photo: PhotoItem;
  onSelect: (photo: PhotoItem) => void;
  styles: ReturnType<typeof useStyles>;
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [loadedRatio, setLoadedRatio] = useState<number | null>(null);
  const metadataRatio = getAspectRatio(photo);
  const ratio = loadedRatio ?? metadataRatio;

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
      className={styles.tile}
      style={createTileStyle(ratio)}
      onClick={() => onSelect(photo)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      aria-label={photo.name}
    >
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
            onLoad={handleImageLoad}
          />
          {isHovered && (
            <video
              src={photo.videoPreviewUrl}
              className={styles.image}
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
          src={photo.thumbnailUrl}
          alt={photo.name}
          loading="lazy"
          className={styles.image}
          onLoad={handleImageLoad}
        />
      )}
    </button>
  );
};

const ThumbnailGridComponent = ({
  items,
  onSelect,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
}: ThumbnailGridProps) => {
  const styles = useStyles();
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMore || !onLoadMore) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            onLoadMore();
          }
        });
      },
      { root: null, rootMargin: "25%" },
    );

    const node = sentinelRef.current;
    if (node) {
      observer.observe(node);
    }

    return () => observer.disconnect();
  }, [hasMore, onLoadMore]);

  if (!items.length) {
    return <p>No photos yet. Upload some to get started.</p>;
  }

  return (
    <div className={styles.grid}>
      {items.map((photo) => (
        <ThumbnailTile
          key={photo.path}
          photo={photo}
          onSelect={onSelect}
          styles={styles}
        />
      ))}
      {(hasMore || loadingMore) && (
        <div ref={sentinelRef} className={styles.sentinel}>
          {loadingMore ? <Spinner size="extra-tiny" /> : null}
        </div>
      )}
    </div>
  );
};

export const ThumbnailGrid = memo(ThumbnailGridComponent);
const createTileStyle = (ratio: number): TileStyle => ({
  "--ratio": ratio.toString(),
});

const getAspectRatio = (photo: PhotoItem): number => {
  // Server now provides post-rotation dimensions, so no need to check orientation
  const width = toFiniteNumber(photo.metadata?.dimensionWidth);
  const height = toFiniteNumber(photo.metadata?.dimensionHeight);

  if (width && height) {
    return clampRatio(width / height);
  }

  return DEFAULT_RATIO;
};

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

const clampRatio = (value: number): number => Math.min(Math.max(value, 0.25), 4);