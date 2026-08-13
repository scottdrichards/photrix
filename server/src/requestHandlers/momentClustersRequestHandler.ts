import type * as http from "http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { writeJson } from "../utils.ts";

const readJsonBody = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });

/**
 * Mutating endpoints for moment clusters (burst/near-duplicate stacks) — the
 * two persistent user actions the gallery's expanded-stack view offers:
 * picking a different representative, and permanently dissolving the stack.
 * Mirrors peopleRequestHandler.ts's shape (rename/merge/separate) for face
 * clusters. Read access (fetching a cluster's members) goes through the
 * regular /api/files query endpoint's `aggregate=momentClusterDetail`, same
 * as face clusters' `aggregate=peopleClusterDetail`.
 */
export const momentClustersRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  database: IndexDatabase,
): Promise<void> => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // POST /api/moment-clusters/representative — override the auto-picked
  // representative and pin the choice so background re-scoring never
  // overwrites it.
  if (url.pathname === "/api/moment-clusters/representative" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const b = body as Record<string, unknown>;
    if (typeof b.clusterId !== "string" || typeof b.path !== "string") {
      writeJson(res, 400, { error: "Missing clusterId or path" });
      return;
    }
    const ok = await database.setMomentClusterRepresentative(b.clusterId, b.path);
    if (!ok) {
      writeJson(res, 404, { error: "Cluster or member not found" });
      return;
    }
    writeJson(res, 200, { ok: true });
    return;
  }

  // POST /api/moment-clusters/dissolve — permanently break the stack apart.
  // Every member goes back to showing individually in the gallery from now on
  // (the background task never re-clusters an already-processed file). The
  // client-only "temporary" unstack never calls this.
  if (url.pathname === "/api/moment-clusters/dissolve" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const b = body as Record<string, unknown>;
    if (typeof b.clusterId !== "string") {
      writeJson(res, 400, { error: "Missing clusterId" });
      return;
    }
    const ok = await database.dissolveMomentCluster(b.clusterId);
    if (!ok) {
      writeJson(res, 404, { error: "Cluster not found" });
      return;
    }
    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { error: "Not found" });
};
