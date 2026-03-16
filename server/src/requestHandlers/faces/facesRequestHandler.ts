import type * as http from "http";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import type { FaceQueueStatus } from "../../indexDatabase/indexDatabase.type.ts";
import { writeJson } from "../../utils.ts";

type Options = {
  database: IndexDatabase;
};

const validStatuses: FaceQueueStatus[] = ["unverified", "confirmed", "rejected"];

const parseJsonBody = async (req: http.IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf-8").trim();
  if (rawBody.length === 0) {
    return {};
  }

  return JSON.parse(rawBody);
};

export const facesRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database }: Options,
) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/faces/queue") {
      const statusParam = url.searchParams.get("status");
      const personIdParam = url.searchParams.get("personId")?.trim();
      const pageParam = Number.parseInt(url.searchParams.get("page") ?? "", 10);
      const pageSizeParam = Number.parseInt(url.searchParams.get("pageSize") ?? "", 10);
      const minConfidenceParam = Number.parseFloat(
        url.searchParams.get("minConfidence") ?? "",
      );
      const pathParam = url.searchParams.get("path")?.trim() || undefined;
      const includeSubfoldersRaw = url.searchParams.get("includeSubfolders");
      const includeSubfolders =
        includeSubfoldersRaw === null ? undefined : includeSubfoldersRaw === "true";

      if (statusParam && !validStatuses.includes(statusParam as FaceQueueStatus)) {
        writeJson(res, 400, { error: "Invalid status" });
        return;
      }

      const queue = database.queryFaceQueue({
        ...(statusParam ? { status: statusParam as FaceQueueStatus } : {}),
        ...(personIdParam ? { personId: personIdParam } : {}),
        ...(Number.isFinite(pageParam) ? { page: pageParam } : {}),
        ...(Number.isFinite(pageSizeParam) ? { pageSize: pageSizeParam } : {}),
        ...(Number.isFinite(minConfidenceParam)
          ? { minConfidence: minConfidenceParam }
          : {}),
        ...(pathParam ? { path: pathParam } : {}),
        ...(includeSubfolders !== undefined ? { includeSubfolders } : {}),
      });

      writeJson(res, 200, queue);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/faces/people") {
      const pathParam = url.searchParams.get("path")?.trim() || undefined;
      const includeSubfoldersRaw = url.searchParams.get("includeSubfolders");
      const includeSubfolders =
        includeSubfoldersRaw === null ? undefined : includeSubfoldersRaw === "true";
      writeJson(res, 200, {
        people: database.queryFacePeople({
          ...(pathParam ? { path: pathParam } : {}),
          ...(includeSubfolders !== undefined ? { includeSubfolders } : {}),
        }),
      });
      return;
    }

    const matchesMatch = url.pathname.match(/^\/api\/faces\/([^/]+)\/matches$/);
    if (req.method === "GET" && matchesMatch) {
      const [, encodedFaceId] = matchesMatch;
      const faceId = decodeURIComponent(encodedFaceId ?? "");
      const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);

      if (!faceId) {
        writeJson(res, 400, { error: "faceId is required" });
        return;
      }

      const items = database.queryFaceMatches({
        faceId,
        ...(Number.isFinite(limitParam) ? { limit: limitParam } : {}),
      });
      writeJson(res, 200, { items });
      return;
    }

    const personSuggestionsMatch = url.pathname.match(
      /^\/api\/faces\/people\/([^/]+)\/suggestions$/,
    );
    if (req.method === "GET" && personSuggestionsMatch) {
      const [, encodedPersonId] = personSuggestionsMatch;
      const personId = decodeURIComponent(encodedPersonId ?? "");
      const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);

      if (!personId.trim()) {
        writeJson(res, 400, { error: "personId is required" });
        return;
      }

      const items = database.queryPersonFaceSuggestions({
        personId,
        ...(Number.isFinite(limitParam) ? { limit: limitParam } : {}),
      });
      writeJson(res, 200, { items });
      return;
    }

    const actionMatch = url.pathname.match(/^\/api\/faces\/([^/]+)\/(accept|reject)$/);

    if (req.method === "POST" && actionMatch) {
      const [, encodedFaceId, action] = actionMatch;
      const faceId = decodeURIComponent(encodedFaceId ?? "");
      const payload = (await parseJsonBody(req)) as {
        personId?: string;
        personName?: string;
        reviewer?: string;
      };

      if (!faceId) {
        writeJson(res, 400, { error: "faceId is required" });
        return;
      }

      if (action === "accept") {
        if (!payload.personId && !payload.personName) {
          writeJson(res, 400, { error: "personId or personName is required" });
          return;
        }

        const updated = database.acceptFaceSuggestion({
          faceId,
          personId: payload.personId,
          personName: payload.personName,
          reviewer: payload.reviewer,
        });

        if (!updated) {
          writeJson(res, 404, { error: "Face not found" });
          return;
        }

        writeJson(res, 200, { ok: true, action: "accept", faceId });
        return;
      }

      const updated = database.rejectFaceSuggestion({
        faceId,
        personId: payload.personId,
        reviewer: payload.reviewer,
      });

      if (!updated) {
        writeJson(res, 404, { error: "Face not found" });
        return;
      }

      writeJson(res, 200, { ok: true, action: "reject", faceId });
      return;
    }

    writeJson(res, 404, { error: "Face endpoint not found" });
  } catch (error) {
    writeJson(res, 400, {
      error: "Invalid faces request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
