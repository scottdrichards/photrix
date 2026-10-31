import "ol/ol.css";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";

export const markerStyle = new Style({
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({ color: "#2b6cb0" }),
    stroke: new Stroke({ color: "#f3f6fb", width: 1.25 }),
  }),
});

// One Style per colour, reused across redraws: OpenLayers calls the layer's
// style function for every feature on every frame, so allocating there would
// churn a Style per pin per pan.
const styleByColor = new Map<string, Style>();

/** Pin style for an age-ramp colour, memoised by colour. */
export const markerStyleFor = (color: string | undefined): Style => {
  if (!color) return markerStyle;
  const cached = styleByColor.get(color);
  if (cached) return cached;
  const style = new Style({
    image: new CircleStyle({
      radius: 5,
      fill: new Fill({ color }),
      stroke: new Stroke({ color: "#f3f6fb", width: 1.25 }),
    }),
  });
  styleByColor.set(color, style);
  return style;
};

/**
 * The chronological movement path. Drawn under the pins in a translucent warm
 * tone so it reads as an annotation over the map tiles rather than competing
 * with the cool age ramp used for the pins themselves.
 */
export const movementPathStyle = new Style({
  stroke: new Stroke({
    color: "rgba(214, 93, 14, 0.75)",
    width: 2,
    lineDash: [6, 4],
  }),
});
