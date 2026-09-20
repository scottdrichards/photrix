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

  // GET /api/people/tags — distinct tags across every person, for suggestions
  if (url.pathname === "/api/people/tags" && req.method === "GET") {
    const tags = await database.getAllPersonTags();
    writeJson(res, 200, { tags });
    return;
  }

  // GET /api/people/named — every named person (id + name), for the
  // fullscreen face-assign panel's "type an existing name" autocomplete.
  if (url.pathname === "/api/people/named" && req.method === "GET") {
    const people = await database.listNamedPeople();
    writeJson(res, 200, { people });
    return;
  }

  // GET /api/people/cluster-preview — a few other sightings of one cluster's
  // person, so the face-assign panel can show "does this look right?" before
  // naming/merging. `excludeFaceId` (optional) omits the face the panel was
  // opened from; `limit` (optional, default 6) caps how many come back.
  if (url.pathname === "/api/people/cluster-preview" && req.method === "GET") {
    const clusterId = url.searchParams.get("clusterId");
    if (!clusterId) {
      writeJson(res, 400, { error: "Missing clusterId parameter" });
      return;
    }
    const limitParam = url.searchParams.get("limit");
    const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
    const excludeFaceIdParam = url.searchParams.get("excludeFaceId");
    const parsedExcludeFaceId = excludeFaceIdParam
      ? Number.parseInt(excludeFaceIdParam, 10)
      : NaN;
    const faces = await database.getClusterFacePreview(clusterId, {
      ...(Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
      ...(Number.isFinite(parsedExcludeFaceId) ? { excludeFaceId: parsedExcludeFaceId } : {}),
    });
    writeJson(res, 200, { faces });
    return;
  }

  // POST /api/people/tags — replace a person's tag list
  if (url.pathname === "/api/people/tags" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const b = body as Record<string, unknown>;
    if (typeof b.clusterId !== "string" || !Array.isArray(b.tags)) {
      writeJson(res, 400, { error: "Missing clusterId or tags" });
      return;
    }
    const tags = b.tags.filter((t): t is string => typeof t === "string");
    const ok = await database.setClusterTags(b.clusterId, tags);
    if (!ok) {
      writeJson(res, 404, { error: "Cluster not found" });
      return;
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

  // GET /api/people/review — one person's faces ordered by distance from their
  // reference point, each with its anomaly signals, plus a suggested cut line.
  // The backing view for the review UI; see indexDatabase.getFaceClusterReview.
  if (url.pathname === "/api/people/review" && req.method === "GET") {
    const clusterId = url.searchParams.get("clusterId");
    if (!clusterId) {
      writeJson(res, 400, { error: "Missing clusterId parameter" });
      return;
    }
    const review = await database.getFaceClusterReview(clusterId);
    if (!review) {
      writeJson(res, 404, { error: "Cluster not found" });
      return;
    }
    writeJson(res, 200, review);
    return;
  }

  // POST /api/people/cutoff — "this face and everything below it is not them".
  //
  // `threshold: null` clears the person's radius instead of applying one.
  // `dryRun: true` reports the count without changing anything, which is what
  // lets the UI label the button with a real number while the line is dragged.
  if (url.pathname === "/api/people/cutoff" && req.method === "POST") {
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
    if (b.threshold === null) {
      const cleared = await database.clearFaceClusterRadius(b.clusterId);
      if (!cleared) {
        writeJson(res, 404, { error: "Cluster not found" });
        return;
      }
      writeJson(res, 200, { ok: true, affected: 0 });
      return;
    }
    if (typeof b.threshold !== "number" || !Number.isFinite(b.threshold)) {
      writeJson(res, 400, { error: "threshold must be a number or null" });
      return;
    }
    const result = await database.applyFaceClusterCutoff(b.clusterId, b.threshold, {
      dryRun: b.dryRun === true,
    });
    if (!result) {
      writeJson(res, 404, { error: "Cluster not found" });
      return;
    }
    writeJson(res, 200, { ok: true, ...result });
    return;
  }

  // POST /api/people/verdict — record (or with verdict null, withdraw) the
  // user's judgement on specific faces. Takes a list: the review UI's whole
  // point is acting on many faces at once.
  if (url.pathname === "/api/people/verdict" && req.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const b = body as Record<string, unknown>;
    const faceIds = Array.isArray(b.faceIds)
      ? b.faceIds.filter((id): id is number => typeof id === "number" && Number.isFinite(id))
      : [];
    if (!faceIds.length) {
      writeJson(res, 400, { error: "Missing faceIds" });
      return;
    }
    if (b.verdict !== "confirmed" && b.verdict !== "rejected" && b.verdict !== null) {
      writeJson(res, 400, { error: "verdict must be confirmed, rejected or null" });
      return;
    }
    const applied = await database.setFaceVerdicts(faceIds, b.verdict);
    writeJson(res, 200, { ok: true, applied });
    return;
  }

  // GET /api/people/optimize — a dry-run library-wide repair plan. Applying a
  // proposal is a normal /merge or /cutoff call; nothing here changes state.
  if (url.pathname === "/api/people/optimize" && req.method === "GET") {
    const minWeightParam = Number.parseInt(url.searchParams.get("minWeight") ?? "", 10);
    const proposals = await database.planFaceClusterOptimization(
      Number.isFinite(minWeightParam) ? { minWeight: minWeightParam } : {},
    );
    writeJson(res, 200, { proposals });
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
