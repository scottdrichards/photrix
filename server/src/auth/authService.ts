import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { logFailure } from "../common/logFailure.ts";
import { getLogger } from "../observability/logger.ts";
import type { ShareScope } from "../../../shared/filter-contract/src/index.ts";

type TokenData = {
  createdAt: number;
  username: string;
  ip: string | null;
  lastSeenAt: number;
};

type ApiTokenData = {
  createdAt: number;
  username: string;
  name: string;
};

const API_TOKEN_PREFIX = "photrix-mcp-v1";

const log = getLogger("auth");

// Persistence rules for this module. The in-memory maps answer every request;
// the database is what they are rebuilt from at startup. So:
// - a *new* credential is usable at once and persisted in the background; if
//   that write fails it only ends early (at the next restart), which is logged;
// - a *revocation* is persisted first and applied in memory only once that
//   write has succeeded, and a failure propagates to the caller. Otherwise a
//   revoked credential would come back to life at the next restart, silently.

type AccountConfig = { username: string; password: string };

const PASSWORD_SALT = "photrix-account-v1";
const PASSWORD_KEY_LENGTH = 32;

const hashPassword = (password: string): Buffer =>
  scryptSync(password, PASSWORD_SALT, PASSWORD_KEY_LENGTH);

// Login hashes an attacker-chosen password on every request, so it must not
// block the event loop: the sync form stalled every request ~50 ms per attempt.
const hashPasswordAsync = (password: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, PASSWORD_SALT, PASSWORD_KEY_LENGTH, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });

const loadAccounts = (): Map<string, Buffer> => {
  const map = new Map<string, Buffer>();
  const raw = process.env.PHOTRIX_ACCOUNTS;
  if (raw) {
    let parsed: AccountConfig[];
    try {
      parsed = JSON.parse(raw) as AccountConfig[];
    } catch {
      throw new Error("PHOTRIX_ACCOUNTS must be a valid JSON array");
    }
    for (const { username, password } of parsed) {
      map.set(username.toLowerCase(), hashPassword(password));
    }
    return map;
  }
  // Fall back to single-account mode using AUTH_PASSWORD with username "admin".
  if (process.env.AUTH_PASSWORD) {
    map.set("admin", hashPassword(process.env.AUTH_PASSWORD));
  }
  return map;
};

const accounts = loadAccounts();

// Sessions expire after this many ms of inactivity. Configurable so a home
// server that restarts infrequently can pick a longer window without forking
// the code; 30 days is the default.
const SESSION_EXPIRY_DAYS = Number(process.env.PHOTRIX_SESSION_EXPIRY_DAYS ?? 30);
export const SESSION_EXPIRY_MS = SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

// In-memory session store — seeded from DB on startup, kept in sync on writes.
const tokens = new Map<string, TokenData>();
// Long-lived personal API tokens ("MCP keys"), same seed-from-DB pattern.
const apiTokens = new Map<string, ApiTokenData>();
const revokedShareTokens = new Set<string>();
const SHARE_TOKEN_PREFIX = "photrix-share-v1";

let db: AsyncSqlite | null = null;

export const initAuthService = async (database: AsyncSqlite): Promise<void> => {
  db = database;
  const cutoff = Date.now() - SESSION_EXPIRY_MS;
  // Hard-delete expired sessions so the DB doesn't grow unboundedly.
  await db.run("DELETE FROM auth_sessions WHERE lastSeenAt < ?", [cutoff]);

  const rows = await db.all<{
    token: string;
    username: string;
    createdAt: number;
    ip: string | null;
    lastSeenAt: number | null;
  }>("SELECT token, username, createdAt, ip, lastSeenAt FROM auth_sessions");
  for (const row of rows) {
    tokens.set(row.token, {
      createdAt: row.createdAt,
      username: row.username,
      ip: row.ip ?? null,
      lastSeenAt: row.lastSeenAt ?? row.createdAt,
    });
  }

  const apiRows = await db.all<{
    token: string;
    username: string;
    name: string;
    createdAt: number;
  }>("SELECT token, username, name, createdAt FROM api_tokens");
  for (const row of apiRows) {
    apiTokens.set(row.token, {
      createdAt: row.createdAt,
      username: row.username,
      name: row.name,
    });
  }

  // Restore share-link revocations so a revoked link stays dead across restarts.
  const revokedRows = await db.all<{ token: string }>(
    "SELECT token FROM share_links WHERE revokedAt IS NOT NULL",
  );
  for (const row of revokedRows) {
    revokedShareTokens.add(tokenDigest(row.token));
  }
};

