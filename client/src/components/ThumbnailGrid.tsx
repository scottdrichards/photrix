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

const DEFAULT_RATIO = 4 / 3;

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
      transform: "translateY(-2px)",
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
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (isHovered && videoRef.current) {
      videoRef.current.play().catch(() => {
        // Ignore play errors (e.g. if user interacted with document yet)
      });
    } else if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
      videoRef.current.load();
    }
  }, [isHovered]);

  return (
    <button
      type="button"
      className={styles.tile}
      style={createTileStyle(photo)}
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
          <video
            ref={videoRef}
            src={photo.videoPreviewUrl}
            className={styles.image}
            muted
            loop
            playsInline
            preload="none"
            poster={photo.thumbnailUrl}
          />
        </>
      ) : (
        <img
          src={photo.thumbnailUrl}
          alt={photo.name}
          loading="lazy"
          className={styles.image}
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
const createTileStyle = (photo: PhotoItem): TileStyle => {
  const ratio = getAspectRatio(photo);
  return {
    "--ratio": ratio.toString(),
  };
};

const getAspectRatio = (photo: PhotoItem): number => {
  const width = photo.metadata?.dimensionWidth;
  const height = photo.metadata?.dimensionHeight;
  if (
    typeof width === "number" &&
    width > 0 &&
    typeof height === "number" &&
    height > 0 &&
    Number.isFinite(width / height)
  ) {
    const ratio = width / height;
    return Math.min(Math.max(ratio, 0.25), 4);
  }
  return DEFAULT_RATIO;
};

