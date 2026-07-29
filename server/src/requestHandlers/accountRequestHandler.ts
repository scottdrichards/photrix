import { createHash } from "node:crypto";
import type http from "node:http";
import {
  extractToken,
  getSessionUsername,
  issueApiToken,
  listApiTokens,
  listSessions,
  listShareLinks,
  revokeApiToken,
  revokeOtherSessions,
  revokeSessionsForUser,
  revokeShareLink,
  revokeToken,
} from "../auth/authService.ts";
import {
  deletePasskey,
  isPasskeySupported,
  isPublicOriginConfigured,
  listPasskeys,
} from "../auth/passkeyService.ts";
import { classifyIp } from "../auth/ipLocation.ts";
import { writeJson } from "../utils.ts";

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });

const readJson = async <T>(req: http.IncomingMessage): Promise<T | null> => {
  try {
    const raw = await readBody(req);
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    return null;
  }
};

// A stable, non-secret handle for a token so the browser can reference a session
// or API token for revocation without ever holding the raw bearer value.
const idOf = (token: string): string =>
  createHash("sha256").update(token).digest("hex").slice(0, 16);

type Resolved = { username: string; token: string };

const resolveSession = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Resolved | null => {
  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const token = extractToken(
    req.headers["authorization"],
    parsedUrl.searchParams.get("token"),
  );
  const username = token ? getSessionUsername(token) : null;
  if (!token || !username) {
    writeJson(res, 401, { error: "Unauthorized" });
    return null;
  }
  return { username, token };
};

// Routes every /api/account/* request. Requires an interactive login session
// (API/share tokens do not resolve to a username, so they are rejected here).
export const accountRequestHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> => {
  const session = resolveSession(req, res);
  if (!session) return;
  const { username, token } = session;

  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = req.method ?? "GET";

  // GET /api/account — whoami
  if (pathname === "/api/account" && method === "GET") {
    writeJson(res, 200, {
      username,
      // Passkeys only make sense once the server is configured with a real
      // public origin (see isPublicOriginConfigured) — on a bare LAN/localhost
      // deployment there is no meaningful WebAuthn relying party, so the
      // client keeps the section hidden rather than show dead controls.
      passkeysAvailable: isPasskeySupported() && isPublicOriginConfigured(),
    });
    return;
  }

  // --- MCP keys (personal API tokens) ---
  if (pathname === "/api/account/mcp-keys" && method === "GET") {
    const keys = await listApiTokens(username);
    writeJson(res, 200, {
      keys: keys.map((k) => ({
        id: idOf(k.token),
        name: k.name,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      })),
    });
    return;
  }

  if (pathname === "/api/account/mcp-keys" && method === "POST") {
    const body = await readJson<{ name?: unknown }>(req);
    if (!body) {
      writeJson(res, 400, { error: "Invalid JSON" });
      return;
    }
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : "MCP key";
    const { token: newToken, createdAt } = issueApiToken(username, name);
    // The raw token is returned exactly once, at creation.
    writeJson(res, 200, { token: newToken, id: idOf(newToken), name, createdAt });
    return;
  }

  if (pathname === "/api/account/mcp-keys/revoke" && method === "POST") {
    const body = await readJson<{ id?: unknown }>(req);
    if (!body || typeof body.id !== "string") {
      writeJson(res, 400, { error: "id required" });
      return;
    }
    const match = (await listApiTokens(username)).find((k) => idOf(k.token) === body.id);
    if (!match || !revokeApiToken(username, match.token)) {
      writeJson(res, 404, { error: "Key not found" });
      return;
    }
    writeJson(res, 200, { ok: true });
    return;
  }

  // --- Passkeys ---
  if (pathname === "/api/account/passkeys" && method === "GET") {
    const passkeys = await listPasskeys(username);
    writeJson(res, 200, { passkeys });
    return;
  }

  if (pathname === "/api/account/passkeys/remove" && method === "POST") {
    const body = await readJson<{ credentialId?: unknown }>(req);
    if (!body || typeof body.credentialId !== "string") {
      writeJson(res, 400, { error: "credentialId required" });
      return;
    }
    const ok = await deletePasskey(username, body.credentialId);
    writeJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Passkey not found" });
    return;
  }

  // --- Share links ---
  if (pathname === "/api/account/share-links" && method === "GET") {
    const links = await listShareLinks(username);
    writeJson(res, 200, { links });
    return;
  }

  if (pathname === "/api/account/share-links/revoke" && method === "POST") {
    const body = await readJson<{ token?: unknown }>(req);
    if (!body || typeof body.token !== "string") {
      writeJson(res, 400, { error: "token required" });
      return;
    }
    const ok = await revokeShareLink(username, body.token);
    writeJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Link not found" });
    return;
  }

  // --- Sessions ---
  if (pathname === "/api/account/sessions" && method === "GET") {
    const sessions = listSessions(username);
    writeJson(res, 200, {
      sessions: sessions.map((s) => {
        const { ip, label } = classifyIp(s.ip);
        return {
          id: idOf(s.token),
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          current: s.token === token,
          ip,
          location: label,
        };
      }),
    });
    return;
  }

  if (pathname === "/api/account/sessions/revoke" && method === "POST") {
    const body = await readJson<{ id?: unknown }>(req);
    if (!body || typeof body.id !== "string") {
      writeJson(res, 400, { error: "id required" });
      return;
    }
    const match = listSessions(username).find((s) => idOf(s.token) === body.id);
    if (!match) {
      writeJson(res, 404, { error: "Session not found" });
      return;
    }
    revokeToken(match.token);
    writeJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/account/sessions/revoke-all" && method === "POST") {
    revokeSessionsForUser(username);
    writeJson(res, 200, { ok: true });
    return;
  }

  // Cleans up every other session (old devices, cleared-storage re-logins,
  // etc.) while keeping the caller signed in — the non-destructive alternative
  // to "sign out everywhere".
  if (pathname === "/api/account/sessions/revoke-others" && method === "POST") {
    revokeOtherSessions(username, token);
    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { error: "Not found" });
};
