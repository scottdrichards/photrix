/**
 * Rough place names ("Seattle, Washington, United States") for the internet
 * sessions in the account list (feedback #152).
 *
 * There is no GeoIP database in this project, so this asks a public lookup
 * service. Those services change their terms, rate-limit and disappear, so
 * nothing here may depend on one:
 *
 * - Two keyless HTTPS providers, tried in order. If both fail the session
 *   simply shows "Internet", as it did before.
 * - Only public addresses are looked up. Private, loopback and link-local
 *   addresses never leave the server.
 * - Answers are cached (a week; a failure for an hour), so opening the account
 *   panel repeatedly doesn't repeat lookups.
 * - The sessions list waits at most `LIST_WAIT_MS` for lookups. One that takes
 *   longer still finishes in the background and shows the next time.
 * - `PHOTRIX_IP_LOCATION=off` turns lookups off entirely, for anyone who would
 *   rather not send their visitors' addresses to a third party.
 */

import { getLogger } from "../observability/logger.ts";
import { attempt, attemptSync, type Result } from "../common/result.ts";

const log = getLogger("ipGeolocation");

export const LIST_WAIT_MS = 1_500;
const LOOKUP_TIMEOUT_MS = 4_000;
const FOUND_TTL_MS = 7 * 24 * 60 * 60_000;
const FAILED_TTL_MS = 60 * 60_000;
const MAX_CACHED = 1_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

type Provider = {
  name: string;
  url: (ip: string) => string;
  /** The place, or null when the response has none (or reports an error). */
  parse: (body: unknown) => string | null;
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });

/** "US" → "United States"; anything else is passed through. */
const countryName = (value: unknown): string | null => {
  const raw = text(value);
  if (!raw) return null;
  if (!/^[A-Z]{2}$/.test(raw)) return raw;
  // Intl throws on a well-formed but unassigned code ("XX"): keep the code then.
  const name = attemptSync(() => countryNames.of(raw));
  return (name.ok && name.value) || raw;
};

/** Joins the parts that are present, dropping repeats ("Singapore, Singapore"). */
export const formatPlace = (
  ...parts: (string | null | undefined)[]
): string | null => {
  const seen = new Set<string>();
  const kept = parts.filter((part): part is string => {
    if (!part || seen.has(part.toLowerCase())) return false;
    seen.add(part.toLowerCase());
    return true;
  });
  return kept.length > 0 ? kept.join(", ") : null;
};

const field = (body: unknown, key: string): unknown =>
  body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;

export const PROVIDERS: readonly Provider[] = [
  {
    name: "ipinfo.io",
    url: (ip) => `https://ipinfo.io/${encodeURIComponent(ip)}/json`,
    parse: (body) =>
      field(body, "bogon") || field(body, "error")
        ? null
        : formatPlace(
            text(field(body, "city")),
            text(field(body, "region")),
            countryName(field(body, "country")),
          ),
  },
  {
    name: "ipapi.co",
    url: (ip) => `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
    parse: (body) =>
      field(body, "error")
        ? null
        : formatPlace(
            text(field(body, "city")),
            text(field(body, "region")),
            countryName(field(body, "country_name") ?? field(body, "country")),
          ),
  },
];

type CacheEntry = { place: string | null; expiresAt: number };

export const isIpLocationEnabled = (): boolean =>
  (process.env.PHOTRIX_IP_LOCATION ?? "").trim().toLowerCase() !== "off";

type Options = {
  fetchImpl?: Fetch;
  providers?: readonly Provider[];
  now?: () => number;
};

/** Builds a lookup with its own cache. The app uses the shared one below. */
export const createIpGeolocation = ({
  // Looked up per call, not captured here, so a test can stub the global.
  fetchImpl = (url, init) => globalThis.fetch(url, init),
  providers = PROVIDERS,
  now = Date.now,
}: Options = {}) => {
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<string | null>>();

  const remember = (ip: string, place: string | null) => {
    if (cache.size >= MAX_CACHED) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(ip, { place, expiresAt: now() + (place ? FOUND_TTL_MS : FAILED_TTL_MS) });
  };

  /** One provider's answer, or the reason it had none. Never throws. */
  const askProvider = async (provider: Provider, ip: string): Promise<Result<string>> => {
    const response = await attempt(
      fetchImpl(provider.url(ip), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      }),
    );
    if (!response.ok) return response;
    if (!response.value.ok) {
      return { ok: false, error: new Error(`HTTP ${response.value.status}`) };
    }
    const body = await attempt(response.value.json() as Promise<unknown>);
    if (!body.ok) return body;
    const place = provider.parse(body.value);
    return place ? { ok: true, value: place } : { ok: false, error: new Error("no place in answer") };
  };

  const askProviders = async (ip: string): Promise<string | null> => {
    for (const provider of providers) {
      const answer = await askProvider(provider, ip);
      if (answer.ok) return answer.value;
      // Expected now and then (rate limits, outages, a changed format): the
      // next provider gets a turn, and the session just shows "Internet".
      log.debug({ provider: provider.name, err: answer.error }, "IP location lookup failed");
    }
    return null;
  };

  /** The rough place for one public address, or null when nobody could say. */
  const lookup = (ip: string): Promise<string | null> => {
    const cached = cache.get(ip);
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.place);
    const pending = inFlight.get(ip);
    if (pending) return pending;
    const request = askProviders(ip)
      .then((place) => {
        remember(ip, place);
        return place;
      })
      .finally(() => inFlight.delete(ip));
    inFlight.set(ip, request);
    return request;
  };

  /**
   * Places for a set of public addresses, waiting at most `waitMs`. Addresses
   * still being looked up when the wait ends are left out of the result.
   */
  const placesFor = async (
    ips: readonly string[],
    waitMs = LIST_WAIT_MS,
  ): Promise<Map<string, string>> => {
    const places = new Map<string, string>();
    if (!isIpLocationEnabled()) return places;
    const lookups = [...new Set(ips)].map((ip) =>
      lookup(ip).then((place) => {
        if (place) places.set(ip, place);
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });
    await Promise.race([Promise.allSettled(lookups), waited]);
    clearTimeout(timer);
    return new Map(places);
  };

  return { lookup, placesFor };
};

const shared = createIpGeolocation();

/** Rough places for public session addresses; see the module comment. */
export const roughPlacesFor = shared.placesFor;