// scrypt is deliberately slow (~50 ms) and synchronous, and every request
// carrying a share-shaped token decodes it at least once — so deriving the key
// per call blocked the event loop for real viewers and let anyone stall the
// server by sending made-up `photrix-share-v1.*` tokens. Derive once per secret.
let shareTokenKeyCache: { secret: string; key: Buffer } | null = null;

const getShareTokenKey = (): Buffer => {
  const secret = process.env.PHOTRIX_SHARE_TOKEN_SECRET ?? process.env.AUTH_PASSWORD;
  if (!secret) {
    throw new Error("Share token secret is not configured");
  }
  if (shareTokenKeyCache?.secret !== secret) {
    shareTokenKeyCache = { secret, key: scryptSync(secret, "photrix-share-token", 32) };
  }
  return shareTokenKeyCache.key;
};

const isStatelessShareToken = (token: string): boolean =>
  token.startsWith(`${SHARE_TOKEN_PREFIX}.`);

const tokenDigest = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const decodeShareScopePayload = (token: string): ShareScope<unknown> | null => {
  if (!isStatelessShareToken(token) || revokedShareTokens.has(tokenDigest(token))) {
    return null;
  }

  const [, ivRaw, ciphertextRaw, tagRaw] = token.split(".");
  if (!ivRaw || !ciphertextRaw || !tagRaw) {
    return null;
  }

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      getShareTokenKey(),
      Buffer.from(ivRaw, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, "base64url")),
      decipher.final(),
    ]).toString("utf-8");
    const parsed = JSON.parse(plaintext) as { shareScope?: ShareScope<unknown> };
    return parsed.shareScope ?? null;
  } catch {
    return null;
  }
};

export const isAuthEnabled = () =>
  !!(process.env.PHOTRIX_ACCOUNTS || process.env.AUTH_PASSWORD);

export const issueToken = (username = "_test_", ip: string | null = null): string => {
  const token = randomBytes(32).toString("hex");
  const createdAt = Date.now();
  tokens.set(token, { createdAt, username, ip, lastSeenAt: createdAt });
  db?.run(
    "INSERT INTO auth_sessions (token, username, createdAt, ip, lastSeenAt) VALUES (?, ?, ?, ?, ?)",
    [token, username, createdAt, ip, createdAt],
  ).catch(logFailure(log, "Could not persist a new session; it will end at the next restart"));
  return token;
};

export const issueShareToken = (shareScope: ShareScope<unknown>): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getShareTokenKey(), iv);
  const payload = Buffer.from(JSON.stringify({ shareScope }), "utf-8");
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SHARE_TOKEN_PREFIX,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
};

export const getShareScope = (token: string): ShareScope<unknown> | null =>
  decodeShareScopePayload(token);

export const isShareToken = (token: string): boolean => isStatelessShareToken(token);

export const validateCredentials = async (
  username: string,
  password: string,
  ip: string | null = null,
): Promise<string | null> => {
  const storedHash = accounts.get(username.toLowerCase());
  if (!storedHash) return null;
  const inputHash = await hashPasswordAsync(password);
  if (!timingSafeEqual(storedHash, inputHash)) return null;
  return issueToken(username, ip);
};

// Throttle lastUsedAt writes so a chatty agent doesn't cause a DB write per call.
const API_TOKEN_TOUCH_INTERVAL_MS = 60_000;
const apiTokenLastTouched = new Map<string, number>();

