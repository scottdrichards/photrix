import type http from "node:http";

/**
 * Coarse, fully offline IP classification for the account "sessions" list.
 *
 * This deliberately does NOT attempt city/country-level geolocation: there is
 * no GeoIP database bundled in this project (checking server/package.json —
 * nothing lightweight already pulled in), and reaching for an external
 * geolocation API would mean a self-hosted app phoning home per login, which
 * conflicts with the privacy/no-network-dependency stance taken elsewhere in
 * this codebase. Instead we classify an address as "local network" (private /
 * loopback / link-local ranges — someone on the LAN, or a reverse proxy that
 * forwards the internal hop) vs "public internet" (plus loopback, "This
 * server"), which is enough for a user
 * to sanity-check whether a listed session came from their own network or
 * somewhere else. Precise region/country geolocation is deferred to a future
 * bundled GeoIP dataset if that's ever worth the size/maintenance cost.
 */
export type IpLocation = { ip: string | null; label: string };

const isIPv4PrivateOrReserved = (octets: number[]): boolean => {
  const [a, b] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  return false;
};

type AddressKind = "server" | "local" | "public";

const classifyAddress = (ip: string): AddressKind => {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const v4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (v4Match) {
    const octets = v4Match.slice(1, 5).map(Number);
    if (octets[0] === 127) return "server";
    return isIPv4PrivateOrReserved(octets) ? "local" : "public";
  }
  const lower = ip.toLowerCase();
  if (lower === "::1") return "server";
  if (lower.startsWith("fc") || lower.startsWith("fd")) return "local"; // fc00::/7 ULA
  if (lower.startsWith("fe80")) return "local"; // link-local
  return "public";
};

/**
 * Loopback is its own label: a request only arrives from loopback when
 * something on the server host itself signed in (a script, a test run, a
 * maintenance tool), since browsers reach the app through the reverse proxy,
 * which forwards their real address. Calling those "Local network" made a
 * list of scripts look like a house full of devices.
 */
const LABELS: Record<AddressKind, string> = {
  public: "Internet",
  local: "Local network",
  server: "This server",
};

export const classifyIp = (ip: string | null): IpLocation => {
  if (!ip) return { ip: null, label: "Unknown" };
  return { ip, label: LABELS[classifyAddress(ip)] };
};

/**
 * Sessions list order (feedback #152): internet sessions first, since those
 * are the ones worth checking, then the local network, the server itself,
 * and sessions too old to have recorded an address.
 */
const LABEL_ORDER = ["Internet", "Local network", "This server", "Unknown"];

export const compareSessionsForList = (
  a: { location: string; lastSeenAt: number },
  b: { location: string; lastSeenAt: number },
): number =>
  LABEL_ORDER.indexOf(a.location) - LABEL_ORDER.indexOf(b.location) ||
  b.lastSeenAt - a.lastSeenAt;

/**
 * Best-effort client address for a request: the first hop of X-Forwarded-For
 * when present (this app is commonly reached through a reverse proxy for its
 * public domain — see project notes on remote access over the public domain),
 * else the raw socket address.
 */
export const clientIpFromRequest = (req: http.IncomingMessage): string | null => {
  const xff = req.headers["x-forwarded-for"];
  const forwarded = Array.isArray(xff) ? xff[0] : xff;
  const firstHop = forwarded?.split(",")[0]?.trim();
  if (firstHop) return firstHop;
  return req.socket?.remoteAddress ?? null;
};
