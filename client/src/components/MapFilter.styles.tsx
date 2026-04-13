import "ol/ol.css";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";

export const markerStyle = new Style({
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({ color: "#2b6cb0" }),
    stroke: new Stroke({ color: "#f3f6fb", width: 1.25 }),
  }),
});