const touchApiToken = (token: string): void => {
  const now = Date.now();
  const last = apiTokenLastTouched.get(token) ?? 0;
  if (now - last < API_TOKEN_TOUCH_INTERVAL_MS) return;
  apiTokenLastTouched.set(token, now);
  db?.run("UPDATE api_tokens SET lastUsedAt = ? WHERE token = ?", [now, token]).catch(
    logFailure(log, "Could not record API token use"),
  );
};

// Throttle lastSeenAt writes the same way API-token touches are throttled —
// this fires on every authenticated request, so a per-call DB write would be
// far too chatty.
const SESSION_TOUCH_INTERVAL_MS = 60_000;
const sessionLastTouched = new Map<string, number>();

const touchSession = (token: string): void => {
  const data = tokens.get(token);
  if (!data) return;
  const now = Date.now();
  const last = sessionLastTouched.get(token) ?? 0;
  if (now - last < SESSION_TOUCH_INTERVAL_MS) return;
  sessionLastTouched.set(token, now);
  data.lastSeenAt = now;
  db?.run("UPDATE auth_sessions SET lastSeenAt = ? WHERE token = ?", [now, token]).catch(
    logFailure(log, "Could not record session activity"),
  );
};

export const validateToken = (token: string): boolean => {
  const session = tokens.get(token);
  if (session) {
    if (Date.now() - session.lastSeenAt > SESSION_EXPIRY_MS) {
      // Expired — evict eagerly so the Map doesn't grow with dead entries. The
      // row needs no care: startup deletes expired rows before loading.
      tokens.delete(token);
      sessionLastTouched.delete(token);
      db?.run("DELETE FROM auth_sessions WHERE token = ?", [token]).catch(
        logFailure(log, "Could not delete an expired session"),
      );
      return false;
    }
    touchSession(token);
    return true;
  }
  if (apiTokens.has(token)) {
    touchApiToken(token);
    return true;
  }
  return decodeShareScopePayload(token) !== null;
};

// Resolves the username for an *interactive* login session only — API tokens and
// share tokens deliberately do not resolve, so account-management endpoints
// require a real logged-in session.
export const getSessionUsername = (token: string): string | null =>
  tokens.get(token)?.username ?? null;

// --- API tokens ("MCP keys") ---

export type ApiTokenInfo = {
  token: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
};

export const issueApiToken = (
  username: string,
  name: string,
): { token: string; createdAt: number } => {
  const token = `${API_TOKEN_PREFIX}.${randomBytes(32).toString("hex")}`;
  const createdAt = Date.now();
  apiTokens.set(token, { createdAt, username, name });
  db?.run(
    "INSERT INTO api_tokens (token, username, name, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, ?)",
    [token, username, name, createdAt, null],
  ).catch(logFailure(log, "Could not persist a new API token; it will stop working at the next restart"));
  return { token, createdAt };
};

