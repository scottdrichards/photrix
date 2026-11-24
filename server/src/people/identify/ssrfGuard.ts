import { isIP } from "node:net";

/**
 * Keeps the identify endpoint's frame fetcher on the LAN.
 *
 * Frame URLs exist so Home Assistant can hand over a Frigate URL instead of
 * proxying JPEG bytes through its own templating layer, which it is bad at.
 * That convenience turns the server into a fetcher, so the host is pinned to
 * private space: an authenticated caller still shouldn't be able to aim the
 * photo server at arbitrary internet endpoints, and every real caller is on the
 * LAN anyway.
 *
 * Only IP literals and `localhost` pass. A DNS name never does, so there is no
 * name to re-resolve to a public address between the check and the connect.
 */

/** A URL or redirect the guard refused. */
export class UnsafeUrlError extends Error {}

const isPrivateIPv4 = (host: string): boolean => {
  const [a, b] = host.split(".").map(Number);
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Link-local. Allowed for IPv4 only: a camera without DHCP self-assigns here.
  if (a === 169 && b === 254) return true;
  return false;
};

/**
 * True for a loopback or private address (RFC 1918, IPv4 link-local, IPv6
 * loopback and unique-local `fc00::/7`), or `localhost`.
 *
 * Expects a hostname as `URL` produces it: lower-case, IPv4 in dotted-decimal
 * (`URL` rewrites `0x7f.1` or `2130706433` to `127.0.0.1`), IPv6 bracketed and
 * compressed. Anything else is refused rather than interpreted, so an IPv4
 * literal in another notation, an IPv4-mapped IPv6 address and every DNS name
 * other than `localhost` are false.
 */
export const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  const version = isIP(host);
  if (version === 4) return isPrivateIPv4(host);
  // fc00::/7 needs a full first group: `fc0::` is 0fc0::, not unique-local.
  if (version === 6) return host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(host);
  return false;
};

/** Parses an http(s) URL on a private host, or throws `UnsafeUrlError`. */
export const parsePrivateUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Frame URLs must be http or https");
  }
  if (!isPrivateHost(url.hostname)) {
    throw new UnsafeUrlError("Frame URLs must point at a private/LAN address");
  }
  return url;
};

/**
 * Parses a bare `host[:port]` on a private host, returning it normalized, or
 * throws `UnsafeUrlError`.
 *
 * Parsed as a URL rather than split on `:`, because the URL built from it is
 * parsed that way too: `127.0.0.1:80@example.com` splits to a private host but
 * is a request to example.com with `127.0.0.1:80` as its credentials.
 */
export const parsePrivateHostPort = (hostPort: string): string => {
  const refuse = () => new UnsafeUrlError("frigateEvent host must be a private/LAN address");
  let url: URL;
  try {
    url = new URL(`http://${hostPort}`);
  } catch {
    throw refuse();
  }
  const bare =
    url.username === "" && url.password === "" && url.pathname === "/" && !url.search && !url.hash;
  if (!bare || !isPrivateHost(url.hostname)) throw refuse();
  return url.host;
};

/** Redirect hops followed, each re-checked. The fetch default is 20. */
const MAX_REDIRECTS = 3;

/**
 * `fetch` that stays on private hosts across redirects.
 *
 * A plain fetch follows a redirect wherever it points, so one LAN service with
 * an open redirect would carry the request back out to the internet. Each hop
 * is followed by hand and must pass the same check as the first URL.
 */
export const fetchPrivate = async (url: URL, { timeoutMs }: { timeoutMs: number }): Promise<Response> => {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; ; hop += 1) {
    const response = await fetch(current, { signal, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    await response.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new UnsafeUrlError(`More than ${MAX_REDIRECTS} redirects`);
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new UnsafeUrlError("Redirected to an invalid URL");
    }
    if ((next.protocol !== "http:" && next.protocol !== "https:") || !isPrivateHost(next.hostname)) {
      throw new UnsafeUrlError("Redirected away from a private/LAN address");
    }
    current = next;
  }
};
