import type * as http from "http";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import { writeJson } from "../../utils.ts";
import { readJsonRequest } from "../../common/readBody.ts";

/**
 * PATCH /api/files/{path} — update the user-editable tagging fields (star
 * `rating`, freeform `tags`, and free-text `description`) on a single file.
 * Read-only share views are rejected; only the local/authenticated owner can
 * tag.
 */
export const updateFileMetadataHandler = async (
  req: http.IncomingMessage,
  subPath: string,
  res: http.ServerResponse,
  database: IndexDatabase,
  shareFilter: unknown,
): Promise<void> => {
  if (shareFilter) {
    writeJson(res, 403, { error: "Tagging is not permitted in a shared view" });
    return;
  }

  const body = await readJsonRequest<unknown>(req, res, { maxBytes: 64 * 1024, ifEmpty: {} });
  if (!body) return;

  if (typeof body !== "object" || body === null) {
    writeJson(res, 400, { error: "Body must be a JSON object" });
    return;
  }

  const { rating, tags, editAdj, description } = body as {
    rating?: unknown;
    tags?: unknown;
    editAdj?: unknown;
    description?: unknown;
  };
  const patch: {
    rating?: number | null;
    tags?: string[];
    editAdj?: string | null;
    description?: string | null;
  } = {};

  if ("rating" in body) {
    if (rating !== null && typeof rating !== "number") {
      writeJson(res, 400, { error: "rating must be a number or null" });
      return;
    }
    patch.rating = rating;
  }

  if ("tags" in body) {
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) {
      writeJson(res, 400, { error: "tags must be an array of strings" });
      return;
    }
    patch.tags = tags;
  }

  if ("editAdj" in body) {
    if (editAdj !== null && typeof editAdj !== "string") {
      writeJson(res, 400, { error: "editAdj must be a JSON string or null" });
      return;
    }
    if (typeof editAdj === "string") {
      try {
        JSON.parse(editAdj);
      } catch {
        writeJson(res, 400, { error: "editAdj must be valid JSON" });
        return;
      }
    }
    patch.editAdj = editAdj;
  }

  if ("description" in body) {
    if (description !== null && typeof description !== "string") {
      writeJson(res, 400, { error: "description must be a string or null" });
      return;
    }
    patch.description = description;
  }

  if (
    patch.rating === undefined &&
    patch.tags === undefined &&
    patch.editAdj === undefined &&
    patch.description === undefined
  ) {
    writeJson(res, 400, {
      error: "Provide at least one of: rating, tags, editAdj, description",
    });
    return;
  }

  const updated = await database.updateUserMetadata(subPath, patch);
  if (!updated) {
    writeJson(res, 404, { error: "File not found" });
    return;
  }

  writeJson(res, 200, { ok: true });
};
