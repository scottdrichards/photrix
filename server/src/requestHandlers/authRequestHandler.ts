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
import {
  assertShareFilterIsScoped,
  normalizeShareSearchSources,
  resolveShareFilter,
  ShareScopeError,
} from "../auth/shareScope.ts";
import { clientIpFromRequest } from "../auth/ipLocation.ts";
import { LoginThrottledError, throttleLogin } from "../auth/loginThrottle.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { FilterCompileError, filterToSQL } from "../indexDatabase/filterToSQL.ts";
import { generateShareDescription } from "../shareDescription/generateShareDescription.ts";
import { writeJson } from "../utils.ts";
import { readJsonRequest } from "../common/readBody.ts";

export const authLoginHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => {
  const body = await readJsonRequest<{ username?: unknown; password?: unknown }>(req, res);
  if (!body) return;

  if (typeof body.username !== "string" || typeof body.password !== "string") {
    writeJson(res, 400, { error: "username and password required" });
    return;
  }

  const { username, password } = body;
  const clientIp = clientIpFromRequest(req);
  let token: string | null;
  try {
    token = await throttleLogin(clientIp, () =>
      validateCredentials(username, password, clientIp),
    );
  } catch (error) {
    if (error instanceof LoginThrottledError) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
      writeJson(res, 429, { error: "Too many login attempts, try again later" });
      return;
    }
    throw error;
  }
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

  const body = await readJsonRequest<ShareScope<unknown>>(req, res);
  if (!body) return;

  // A share token without a filter would be indistinguishable from full access;
  // require a non-null filter so the share is always scoped.
  if (body.filter == null) {
    writeJson(res, 400, { error: "filter is required when issuing a share token" });
    return;
  }

  const semanticQuery = body.semanticQuery?.trim();

  // `{}` is not null but scopes nothing. A semantic share may have an empty base
  // filter (its query is the scope, resolved per request), but its base filter
  // must still compile; every other share must restrict something. Enforcement
  // checks the resolved filter again on each request.
  try {
    if (semanticQuery) {
      filterToSQL(body.filter, { strict: true });
    } else {
      assertShareFilterIsScoped(body.filter);
    }
  } catch (error) {
    if (error instanceof FilterCompileError || error instanceof ShareScopeError) {
      writeJson(res, 400, {
        error:
          error instanceof FilterCompileError
            ? `Invalid share filter: ${error.message}`
            : "A share link must be limited to a folder, a filter or a search",
      });
      return;
    }
    throw error;
  }
  const searchSources = normalizeShareSearchSources(body.searchSources);
  if (body.searchSources !== undefined && searchSources === null) {
    writeJson(res, 400, {
      error: "searchSources must contain at least one valid source",
    });
    return;
  }

  const scope: ShareScope<unknown> = {
    filter: body.filter,
    ...(semanticQuery ? { semanticQuery } : {}),
    ...(searchSources && searchSources.length < SEARCH_SOURCES.length
      ? { searchSources }
      : {}),
  };

  // Preflight: how many items would this share actually grant?
  //
  // Counted through `resolveShareFilter` — the *same* resolution the enforcement
  // path uses — so a semantic share is measured by what it really matches rather
  // than by its unresolved base filter (which is frequently `{}` and would read
  // as the whole library). Returns before minting, so the UI can warn about an
  // oversized share without leaving an unused token behind, and without paying
  // for the description model on a share that may never be created.
  if (parsedUrl.searchParams.get("dryRun") === "1") {
    try {
      const resolvedFilter = await resolveShareFilter(scope);
      const { total } = await database.queryFiles({
        filter: resolvedFilter,
        metadata: [],
        pageSize: 1,
      });
      writeJson(res, 200, { count: total });
    } catch (error) {
      if (error instanceof ShareScopeError) {
        writeJson(res, error.statusCode, { error: error.message });
        return;
      }
      throw error;
    }
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
          filter: body.filter,
          ...(semanticQuery ? { semanticQuery } : {}),
          database,
        });

  const shareToken = issueShareToken({ ...scope, description: label });

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

  const body = await readJsonRequest<{ username?: unknown }>(req, res);
  if (!body) return;

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

  const body = await readJsonRequest<{ sessionId?: unknown; response?: unknown }>(req, res);
  if (!body) return;

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

  const body = await readJsonRequest<{ sessionId?: unknown; response?: unknown }>(req, res);
  if (!body) return;

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
  const body = await readJsonRequest<{ token?: unknown }>(req, res);
  if (!body) return;

  if (typeof body.token === "string") {
    await revokeToken(body.token);
  }

  writeJson(res, 200, { ok: true });
};
