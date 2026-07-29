import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { AsyncSqlite } from "../common/asyncSqlite.ts";
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

type AccountConfig = { username: string; password: string };

const hashPassword = (password: string): Buffer =>
  scryptSync(password, "photrix-account-v1", 32);

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

// In-memory session store — seeded from DB on startup, kept in sync on writes.
const tokens = new Map<string, TokenData>();
// Long-lived personal API tokens ("MCP keys"), same seed-from-DB pattern.
const apiTokens = new Map<string, ApiTokenData>();
const revokedShareTokens = new Set<string>();
const SHARE_TOKEN_PREFIX = "photrix-share-v1";

let db: AsyncSqlite | null = null;

export const initAuthService = async (database: AsyncSqlite): Promise<void> => {
  db = database;
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

const getShareTokenKey = (): Buffer => {
  const secret = process.env.PHOTRIX_SHARE_TOKEN_SECRET ?? process.env.AUTH_PASSWORD;
  if (!secret) {
    throw new Error("Share token secret is not configured");
  }
  return scryptSync(secret, "photrix-share-token", 32);
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
  // Persist to DB if available (fire-and-forget; in-memory Map is source of truth).
  db?.run(
    "INSERT INTO auth_sessions (token, username, createdAt, ip, lastSeenAt) VALUES (?, ?, ?, ?, ?)",
    [token, username, createdAt, ip, createdAt],
  ).catch(() => {});
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

export const getShareFilter = (token: string): unknown | null =>
  decodeShareScopePayload(token)?.filter ?? null;

export const getShareScope = (token: string): ShareScope<unknown> | null =>
  decodeShareScopePayload(token);

export const isShareToken = (token: string): boolean => isStatelessShareToken(token);

export const validateCredentials = (
  username: string,
  password: string,
  ip: string | null = null,
): string | null => {
  const storedHash = accounts.get(username.toLowerCase());
  if (!storedHash) return null;
  const inputHash = hashPassword(password);
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
    () => {},
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
    () => {},
  );
};

export const validateToken = (token: string): boolean => {
  if (tokens.has(token)) {
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
  ).catch(() => {});
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

export const revokeApiToken = (username: string, token: string): boolean => {
  const data = apiTokens.get(token);
  if (!data || data.username !== username) return false;
  apiTokens.delete(token);
  apiTokenLastTouched.delete(token);
  db?.run("DELETE FROM api_tokens WHERE token = ?", [token]).catch(() => {});
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
  ).catch(() => {});
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
  revokedShareTokens.add(tokenDigest(token));
  db.run("UPDATE share_links SET revokedAt = ? WHERE token = ? AND username = ?", [
    Date.now(),
    token,
    username,
  ]).catch(() => {});
  return true;
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

export const revokeSessionsForUser = (username: string): void => {
  for (const [token, data] of tokens) {
    if (data.username === username) tokens.delete(token);
  }
  db?.run("DELETE FROM auth_sessions WHERE username = ?", [username]).catch(() => {});
};

// Revokes every session for a user except the one making the request — lets a
// user with a pile of old logins (different devices, cleared browser storage,
// etc.) clean up in one action without also signing themselves out.
export const revokeOtherSessions = (username: string, keepToken: string): void => {
  for (const [token, data] of tokens) {
    if (data.username === username && token !== keepToken) tokens.delete(token);
  }
  db?.run("DELETE FROM auth_sessions WHERE username = ? AND token != ?", [
    username,
    keepToken,
  ]).catch(() => {});
};

export const revokeToken = (token: string): void => {
  tokens.delete(token);
  sessionLastTouched.delete(token);
  db?.run("DELETE FROM auth_sessions WHERE token = ?", [token]).catch(() => {});
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
