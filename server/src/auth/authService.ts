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
};

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
const revokedShareTokens = new Set<string>();
const SHARE_TOKEN_PREFIX = "photrix-share-v1";

let db: AsyncSqlite | null = null;

export const initAuthService = async (database: AsyncSqlite): Promise<void> => {
  db = database;
  const rows = await db.all<{ token: string; username: string; createdAt: number }>(
    "SELECT token, username, createdAt FROM auth_sessions",
  );
  for (const row of rows) {
    tokens.set(row.token, { createdAt: row.createdAt, username: row.username });
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

export const issueToken = (username = "_test_"): string => {
  const token = randomBytes(32).toString("hex");
  const createdAt = Date.now();
  tokens.set(token, { createdAt, username });
  // Persist to DB if available (fire-and-forget; in-memory Map is source of truth).
  db
    ?.run("INSERT INTO auth_sessions (token, username, createdAt) VALUES (?, ?, ?)", [
      token,
      username,
      createdAt,
    ])
    .catch(() => {});
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

export const isShareToken = (token: string): boolean =>
  isStatelessShareToken(token);

export const validateCredentials = (username: string, password: string): string | null => {
  const storedHash = accounts.get(username.toLowerCase());
  if (!storedHash) return null;
  const inputHash = hashPassword(password);
  if (!timingSafeEqual(storedHash, inputHash)) return null;
  return issueToken(username);
};

export const validateToken = (token: string): boolean =>
  tokens.has(token) || decodeShareScopePayload(token) !== null;

export const revokeToken = (token: string): void => {
  tokens.delete(token);
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
