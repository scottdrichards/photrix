/**
 * Per-token request rate limits, checked in the auth gate after a token is
 * known to be valid.
 *
 * Every token is a token bucket: it holds `burst` requests and refills at
 * `perSecond`. A burst is fine, a sustained flood is not. That shape matters
 * here because the web client is bursty by design: opening the grid fetches a
 * 200-tile page of thumbnails at once, and a fast scroll fetches several.
 *
 * Limits are per token kind, because each kind has a different normal:
 *
 * - **session**: the signed-in web client. Generous, so scrolling never trips it.
 * - **share**: a share link, opened by anyone who has the URL, using the same
 *   client. Tighter, so a leaked link can't be used to pull a large share at
 *   full speed or to load the server.
 * - **api**: a personal API key (an MCP key) used by an agent or script, which
 *   doesn't load thumbnail grids.
 *
 * This is not a defence against guessing tokens: sessions and API keys are 256
 * random bits and share links are AES-GCM sealed, so guessing is not feasible.
 * It bounds what one valid token can cost the server.
 */

export type TokenKind = "session" | "api" | "share";

type Limit = { burst: number; perSecond: number };

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const limitFor = (kind: TokenKind): Limit => {
  switch (kind) {
    case "session":
      return {
        burst: envNumber("PHOTRIX_RATE_SESSION_BURST", 2000),
        perSecond: envNumber("PHOTRIX_RATE_SESSION_PER_SECOND", 100),
      };
    case "share":
      return {
        burst: envNumber("PHOTRIX_RATE_SHARE_BURST", 1000),
        perSecond: envNumber("PHOTRIX_RATE_SHARE_PER_SECOND", 30),
      };
    case "api":
      return {
        burst: envNumber("PHOTRIX_RATE_API_BURST", 600),
        perSecond: envNumber("PHOTRIX_RATE_API_PER_SECOND", 20),
      };
  }
};

type Bucket = { tokens: number; updatedAt: number; kind: TokenKind };
const buckets = new Map<string, Bucket>();

// A bucket that has refilled to full carries no state, so it can be dropped.
// Sweeping when the map grows keeps it bounded by the tokens active recently.
const SWEEP_ABOVE = 5000;
const sweep = (now: number): void => {
  for (const [key, bucket] of buckets) {
    const { burst, perSecond } = limitFor(bucket.kind);
    if (bucket.tokens + ((now - bucket.updatedAt) / 1000) * perSecond >= burst) {
      buckets.delete(key);
    }
  }
};

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Spends one request from `token`'s bucket, or says how long until one is free. */
export const takeRequest = (
  token: string,
  kind: TokenKind,
  now = Date.now(),
): RateDecision => {
  const { burst, perSecond } = limitFor(kind);
  let bucket = buckets.get(token);
  if (!bucket) {
    if (buckets.size >= SWEEP_ABOVE) sweep(now);
    bucket = { tokens: burst, updatedAt: now, kind };
    buckets.set(token, bucket);
  } else {
    const refill = ((now - bucket.updatedAt) / 1000) * perSecond;
    bucket.tokens = Math.min(burst, bucket.tokens + refill);
    bucket.updatedAt = now;
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / perSecond)),
  };
};

/** For tests. */
export const resetTokenRateLimits = (): void => {
  buckets.clear();
};