export const listApiTokens = async (username: string): Promise<ApiTokenInfo[]> => {
  if (db) {
    return db.all<ApiTokenInfo>(
      "SELECT token, name, createdAt, lastUsedAt FROM api_tokens WHERE username = ? ORDER BY createdAt DESC",
      [username],
    );
  }
  return [...apiTokens.entries()]
    .filter(([, data]) => data.username === username)
    .map(([token, data]) => ({
      token,
      name: data.name,
      createdAt: data.createdAt,
      lastUsedAt: null as number | null,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
};

export const revokeApiToken = async (username: string, token: string): Promise<boolean> => {
  const data = apiTokens.get(token);
  if (!data || data.username !== username) return false;
  await db?.run("DELETE FROM api_tokens WHERE token = ?", [token]);
  apiTokens.delete(token);
  apiTokenLastTouched.delete(token);
  return true;
};

// --- Share-link tracking ---

export type ShareLinkInfo = {
  token: string;
  label: string;
  createdAt: number;
  revokedAt: number | null;
};

export const recordShareLink = (username: string, token: string, label: string): void => {
  db?.run(
    "INSERT OR REPLACE INTO share_links (token, username, label, createdAt, revokedAt) VALUES (?, ?, ?, ?, NULL)",
    [token, username, label, Date.now()],
  ).catch(logFailure(log, "Could not record a new share link; it won't appear in the account panel"));
};

// Revoked links are excluded here (not just hidden client-side): once revoked
// there is nothing actionable left to show, so the row is dead to the owner.
// The DB row itself is kept (not hard-deleted) — revokedAt also feeds the
// in-memory revocation set on startup (see initAuthService) that permanently
// blocks a stateless share token from decoding again, so the row must survive.
export const listShareLinks = async (username: string): Promise<ShareLinkInfo[]> => {
  if (!db) return [];
  return db.all<ShareLinkInfo>(
    "SELECT token, label, createdAt, revokedAt FROM share_links WHERE username = ? AND revokedAt IS NULL ORDER BY createdAt DESC",
    [username],
  );
};

export const getShareLinkLabel = async (token: string): Promise<string | null> => {
  if (!db) return null;
  const row = await db.get<{ label: string }>(
    "SELECT label FROM share_links WHERE token = ? AND revokedAt IS NULL",
    [token],
  );
  return row?.label ?? null;
};

export const revokeShareLink = async (
  username: string,
  token: string,
): Promise<boolean> => {
  if (!db) {
    revokedShareTokens.add(tokenDigest(token));
    return true;
  }
  const rows = await db.all<{ token: string }>(
    "SELECT token FROM share_links WHERE token = ? AND username = ?",
    [token, username],
  );
  if (!rows[0]) return false;
  await db.run("UPDATE share_links SET revokedAt = ? WHERE token = ? AND username = ?", [
    Date.now(),
    token,
    username,
  ]);
  revokedShareTokens.add(tokenDigest(token));
  return true;
};

export const revokeAllShareLinksForUser = async (username: string): Promise<number> => {
  const now = Date.now();
  if (!db) return 0;
  const active = await db.all<{ token: string }>(
    "SELECT token FROM share_links WHERE username = ? AND revokedAt IS NULL",
    [username],
  );
  await db.run(
    "UPDATE share_links SET revokedAt = ? WHERE username = ? AND revokedAt IS NULL",
    [now, username],
  );
  for (const row of active) {
    revokedShareTokens.add(tokenDigest(row.token));
  }
  return active.length;
};

// --- Sessions ---

export type SessionInfo = {
  token: string;
  createdAt: number;
  ip: string | null;
  lastSeenAt: number;
};

export const listSessions = (username: string): SessionInfo[] =>
  [...tokens.entries()]
    .filter(([, data]) => data.username === username)
    .map(([token, data]) => ({
      token,
      createdAt: data.createdAt,
      ip: data.ip,
      lastSeenAt: data.lastSeenAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);

export const revokeSessionsForUser = async (username: string): Promise<void> => {
  await db?.run("DELETE FROM auth_sessions WHERE username = ?", [username]);
  for (const [token, data] of tokens) {
    if (data.username === username) {
      tokens.delete(token);
      sessionLastTouched.delete(token);
    }
  }
};

// Revokes every session for a user except the one making the request — lets a
// user with a pile of old logins (different devices, cleared browser storage,
// etc.) clean up in one action without also signing themselves out.
export const revokeOtherSessions = async (username: string, keepToken: string): Promise<void> => {
  await db?.run("DELETE FROM auth_sessions WHERE username = ? AND token != ?", [
    username,
    keepToken,
  ]);
  for (const [token, data] of tokens) {
    if (data.username === username && token !== keepToken) {
      tokens.delete(token);
      sessionLastTouched.delete(token);
    }
  }
};

export const revokeToken = async (token: string): Promise<void> => {
  await db?.run("DELETE FROM auth_sessions WHERE token = ?", [token]);
  tokens.delete(token);
  sessionLastTouched.delete(token);
  // Held in memory only: a share token revoked here is live again after a
  // restart. (Share links are revoked durably through revokeShareLink.)
  if (isStatelessShareToken(token)) {
    revokedShareTokens.add(tokenDigest(token));
  }
};

export const extractToken = (
  authHeader: string | string[] | undefined,
  queryToken: string | null,
): string | null => {
  if (queryToken) return queryToken;
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
};
