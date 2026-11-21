import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { decodeRequestPath } from "../common/decodeRequestPath.ts";
import { resolveMediaPath } from "../common/pathContainment.ts";
import { suggestRotation } from "../imageProcessing/suggestRotation.ts";
import { writeJson } from "../common/writeJson.ts";

type Options = {
  database: IndexDatabase;
  storageRoot: string;
};

/**
 * GET /api/photos/suggest-rotation?path=<folder+fileName> — feedback #66's
 * bounded auto-straighten suggestion. `{ angle: null }` means "no confident
 * suggestion" (most photos — see detect_horizon.py's gating); a non-null
 * angle is degrees to rotate, meant to prefill the existing manual
 * straighten control in PhotoEditor, never applied automatically.
 */
export const suggestRotationRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database, storageRoot }: Options,
): Promise<void> => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    writeJson(res, 400, { error: "Missing path parameter" });
    return;
  }
  // `searchParams` has already decoded once; the second decode is historical,
  // and containment is checked on the fully decoded result.
  const resolved = await resolveMediaPath(storageRoot, decodeRequestPath(rawPath));
  if (!resolved.ok) {
    writeJson(res, resolved.status, { error: resolved.error });
    return;
  }
  const subPath = resolved.relativePath;
  const normalizedPath = resolved.absolutePath;

  const fileRecord = await database.getFileRecord(subPath);
  if (fileRecord?.mimeType && !fileRecord.mimeType.startsWith("image/")) {
    writeJson(res, 200, { angle: null });
    return;
  }

  const suggestion = await suggestRotation(normalizedPath);
  writeJson(res, 200, suggestion);
};
