import {
    makeStyles,
    tokens
} from "@fluentui/react-components";
import "ol/ol.css";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";

export const useMapFilterStyles = makeStyles({
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    flexWrap: "wrap",
  },
  description: {
    color: tokens.colorNeutralForeground3,
  },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    flexWrap: "wrap",
  },
  mapShell: {
    position: "relative",
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  map: {
    width: "100%",
    height: "340px",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${tokens.colorNeutralBackground1}CC`,
  },
  statusRow: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    flexWrap: "wrap",
    color: tokens.colorNeutralForeground3,
  },
  error: {
    color: tokens.colorPaletteRedForeground3,
  },
});

export const markerStyle = new Style({
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({ color: "#2b6cb0" }),
    stroke: new Stroke({ color: "#f3f6fb", width: 1.25 }),
  }),
});