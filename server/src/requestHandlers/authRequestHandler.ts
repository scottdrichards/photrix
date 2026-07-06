import type http from "node:http";
import {
  extractToken,
  isShareToken,
  issueShareToken,
  revokeToken,
  validatePassword,
  validateToken,
} from "../auth/authService.ts";
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
  let body: { password?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { password?: unknown };
  } catch {
    writeJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (typeof body.password !== "string") {
    writeJson(res, 400, { error: "password required" });
    return;
  }

  const token = validatePassword(body.password);
  if (!token) {
    writeJson(res, 401, { error: "Invalid password" });
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

  let body: { filter?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { filter?: unknown };
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

  writeJson(res, 200, { token: issueShareToken(body.filter) });
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
