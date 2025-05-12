import { makeStyles } from "@fluentui/react-components";

const spacing = "10px";
const circleSize = "15px";

export const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: spacing,
    position: "relative",
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
    opacity: 1,
    minHeight: "var(--size)",
    minWidth: `calc(min(100%, var(--size) * var(--ratio)))`,
    flexBasis: "calc(var(--size) * var(--ratio))",
    flex: "var(--ratio)",
    borderRadius: "10px",
    overflow:"hidden",
    filter: "drop-shadow(0 5px 2px rgba(0, 0, 0, .3))",
    transition: "transform 0.1s ease-in-out, filter 0.1s ease-in-out",
    "&:hover": {
      filter: "drop-shadow(0 5px 3px rgba(0, 0, 0, .4))",
      transform: "scale(1.05)",
      zIndex: 1,
    },
  }
});
