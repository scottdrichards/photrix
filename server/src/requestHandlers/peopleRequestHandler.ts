import type * as http from "http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { writeJson } from "../utils.ts";
import { invalidateNamedCentroidCache } from "./faceIdentifyRequestHandler.ts";

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

export const peopleRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  database: IndexDatabase,
): Promise<void> => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Every route below renames, merges or separates a cluster, all of which
  // change which centroids belong to which name. Drop the identify endpoint's
  // TTL cache up front so a person named here is recognizable at the door on
  // the next event rather than up to a minute later.
  invalidateNamedCentroidCache();

  // POST /api/people/rename — rename a cluster
  if (url.pathname === "/api/people/rename" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as Record<string, unknown>).clusterId !== "string"
    ) {
      writeJson(res, 400, { error: "Missing clusterId" });
      return;
    }
    const { clusterId, name } = body as { clusterId: string; name?: string | null };
    const ok = await database.renameCluster(clusterId, name ?? null);
    if (!ok) {
      writeJson(res, 404, { error: "Cluster not found" });
      return;
    }
    writeJson(res, 200, { ok: true });
    return;
  }

  // POST /api/people/merge — merge one or more source clusters into a target
  if (url.pathname === "/api/people/merge" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const b = body as Record<string, unknown>;
    if (typeof b.targetClusterId !== "string" || !Array.isArray(b.sourceClusterIds)) {
      writeJson(res, 400, { error: "Missing targetClusterId or sourceClusterIds" });
      return;
    }
    const sourceIds = b.sourceClusterIds as string[];
    for (const sourceId of sourceIds) {
      await database.mergeClusters(sourceId, b.targetClusterId);
    }
    writeJson(res, 200, { ok: true });
    return;
  }

  // POST /api/people/exclude-face — remove one outlier detection from its cluster (feedback #90)
  if (url.pathname === "/api/people/exclude-face" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const faceId = (body as Record<string, unknown>).faceId;
    if (typeof faceId !== "number" || !Number.isFinite(faceId)) {
      writeJson(res, 400, { error: "Missing faceId" });
      return;
    }
    const ok = await database.excludeFaceFromCluster(faceId);
    if (!ok) {
      writeJson(res, 404, { error: "Face not found or not currently clustered" });
      return;
    }
    writeJson(res, 200, { ok: true });
    return;
  }

  // POST /api/people/separate — detach one centroid from a named person
  if (url.pathname === "/api/people/separate" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as Record<string, unknown>).clusterId !== "string"
    ) {
      writeJson(res, 400, { error: "Missing clusterId" });
      return;
    }
    const ok = await database.separateCluster((body as { clusterId: string }).clusterId);
    if (!ok) {
      writeJson(res, 404, { error: "Cluster not found or cannot be separated" });
      return;
    }
    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { error: "Not found" });
};
