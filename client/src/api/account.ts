import { fetchJsonOrThrow } from "./http";

export type McpKey = {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
};
// The raw token is only ever returned once, at creation.
export type NewMcpKey = { token: string; id: string; name: string; createdAt: number };
export type Passkey = {
  credentialId: string;
  name: string | null;
  transports: string | null;
  createdAt: number;
};
export type ShareLink = {
  token: string;
  label: string;
  createdAt: number;
  revokedAt: number | null;
};
export type Session = { id: string; createdAt: number; current: boolean };

const jsonPost = <T>(url: string, label: string, body?: unknown): Promise<T> =>
  fetchJsonOrThrow<T>(url, label, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const fetchAccount = (): Promise<{ username: string }> =>
  fetchJsonOrThrow("/api/account", "load account");

// --- MCP keys ---
export const fetchMcpKeys = (): Promise<McpKey[]> =>
  fetchJsonOrThrow<{ keys: McpKey[] }>("/api/account/mcp-keys", "load MCP keys").then(
    (r) => r.keys,
  );

export const createMcpKey = (name: string): Promise<NewMcpKey> =>
  jsonPost<NewMcpKey>("/api/account/mcp-keys", "create MCP key", { name });

export const revokeMcpKey = (id: string): Promise<{ ok: true }> =>
  jsonPost("/api/account/mcp-keys/revoke", "revoke MCP key", { id });

// --- Passkeys ---
export const fetchPasskeys = (): Promise<Passkey[]> =>
  fetchJsonOrThrow<{ passkeys: Passkey[] }>("/api/account/passkeys", "load passkeys").then(
    (r) => r.passkeys,
  );

export const removePasskey = (credentialId: string): Promise<{ ok: true }> =>
  jsonPost("/api/account/passkeys/remove", "remove passkey", { credentialId });

// --- Share links ---
export const fetchShareLinks = (): Promise<ShareLink[]> =>
  fetchJsonOrThrow<{ links: ShareLink[] }>(
    "/api/account/share-links",
    "load share links",
  ).then((r) => r.links);

export const revokeShareLink = (token: string): Promise<{ ok: true }> =>
  jsonPost("/api/account/share-links/revoke", "revoke share link", { token });

// --- Sessions ---
export const fetchSessions = (): Promise<Session[]> =>
  fetchJsonOrThrow<{ sessions: Session[] }>("/api/account/sessions", "load sessions").then(
    (r) => r.sessions,
  );

export const revokeSession = (id: string): Promise<{ ok: true }> =>
  jsonPost("/api/account/sessions/revoke", "revoke session", { id });

export const revokeAllSessions = (): Promise<{ ok: true }> =>
  jsonPost("/api/account/sessions/revoke-all", "sign out everywhere");
