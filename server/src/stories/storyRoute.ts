import { haversineKm } from "./geo.ts";
import type { StoryItem } from "./storyTypes.ts";

/** Stops closer than this to the previous one are the same stop. */
const SAME_STOP_KM = 1.5;
const MAX_ROUTE_POINTS = 80;

/**
 * The path a story took, from its geotagged items in time order: nearby fixes
 * collapse into one stop, the distance sums the hops between stops, and the
 * polyline is thinned to at most MAX_ROUTE_POINTS (first and last kept).
 */
export const storyRoute = (items: StoryItem[]) => {
  const stops: Array<{ lat: number; lon: number }> = [];
  let distanceKm = 0;
  for (const { lat, lon } of items) {
    if (lat === null || lon === null) continue;
    const last = stops.at(-1);
    const hop = last ? haversineKm(last.lat, last.lon, lat, lon) : Infinity;
    if (hop < SAME_STOP_KM) continue;
    if (last) distanceKm += hop;
    stops.push({ lat, lon });
  }
  const step = Math.max(1, (stops.length - 1) / (MAX_ROUTE_POINTS - 1));
  const route =
    stops.length <= MAX_ROUTE_POINTS
      ? stops
      : Array.from({ length: MAX_ROUTE_POINTS }, (_, i) => stops[Math.round(i * step)]);
  return { route, distanceKm: stops.length ? Math.round(distanceKm) : null };
};
