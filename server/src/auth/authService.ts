import { randomBytes } from "node:crypto";

type TokenData = {
  createdAt: number;
  /** Present only on share tokens — enforced as a mandatory base filter on every request. */
  shareFilter?: unknown;
};

const tokens = new Map<string, TokenData>();

export const isAuthEnabled = () => !!process.env.AUTH_PASSWORD;

export const issueToken = (): string => {
  const token = randomBytes(32).toString("hex");
  tokens.set(token, { createdAt: Date.now() });
  return token;
};

export const issueShareToken = (shareFilter: unknown): string => {
  const token = randomBytes(32).toString("hex");
  tokens.set(token, { createdAt: Date.now(), shareFilter });
  return token;
};

export const getShareFilter = (token: string): unknown | null =>
  tokens.get(token)?.shareFilter ?? null;

export const isShareToken = (token: string): boolean =>
  tokens.has(token) && "shareFilter" in (tokens.get(token) ?? {});

export const validatePassword = (password: string): string | null => {
  if (password !== process.env.AUTH_PASSWORD) {
    return null;
  }
  return issueToken();
};

export const validateToken = (token: string): boolean =>
  tokens.has(token);

export const revokeToken = (token: string): void => {
  tokens.delete(token);
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
