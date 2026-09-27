import { createHmac, randomBytes } from "node:crypto";

/**
 * What someone searched for and which photos/videos they opened is private
 * browsing history. Logs and the diagnostics buffer must not record it.
 *
 * - Search text is never logged — not even a digest, since short queries are
 *   trivially guessable.
 * - A library path is replaced by an opaque token. The token is keyed with a
 *   secret generated at process start and never persisted, so lines from one
 *   run can still be correlated ("the same video was encoded then reaped")
 *   while nothing in the logs can be mapped back to a file afterwards — not
 *   even by hashing candidate paths from the index.
 */

const TOKEN_KEY = randomBytes(32);

/** Opaque, per-process token for a library path (or anything derived from one). */
export const pathToken = (value: string): string =>
  `p:${createHmac("sha256", TOKEN_KEY).update(value).digest("hex").slice(0, 12)}`;

// Routes whose URL path *is* a library path. Everything after the prefix names
// the file or folder being viewed or edited.
const PATH_BEARING_PREFIXES = ["/api/files/", "/api/folders/"] as const;

/**
 * Reduces a request URL to a loggable route: drops the query string (search
 * text travels as `?q=`) and collapses path-bearing routes to a placeholder.
 */
export const redactRequestPath = (url: string): string => {
  let pathname: string;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    pathname = url.split("?")[0] || "/";
  }

  for (const prefix of PATH_BEARING_PREFIXES) {
    if (pathname.startsWith(prefix) && pathname.length > prefix.length) {
      return `${prefix}:path`;
    }
  }
  return pathname;
};

// Diagnostics `data` keys that carry a library path, and ones that carry
// search text. Path values are tokenized; search values are dropped.
const PATH_KEYS = new Set(["path", "subPath", "videoPath", "filePath", "hlsDir", "file"]);
const SEARCH_KEYS = new Set(["q", "query", "semanticQuery", "searchQuery"]);

const scrubValue = (value: unknown, depth: number): unknown => {
  // Request URLs (e.g. a negotiated `/api/files/<path>?representation=hls`)
  // embed both library paths and search text.
  if (typeof value === "string") {
    return value.startsWith("/api/") ? redactRequestPath(value) : value;
  }
  if (depth <= 0 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth - 1));
  return scrubRecord(value as Record<string, unknown>, depth - 1).data;
};

const scrubRecord = (
  data: Record<string, unknown>,
  depth: number,
  message?: string,
): { message?: string; data: Record<string, unknown> } => {
  let scrubbedMessage = message;
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SEARCH_KEYS.has(key)) continue;
    if (PATH_KEYS.has(key) && typeof value === "string" && value) {
      const token = pathToken(value);
      if (scrubbedMessage) scrubbedMessage = scrubbedMessage.split(value).join(token);
      scrubbed[key] = token;
      continue;
    }
    scrubbed[key] = scrubValue(value, depth);
  }
  return { ...(scrubbedMessage ? { message: scrubbedMessage } : {}), data: scrubbed };
};

/**
 * Scrubs a diagnostics event's free-form `data` and `message`. `message` is
 * often built as `"... for ${path}"`, so any raw path found in `data` is also
 * replaced by its token wherever it appears in the message.
 */
export const scrubDiagnostics = (
  message: string | undefined,
  data: Record<string, unknown> | undefined,
): { message?: string; data?: Record<string, unknown> } => {
  if (!data) return message ? { message } : {};
  return scrubRecord(data, 4, message);
};
