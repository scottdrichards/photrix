import type http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { decodeRequestPath } from "../common/decodeRequestPath.ts";
import { getRequestAbortSignal } from "../common/requestAbort.ts";
import { getCachedPhotoCaption, setCachedPhotoCaption } from "../photoCaption/photoCaptionCache.ts";
import { generatePhotoCaption } from "../photoCaption/generatePhotoCaption.ts";
import { convertImage } from "../imageProcessing/convertImage.ts";
import { getLogger } from "../observability/logger.ts";
import { writeJson } from "../utils.ts";

// Downscale before sending to the vision model. A full-resolution source
// (commonly 3000-4000px tall in this library) tokenizes to well over the
// model's default 4096-token context on its own — an unrelated system
// prompt or metadata line then pushes it over into
// `exceed_context_size_error` (400). 640px keeps prompt tokens comfortably
// inside the default context and, per the ~90s/~236s split measured while
// building this, is the difference between the confirmed ~90-100s call and
// a multi-minute one. This also reuses the existing mirrored image-variant
// cache (convertImage), so it costs nothing beyond the first request for
// any given photo — the same 640px variant likely already exists from
// thumbnail generation.
const CAPTION_IMAGE_HEIGHT = 640;

const log = getLogger("photoCaptionRequestHandler");

type Options = {
  database: IndexDatabase;
  storageRoot: string;
};

const isPathInsideStorage = (storageRoot: string, targetPath: string): boolean => {
  const relativeToStorage = path.relative(storageRoot, targetPath);
  return !relativeToStorage.startsWith("..") && !path.isAbsolute(relativeToStorage);
};

/**
 * GET /api/photos/caption?path=<folder+fileName> — a short (<=6 word) AI
 * caption for a photo, generated from its pixels + metadata via a vision
 * model on Ollama. Used by the fullscreen viewer for a toast + the browser
 * tab title while a photo is open.
 *
 * Cached on disk after first generation (see photoCaptionCache.ts) — a real
 * call takes ~90-100s on the current Ollama host, so this must never be the
 * hot path twice for the same photo.
 *
 * Best-effort: any failure (missing file, Ollama down/slow/unusable reply)
 * yields `{ caption: null }` with a 200, never a 500 — a caption is a
 * non-essential enhancement and must not break photo viewing.
 */
export const photoCaptionRequestHandler = async (
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

  const cached = await getCachedPhotoCaption(normalizedPath);
  if (cached) {
    writeJson(res, 200, { caption: cached });
    return;
  }

  const fileRecord = await database.getFileRecord(subPath).catch(() => undefined);
  if (fileRecord?.mimeType && !fileRecord.mimeType.startsWith("image/")) {
    // Captions are photo-only for now (the vision model takes a single
    // still frame, not video) — videos/other files silently get no caption
    // rather than an error.
    writeJson(res, 200, { caption: null });
    return;
  }

  try {
    const [peopleFaces, resizedImagePath] = await Promise.all([
      database.getPeopleFacesForFile(subPath).catch(() => []),
      convertImage(normalizedPath, CAPTION_IMAGE_HEIGHT, { format: "jpeg" }),
    ]);
    const imageBytes = await readFile(resizedImagePath);

    const peopleNames = [...new Set(peopleFaces.map((f) => f.name).filter((n): n is string => !!n))];

    const caption = await generatePhotoCaption(
      imageBytes.toString("base64"),
      {
        peopleNames,
        dateTaken: fileRecord?.dateTaken ?? null,
        folder: fileRecord?.folder ?? path.dirname(subPath),
      },
      // Let the client's own disconnect (photo changed / viewer closed) cut
      // this short instead of burning the full ~90s on a call nobody's
      // waiting for anymore.
      { signal: getRequestAbortSignal() },
    );

    if (!caption) {
      writeJson(res, 200, { caption: null });
      return;
    }

    await setCachedPhotoCaption(normalizedPath, caption).catch((error) => {
      log.warn({ err: error, subPath }, "Failed to cache photo caption");
    });
    writeJson(res, 200, { caption });
  } catch (error) {
    log.warn({ err: error, subPath }, "Photo caption generation failed");
    writeJson(res, 200, { caption: null });
  }
};
