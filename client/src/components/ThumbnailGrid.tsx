import { Spinner, makeStyles, shorthands, tokens } from "@fluentui/react-components";
import { memo, useEffect, useRef } from "react";
import type { PhotoItem } from "../api";

const useStyles = makeStyles({
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: tokens.spacingHorizontalM,
    paddingBlockEnd: tokens.spacingHorizontalXXL,
  },
  tile: {
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    ...shorthands.overflow("hidden"),
    position: "relative",
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    transitionProperty: "transform, box-shadow",
    transitionDuration: tokens.durationUltraFast,
    transitionTimingFunction: tokens.curveAccelerateMid,
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
    aspectRatio: "4 / 3",
    objectFit: "cover",
    backgroundColor: tokens.colorNeutralBackground4,
  },
  caption: {
    padding: tokens.spacingHorizontalS,
    textAlign: "center",
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightRegular,
    color: tokens.colorNeutralForeground1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  sentinel: {
    gridColumn: "1 / -1",
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
      { root: null, rootMargin: "25%" }
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
        <button
          key={photo.path}
          type="button"
          className={styles.tile}
          onClick={() => onSelect(photo)}
        >
          <img
            src={photo.thumbnailUrl}
            alt={photo.name}
            loading="lazy"
            className={styles.image}
          />
          <span className={styles.caption}>{photo.name}</span>
        </button>
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
