/**
 * A small, deliberately static list of major world cities used only to name
 * the *region* a map-bounding-box view covers (feedback #86) — never fed to
 * the LLM as raw coordinates (see summarizeShareFilter.ts's comment on why:
 * a small model asked to name a city from lat/long just guesses, and gets it
 * wrong). This list makes the naming a real nearest-neighbor lookup instead,
 * so the fact handed to the model is grounded, not generated.
 *
 * Deliberately not exhaustive — a few hundred of the most populous cities
 * worldwide is enough to give "roughly what region is this" for a typical
 * personal photo library, and false silence (no match, so no place name in
 * the description) is the safe failure mode, not a wrong guess.
 */
export type MajorCity = {
  name: string;
  /** State/province/country qualifier, e.g. "IL" or "Japan". */
  region: string;
  latitude: number;
  longitude: number;
};

export const MAJOR_CITIES: MajorCity[] = [
  { name: "New York", region: "NY", latitude: 40.7128, longitude: -74.006 },
  { name: "Los Angeles", region: "CA", latitude: 34.0522, longitude: -118.2437 },
  { name: "Chicago", region: "IL", latitude: 41.8781, longitude: -87.6298 },
  { name: "Houston", region: "TX", latitude: 29.7604, longitude: -95.3698 },
  { name: "Phoenix", region: "AZ", latitude: 33.4484, longitude: -112.074 },
  { name: "Philadelphia", region: "PA", latitude: 39.9526, longitude: -75.1652 },
  { name: "San Antonio", region: "TX", latitude: 29.4241, longitude: -98.4936 },
  { name: "San Diego", region: "CA", latitude: 32.7157, longitude: -117.1611 },
  { name: "Dallas", region: "TX", latitude: 32.7767, longitude: -96.797 },
  { name: "Austin", region: "TX", latitude: 30.2672, longitude: -97.7431 },
  { name: "San Jose", region: "CA", latitude: 37.3382, longitude: -121.8863 },
  { name: "San Francisco", region: "CA", latitude: 37.7749, longitude: -122.4194 },
  { name: "Seattle", region: "WA", latitude: 47.6062, longitude: -122.3321 },
  { name: "Denver", region: "CO", latitude: 39.7392, longitude: -104.9903 },
  { name: "Boston", region: "MA", latitude: 42.3601, longitude: -71.0589 },
  { name: "Portland", region: "OR", latitude: 45.5152, longitude: -122.6784 },
  { name: "Las Vegas", region: "NV", latitude: 36.1699, longitude: -115.1398 },
  { name: "Nashville", region: "TN", latitude: 36.1627, longitude: -86.7816 },
  { name: "Minneapolis", region: "MN", latitude: 44.9778, longitude: -93.265 },
  { name: "Detroit", region: "MI", latitude: 42.3314, longitude: -83.0458 },
  { name: "Atlanta", region: "GA", latitude: 33.749, longitude: -84.388 },
  { name: "Miami", region: "FL", latitude: 25.7617, longitude: -80.1918 },
  { name: "Orlando", region: "FL", latitude: 28.5383, longitude: -81.3792 },
  { name: "Tampa", region: "FL", latitude: 27.9506, longitude: -82.4572 },
  { name: "New Orleans", region: "LA", latitude: 29.9511, longitude: -90.0715 },
  { name: "Kansas City", region: "MO", latitude: 39.0997, longitude: -94.5786 },
  { name: "St. Louis", region: "MO", latitude: 38.627, longitude: -90.1994 },
  { name: "Salt Lake City", region: "UT", latitude: 40.7608, longitude: -111.891 },
  { name: "Albuquerque", region: "NM", latitude: 35.0844, longitude: -106.6504 },
  { name: "Sacramento", region: "CA", latitude: 38.5816, longitude: -121.4944 },
  { name: "Honolulu", region: "HI", latitude: 21.3069, longitude: -157.8583 },
  { name: "Anchorage", region: "AK", latitude: 61.2181, longitude: -149.9003 },
  { name: "Washington", region: "DC", latitude: 38.9072, longitude: -77.0369 },
  { name: "Baltimore", region: "MD", latitude: 39.2904, longitude: -76.6122 },
  { name: "Charlotte", region: "NC", latitude: 35.2271, longitude: -80.8431 },
  { name: "Raleigh", region: "NC", latitude: 35.7796, longitude: -78.6382 },
  { name: "Pittsburgh", region: "PA", latitude: 40.4406, longitude: -79.9959 },
  { name: "Cleveland", region: "OH", latitude: 41.4993, longitude: -81.6944 },
  { name: "Cincinnati", region: "OH", latitude: 39.1031, longitude: -84.512 },
  { name: "Columbus", region: "OH", latitude: 39.9612, longitude: -82.9988 },
  { name: "Indianapolis", region: "IN", latitude: 39.7684, longitude: -86.1581 },
  { name: "Milwaukee", region: "WI", latitude: 43.0389, longitude: -87.9065 },
  { name: "Grand Canyon Village", region: "AZ", latitude: 36.0544, longitude: -112.1401 },
  { name: "Yellowstone", region: "WY", latitude: 44.428, longitude: -110.5885 },
  { name: "Yosemite Valley", region: "CA", latitude: 37.7459, longitude: -119.5936 },
  { name: "Jackson Hole", region: "WY", latitude: 43.4799, longitude: -110.7624 },
  { name: "Asheville", region: "NC", latitude: 35.5951, longitude: -82.5515 },
  { name: "Savannah", region: "GA", latitude: 32.0809, longitude: -81.0912 },
  { name: "Charleston", region: "SC", latitude: 32.7765, longitude: -79.9311 },
  { name: "Key West", region: "FL", latitude: 24.5551, longitude: -81.78 },
  { name: "Toronto", region: "Canada", latitude: 43.6532, longitude: -79.3832 },
  { name: "Vancouver", region: "Canada", latitude: 49.2827, longitude: -123.1207 },
  { name: "Montreal", region: "Canada", latitude: 45.5019, longitude: -73.5674 },
  { name: "Mexico City", region: "Mexico", latitude: 19.4326, longitude: -99.1332 },
  { name: "Cancun", region: "Mexico", latitude: 21.1619, longitude: -86.8515 },
  { name: "London", region: "UK", latitude: 51.5074, longitude: -0.1278 },
  { name: "Paris", region: "France", latitude: 48.8566, longitude: 2.3522 },
  { name: "Rome", region: "Italy", latitude: 41.9028, longitude: 12.4964 },
  { name: "Venice", region: "Italy", latitude: 45.4408, longitude: 12.3155 },
  { name: "Florence", region: "Italy", latitude: 43.7696, longitude: 11.2558 },
  { name: "Barcelona", region: "Spain", latitude: 41.3851, longitude: 2.1734 },
  { name: "Madrid", region: "Spain", latitude: 40.4168, longitude: -3.7038 },
  { name: "Amsterdam", region: "Netherlands", latitude: 52.3676, longitude: 4.9041 },
  { name: "Berlin", region: "Germany", latitude: 52.52, longitude: 13.405 },
  { name: "Munich", region: "Germany", latitude: 48.1351, longitude: 11.582 },
  { name: "Vienna", region: "Austria", latitude: 48.2082, longitude: 16.3738 },
  { name: "Zurich", region: "Switzerland", latitude: 47.3769, longitude: 8.5417 },
  { name: "Prague", region: "Czechia", latitude: 50.0755, longitude: 14.4378 },
  { name: "Athens", region: "Greece", latitude: 37.9838, longitude: 23.7275 },
  { name: "Santorini", region: "Greece", latitude: 36.3932, longitude: 25.4615 },
  { name: "Lisbon", region: "Portugal", latitude: 38.7223, longitude: -9.1393 },
  { name: "Dublin", region: "Ireland", latitude: 53.3498, longitude: -6.2603 },
  { name: "Reykjavik", region: "Iceland", latitude: 64.1466, longitude: -21.9426 },
  { name: "Istanbul", region: "Turkey", latitude: 41.0082, longitude: 28.9784 },
  { name: "Dubai", region: "UAE", latitude: 25.2048, longitude: 55.2708 },
  { name: "Cairo", region: "Egypt", latitude: 30.0444, longitude: 31.2357 },
  { name: "Cape Town", region: "South Africa", latitude: -33.9249, longitude: 18.4241 },
  { name: "Nairobi", region: "Kenya", latitude: -1.2921, longitude: 36.8219 },
  { name: "Tokyo", region: "Japan", latitude: 35.6762, longitude: 139.6503 },
  { name: "Kyoto", region: "Japan", latitude: 35.0116, longitude: 135.7681 },
  { name: "Osaka", region: "Japan", latitude: 34.6937, longitude: 135.5023 },
  { name: "Seoul", region: "South Korea", latitude: 37.5665, longitude: 126.978 },
  { name: "Beijing", region: "China", latitude: 39.9042, longitude: 116.4074 },
  { name: "Shanghai", region: "China", latitude: 31.2304, longitude: 121.4737 },
  { name: "Hong Kong", region: "Hong Kong", latitude: 22.3193, longitude: 114.1694 },
  { name: "Singapore", region: "Singapore", latitude: 1.3521, longitude: 103.8198 },
  { name: "Bangkok", region: "Thailand", latitude: 13.7563, longitude: 100.5018 },
  { name: "Bali", region: "Indonesia", latitude: -8.3405, longitude: 115.092 },
  { name: "Mumbai", region: "India", latitude: 19.076, longitude: 72.8777 },
  { name: "Delhi", region: "India", latitude: 28.7041, longitude: 77.1025 },
  { name: "Sydney", region: "Australia", latitude: -33.8688, longitude: 151.2093 },
  { name: "Melbourne", region: "Australia", latitude: -37.8136, longitude: 144.9631 },
  { name: "Auckland", region: "New Zealand", latitude: -36.8485, longitude: 174.7633 },
  { name: "Rio de Janeiro", region: "Brazil", latitude: -22.9068, longitude: -43.1729 },
  { name: "Buenos Aires", region: "Argentina", latitude: -34.6037, longitude: -58.3816 },
  { name: "Lima", region: "Peru", latitude: -12.0464, longitude: -77.0428 },
  { name: "Santiago", region: "Chile", latitude: -33.4489, longitude: -70.6693 },
];

const haversineKm = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/** Max distance a bounding box's center may be from a listed city to name it. */
const MAX_MATCH_DISTANCE_KM = 120;

/**
 * Finds the nearest listed city to a lat/long point, or null if none are
 * within MAX_MATCH_DISTANCE_KM — a deliberately conservative gate so a photo
 * taken in the middle of nowhere gets no place name rather than a
 * misleadingly distant "nearest" one.
 */
export const findNearbyCity = (
  latitude: number,
  longitude: number,
): MajorCity | null => {
  let best: { city: MajorCity; distanceKm: number } | null = null;
  for (const city of MAJOR_CITIES) {
    const distanceKm = haversineKm(latitude, longitude, city.latitude, city.longitude);
    if (!best || distanceKm < best.distanceKm) {
      best = { city, distanceKm };
    }
  }
  return best && best.distanceKm <= MAX_MATCH_DISTANCE_KM ? best.city : null;
};
