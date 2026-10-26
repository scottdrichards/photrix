import type http from "node:http";
import { isFeatureFlagName } from "../../../shared/feature-flags/src/featureFlags.ts";
import { readJsonRequest } from "../common/readBody.ts";
import { attempt } from "../common/result.ts";
import { FeatureFlagPinnedError, type FeatureFlagStore } from "../featureFlags/featureFlagStore.ts";
import { writeJson } from "../utils.ts";

const PREFIX = "/api/feature-flags";

/**
 * GET /api/feature-flags          every flag's state. Open to share links too:
 *                                 the client needs them to render.
 * PUT /api/feature-flags/<name>   { "enabled": true | false | null } sets or clears
 *                                 the runtime override. Signed-in sessions only.
 */
export const featureFlagsRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { store, canChange }: { store: FeatureFlagStore; canChange: boolean },
): Promise<void> => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method === "GET" && pathname === PREFIX) {
    writeJson(res, 200, { flags: store.list() });
    return;
  }
  if (req.method !== "PUT" || !pathname.startsWith(`${PREFIX}/`)) {
    writeJson(res, 404, { error: "Not found" });
    return;
  }
  if (!canChange) {
    writeJson(res, 403, { error: "Forbidden" });
    return;
  }
  const name = decodeURIComponent(pathname.slice(PREFIX.length + 1));
  if (!isFeatureFlagName(name)) {
    writeJson(res, 404, { error: `No feature flag named "${name}"` });
    return;
  }
  const body = await readJsonRequest<{ enabled?: unknown }>(req, res);
  if (!body) return;
  if (body.enabled !== null && typeof body.enabled !== "boolean") {
    writeJson(res, 400, { error: "'enabled' must be true, false or null" });
    return;
  }
  const set = await attempt(store.setOverride(name, body.enabled));
  if (!set.ok && set.error instanceof FeatureFlagPinnedError) {
    writeJson(res, 409, { error: set.error.message });
    return;
  }
  if (!set.ok) throw set.error;
  writeJson(res, 200, { flags: store.list() });
};
