import type * as http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { markCacheAccess } from "../../common/cacheEviction.ts";

type ByteRange = { start: number; end: number };

/**
 * A single `bytes=start-[end]` Range header against a body of `size` bytes, or
 * null when absent or unsatisfiable (the caller then sends the whole body).
 */
export const parseByteRange = (rangeHeader: string | undefined, size: number): ByteRange | null => {
  const match = rangeHeader?.match(/^bytes=(\d+)-(\d+)?$/);
  if (!match) return null;
  const start = Number.parseInt(match[1] ?? "", 10);
  const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < size)
    return { start, end };
  return null;
};

/**
 * Streams the bytes `[offset, offset + size)` of `filePath` as a whole body of
 * `size` bytes, honouring a Range header against that body.
 */
const streamSlice = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  opts: { offset: number; contentType: string; size: number; cacheControl: string; acceptRanges: boolean },
) => {
  const { offset, contentType, size, cacheControl, acceptRanges } = opts;
  const range = parseByteRange(req.headers.range, size);
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    ...(acceptRanges ? { "Accept-Ranges": "bytes" } : {}),
    "content-length": range ? range.end - range.start + 1 : size,
  };
  if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  const fileStream =
    offset === 0 && !range
      ? createReadStream(filePath)
      : createReadStream(filePath, {
          start: offset + (range?.start ?? 0),
          end: offset + (range?.end ?? size - 1),
        });
  fileStream.on("error", (error) => {
    res.destroy(error);
  });
  fileStream.pipe(res);
};

/** Streams a whole file, honouring a Range header. */
export const streamFile = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  opts: { contentType: string; size: number; cacheControl: string; acceptRanges?: boolean },
) => streamSlice(req, res, filePath, { offset: 0, acceptRanges: false, ...opts });

/**
 * Streams the tail of a file that embeds a video after its image (a motion
 * photo) as a standalone MP4, so range requests address the video alone.
 */
export const streamEmbeddedVideo = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  { offset, size }: { offset: number; size: number },
) =>
  streamSlice(req, res, filePath, {
    offset,
    size,
    contentType: "video/mp4",
    cacheControl: "public, max-age=31536000, immutable",
    acceptRanges: true,
  });

const streamStaticFile = (
  res: http.ServerResponse,
  filePath: string,
  opts: { contentType: string; size: number; cacheControl: string },
) => {
  res.writeHead(200, {
    "Content-Type": opts.contentType,
    "Content-Length": opts.size,
    "Cache-Control": opts.cacheControl,
  });
  const fileStream = createReadStream(filePath);
  fileStream.on("error", (error) => {
    res.destroy(error);
  });
  fileStream.pipe(res);
};

/** Streams a file from the derived-file cache: immutable unless told otherwise. */
export const streamCachedFile = async (
  res: http.ServerResponse,
  filePath: string,
  { contentType, cacheControl = "public, max-age=31536000, immutable" }: { contentType: string; cacheControl?: string },
) => {
  const { size } = await stat(filePath);
  // Bump the file's timestamp so the cache eviction policy treats it as
  // recently used (approximate LRU).
  markCacheAccess(filePath);
  streamStaticFile(res, filePath, { contentType, size, cacheControl });
};

/**
 * Streams an HLS segment. Segments are ephemeral, deleted after playback, so
 * they must not be cached by the browser or any intermediary.
 */
export const streamHlsSegment = async (res: http.ServerResponse, segmentPath: string) => {
  const { size } = await stat(segmentPath);
  streamStaticFile(res, segmentPath, { contentType: "video/mp2t", cacheControl: "no-store", size });
};

/** Answers with a playlist. HLS here is ephemeral, so playlists are never cached. */
export const writeHlsPlaylist = (
  res: http.ServerResponse,
  content: string,
  durationSeconds: number | null,
) => {
  res.writeHead(200, {
    "Content-Type": "application/vnd.apple.mpegurl",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(content, "utf-8"),
    ...(durationSeconds !== null && Number.isFinite(durationSeconds)
      ? { "X-Content-Duration": String(durationSeconds) }
      : {}),
  });
  res.end(content);
};
