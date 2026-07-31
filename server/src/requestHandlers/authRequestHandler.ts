import type http from "node:http";
import {
  SEARCH_SOURCES,
  type ShareScope,
} from "../../../shared/filter-contract/src/index.ts";
import {
  extractToken,
  getSessionUsername,
  isShareToken,
  issueShareToken,
  issueToken,
  recordShareLink,
  revokeToken,
  validateCredentials,
  validateToken,
} from "../auth/authService.ts";
import {
  generatePasskeyAuthenticationOptions,
  generatePasskeyRegistrationOptions,
  isPasskeySupported,
  isPublicOriginConfigured,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "../auth/passkeyService.ts";
import { normalizeShareSearchSources } from "../auth/shareScope.ts";
import { clientIpFromRequest } from "../auth/ipLocation.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";
import { generateShareDescription } from "../shareDescription/generateShareDescription.ts";
import { writeJson } from "../utils.ts";

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });

export const authLoginHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => {
  let body: { username?: unknown; password?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { username?: unknown; password?: unknown };
  } catch {
    writeJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (typeof body.username !== "string" || typeof body.password !== "string") {
    writeJson(res, 400, { error: "username and password required" });
    return;
  }

  const token = validateCredentials(body.username, body.password, clientIpFromRequest(req));
  if (!token) {
    writeJson(res, 401, { error: "Invalid username or password" });
    return;
  }

  writeJson(res, 200, { token });
};

// Issues a share token tied to a specific filter.
// Requires an existing valid token (bypasses the main auth gate, so we validate manually).
// The stored filter is enforced server-side on every request that uses the returned token.
export const authShareTokenHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  database: IndexDatabase,
): Promise<void> => {
  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const token = extractToken(
    req.headers["authorization"],
    parsedUrl.searchParams.get("token"),
  );
  if (!token || !validateToken(token)) {
    writeJson(res, 401, { error: "Unauthorized" });
    return;
  }

  // Share tokens may not mint new tokens — only full-auth sessions may.
  if (isShareToken(token)) {
    writeJson(res, 403, { error: "Forbidden" });
    return;
  }

  let body: ShareScope<unknown>;
  try {
    body = JSON.parse(await readBody(req)) as ShareScope<unknown>;
  } catch {
    writeJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  // A share token without a filter would be indistinguishable from full access;
  // require a non-null filter so the share is always scoped.
  if (body.filter == null) {
    writeJson(res, 400, { error: "filter is required when issuing a share token" });
    return;
  }

  const semanticQuery = body.semanticQuery?.trim();
  const searchSources = normalizeShareSearchSources(body.searchSources);
  if (body.searchSources !== undefined && searchSources === null) {
    writeJson(res, 400, {
      error: "searchSources must contain at least one valid source",
    });
    return;
  }

  // A caller-supplied label wins; otherwise a locally hosted model names the
  // collection from the filter so link previews read like an album title
  // instead of "Filtered view".
  const rawLabel = (body as { label?: unknown }).label;
  const label =
    typeof rawLabel === "string" && rawLabel.trim()
      ? rawLabel.trim()
      : await generateShareDescription({
          filter: body.filter as FilterElement,
          ...(semanticQuery ? { semanticQuery } : {}),
          database,
        });

  const shareToken = issueShareToken({
    filter: body.filter,
    ...(semanticQuery ? { semanticQuery } : {}),
    ...(searchSources && searchSources.length < SEARCH_SOURCES.length
      ? { searchSources }
      : {}),
    description: label,
  });

  // Track the link so the owner can list and revoke it from the account panel.
  const username = getSessionUsername(token);
  if (username) {
    recordShareLink(username, shareToken, label);
  }

  writeJson(res, 200, { token: shareToken });
};

// --- Passkey endpoints ---

export const passkeyRegistrationOptionsHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> => {
  if (!isPasskeySupported() || !isPublicOriginConfigured()) {
    writeJson(res, 503, { error: "Passkeys not available" });
    return;
  }

  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const token = extractToken(
    req.headers["authorization"],
    parsedUrl.searchParams.get("token"),
  );
  if (!token || !validateToken(token)) {
    writeJson(res, 401, { error: "Unauthorized" });
    return;
  }
  if (isShareToken(token)) {
    writeJson(res, 403, { error: "Forbidden" });
    return;
  }

  let body: { username?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { username?: unknown };
  } catch {
    writeJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (typeof body.username !== "string") {
    writeJson(res, 400, { error: "username required" });
    return;
  }

  const { options, sessionId } = await generatePasskeyRegistrationOptions(body.username);
  writeJson(res, 200, { options, sessionId });
};

export const passkeyRegistrationVerifyHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> => {
  if (!isPasskeySupported() || !isPublicOriginConfigured()) {
    writeJson(res, 503, { error: "Passkeys not available" });
    return;
  }

  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const token = extractToken(
    req.headers["authorization"],
    parsedUrl.searchParams.get("token"),
  );
  if (!token || !validateToken(token)) {
    writeJson(res, 401, { error: "Unauthorized" });
    return;
  }

  let body: { sessionId?: unknown; response?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { sessionId?: unknown; response?: unknown };
  } catch {
    writeJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (typeof body.sessionId !== "string" || !body.response) {
    writeJson(res, 400, { error: "sessionId and response required" });
    return;
  }

  const ok = await verifyPasskeyRegistration(body.sessionId, body.response as never);
  if (!ok) {
    writeJson(res, 400, { error: "Passkey registration failed" });
    return;
  }

  writeJson(res, 200, { ok: true });
};

export const passkeyAuthenticationOptionsHandler = async (
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> => {
  if (!isPasskeySupported() || !isPublicOriginConfigured()) {
    writeJson(res, 503, { error: "Passkeys not available" });
    return;
  }

  const { options, sessionId } = await generatePasskeyAuthenticationOptions();
  writeJson(res, 200, { options, sessionId });
};

export const passkeyAuthenticationVerifyHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> => {
  if (!isPasskeySupported() || !isPublicOriginConfigured()) {
    writeJson(res, 503, { error: "Passkeys not available" });
    return;
  }

  let body: { sessionId?: unknown; response?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { sessionId?: unknown; response?: unknown };
  } catch {
    writeJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (typeof body.sessionId !== "string" || !body.response) {
    writeJson(res, 400, { error: "sessionId and response required" });
    return;
  }

  const username = await verifyPasskeyAuthentication(
    body.sessionId,
    body.response as never,
  );
  if (!username) {
    writeJson(res, 401, { error: "Passkey authentication failed" });
    return;
  }

  const token = issueToken(username, clientIpFromRequest(req));
  writeJson(res, 200, { token });
};

export const authLogoutHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => {
  let body: { token?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { token?: unknown };
  } catch {
    writeJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (typeof body.token === "string") {
    revokeToken(body.token);
  }

  writeJson(res, 200, { ok: true });
};
