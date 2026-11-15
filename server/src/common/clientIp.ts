import type http from "node:http";

/**
 * Best-effort client address for a request: the first hop of X-Forwarded-For
 * when present (this app is commonly reached through a reverse proxy),
 * else the raw socket address.
 */
export const clientIpFromRequest = (req: http.IncomingMessage): string | null => {
  const xff = req.headers["x-forwarded-for"];
  const forwarded = Array.isArray(xff) ? xff[0] : xff;
  const firstHop = forwarded?.split(",")[0]?.trim();
  if (firstHop) return firstHop;
  return req.socket?.remoteAddress ?? null;
};
