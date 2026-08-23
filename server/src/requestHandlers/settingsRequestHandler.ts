import type * as http from "http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { QueryOptions } from "../indexDatabase/indexDatabase.type.ts";
import { writeJson } from "../utils.ts";

const readJsonBody = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });

/**
 * Single-user app settings (feedback #95). Currently just the default
 * exclusion filter — a standing "hide these by default" filter (e.g. a face
 * cluster or folder) applied to every /api/files-backed view unless the
 * caller passes `includeExcluded=true`. See queryHandler.ts for where it's
 * actually applied.
 */
export const settingsRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  database: IndexDatabase,
): Promise<void> => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/settings/default-exclusion" && req.method === "GET") {
    const filter = await database.getDefaultExclusionFilter();
    writeJson(res, 200, { filter });
    return;
  }

  if (url.pathname === "/api/settings/default-exclusion" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const filter = (body as { filter?: QueryOptions["filter"] | null }).filter ?? null;
    await database.setDefaultExclusionFilter(filter);
    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { error: "Not found" });
};
