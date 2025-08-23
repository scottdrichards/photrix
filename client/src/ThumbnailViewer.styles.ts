import { makeStyles } from "@fluentui/react-components";

const spacing = "10px";
const circleSize = "15px";

export const useStyles = makeStyles({
  root: {
  display: "flex",
  flexDirection: "column",
  gap: spacing,
  position: "relative",
  flex: 1,
  minHeight: 0,
  },
  gallery: {
    width: "100%",
  height: "100%",
  overflowY: "auto",
    display: "flex",
    flexWrap: "wrap",
    alignContent: "flex-start",
    gap: spacing,
    padding: spacing,
    boxSizing: "border-box",
  },
  selectIndicator: {
    position: "absolute",
    top: spacing,
    left: spacing,
    width: circleSize,
    height: circleSize,
    borderRadius: "50%",
    border: "1px solid white",
  },
  sizeSlider: {
    position: "absolute",
    bottom: "50px",
    left: "50%",
    transform: "translate(-50%, 0)",
    filter: "drop-shadow(0 0 6px rgba(0, 0, 0, .6))",
    zIndex: 2,
  },
  thumbnail: {
    "--ratio": "1",
    opacity: 1,
    objectFit: "cover",
    // This section is to make the height of a row magically adjust so that
    // the thumbnails each retain their aspect ratio but fill the available space.
    minHeight: "var(--size)",
    maxHeight: "calc(1.5 * var(--size))",
    minWidth: `calc(min(100%, calc(var(--size) * var(--ratio))))`,
    flexBasis: "calc(var(--size) * var(--ratio))",
    flex: "var(--ratio)",
    backgroundColor: "blue",
    
    borderRadius: "10px",
    overflow:"hidden",
    "&:hover": {
      boxShadow: "0 0 0 3px #225b86ff",
      zIndex: 1,
    }
  },
});
