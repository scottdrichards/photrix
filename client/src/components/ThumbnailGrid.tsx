import { makeStyles, shorthands, tokens } from "@fluentui/react-components";
import { memo } from "react";
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
});

export interface ThumbnailGridProps {
  items: PhotoItem[];
  onSelect: (photo: PhotoItem) => void;
}

const ThumbnailGridComponent = ({ items, onSelect }: ThumbnailGridProps) => {
  const styles = useStyles();

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
    </div>
  );
};

export const ThumbnailGrid = memo(ThumbnailGridComponent);
