import { createRequire } from "node:module";

/**
 * Offline "where was this taken" text for a GPS fix: nearest city, its state
 * (US only: that is the one place the city data carries a readable region code)
 * and the country, e.g. "Raleigh, North Carolina, United States, USA". The text
 * is stored on the file and matched by the names-and-tags search source
 * (feedback #203). Nothing leaves the machine.
 */

type City = { name: string; country: string; adminCode: string; lat: number; lon: number };

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** Farther than this from every known city counts as "no place" (open ocean, wilderness). */
export const MAX_PLACE_DISTANCE_KM = 100;

let grid: Map<number, City[]> | null = null;
let regionNames: Intl.DisplayNames | null = null;

const cellKey = (latCell: number, lonCell: number) => latCell * 1000 + lonCell;

const loadGrid = () => {
  if (grid) return grid;
  // Loaded on first use: the package decodes ~135k cities (~150 ms, ~55 MB),
  // which a server that never backfills places should not pay at startup.
  const require = createRequire(import.meta.url);
  const raw = require("all-the-cities") as Array<{
    name: string;
    country: string;
    adminCode: string;
    loc: { coordinates: [number, number] };
  }>;
  const next = new Map<number, City[]>();
  for (const entry of raw) {
    const [lon, lat] = entry.loc.coordinates;
    const key = cellKey(Math.floor(lat), Math.floor(lon));
    const city: City = {
      name: entry.name,
      country: entry.country,
      adminCode: entry.adminCode,
      lat,
      lon,
    };
    const cell = next.get(key);
    if (cell) cell.push(city);
    else next.set(key, [city]);
  }
  grid = next;
  return grid;
};

const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
};

const countryName = (iso2: string) => {
  regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
  try {
    return regionNames.of(iso2) ?? iso2;
  } catch {
    return iso2;
  }
};

/** Place text for a coordinate, or "" when no known city is within MAX_PLACE_DISTANCE_KM. */
export const placeTextFor = (lat: number, lon: number): string => {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return "";
  }
  const cities = loadGrid();
  const latCell = Math.floor(lat);
  const lonCell = Math.floor(lon);
  // A degree of latitude is ~111 km, so 1 ring covers the radius at the equator;
  // longitude cells shrink toward the poles, so widen the search there.
  const lonReach = Math.min(180, Math.ceil(1 / Math.max(0.1, Math.cos((lat * Math.PI) / 180))));
  let best: City | null = null;
  let bestKm = Infinity;
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -lonReach; dLon <= lonReach; dLon++) {
      let lonIndex = lonCell + dLon;
      if (lonIndex < -180) lonIndex += 360;
      if (lonIndex >= 180) lonIndex -= 360;
      for (const city of cities.get(cellKey(latCell + dLat, lonIndex)) ?? []) {
        const km = haversineKm(lat, lon, city.lat, city.lon);
        if (km < bestKm) {
          best = city;
          bestKm = km;
        }
      }
    }
  }
  if (!best || bestKm > MAX_PLACE_DISTANCE_KM) return "";

  const parts = [best.name];
  const state = best.country === "US" ? US_STATES[best.adminCode] : undefined;
  if (state) parts.push(state);
  parts.push(countryName(best.country));
  if (best.country === "US") parts.push("USA");
  return parts.join(", ");
};
