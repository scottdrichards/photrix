import type http from "node:http";
import path from "node:path";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { decodeRequestPath } from "../common/decodeRequestPath.ts";
import { suggestRotation } from "../imageProcessing/suggestRotation.ts";
import { writeJson } from "../utils.ts";

type Options = {
  database: IndexDatabase;
  storageRoot: string;
};

const isPathInsideStorage = (storageRoot: string, targetPath: string): boolean => {
  const relativeToStorage = path.relative(storageRoot, targetPath);
  return !relativeToStorage.startsWith("..") && !path.isAbsolute(relativeToStorage);
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
  const subPath = decodeRequestPath(rawPath);
  const normalizedPath = path.join(storageRoot, subPath);
  if (!isPathInsideStorage(storageRoot, normalizedPath)) {
    writeJson(res, 403, { error: "Access denied" });
    return;
  }

  const fileRecord = await database.getFileRecord(subPath).catch(() => undefined);
  if (fileRecord?.mimeType && !fileRecord.mimeType.startsWith("image/")) {
    writeJson(res, 200, { angle: null });
    return;
  }

  const suggestion = await suggestRotation(normalizedPath);
  writeJson(res, 200, suggestion);
};
