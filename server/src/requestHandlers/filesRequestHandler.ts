import * as http from "http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { FilterCondition, QueryOptions } from "../indexDatabase/indexDatabase.type.ts";
import { rename, stat, unlink } from "fs/promises";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { createReadStream, createWriteStream } from "fs";
import path from "path/win32";
import { convertImage, convertImageToMultipleSizes } from "../imageProcessing/convertImage.ts";
import { generateVideoPreview, generateVideoThumbnail, generateWebSafeVideo } from "../videoProcessing/videoUtils.ts";
import { StandardHeight, standardHeights } from "../common/standardHeights.ts";
import { mediaProcessingQueue } from "../common/processingQueue.ts";
import { getCachedFilePath, getHash } from "../common/cacheUtils.ts";
import { spawn } from "child_process";
import { upsertTranscodeStatus, removeTranscodeStatus } from "../videoProcessing/transcodeStatus.ts";

type Options = {
  database: IndexDatabase;
  storageRoot: string;
};

export const filesRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database, storageRoot }: Options,
) => {
  try {
    // Pause background generation for 1 minute when a request comes in
    mediaProcessingQueue.pause(60_000);
    
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Extract path after /api/files/ and decode URL escape characters
    const pathMatch = url.pathname.match(/^\/api\/files\/(.+)/);
    const subPath = pathMatch ? decodeURIComponent(pathMatch[1]) : null;

    // Determine if this is a query (ends with /) or file request (no trailing slash)
    // Query mode REQUIRES trailing slash (e.g., /api/files/ or /api/files/subfolder/)
    const isQuery = !subPath || subPath.endsWith("/");

    if (isQuery) {
      // QUERY MODE: Return list of files
      await queryHandler(url, subPath, database, res);
    } else {
      // FILE MODE: Serve individual file
      await fileHandler(req, url, subPath, storageRoot, res);
    }
  } catch (error) {
    console.error("Error processing files request:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
};

const streamFile = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  opts: {
    contentType: string;
    size: number;
    cacheControl: string;
    acceptRanges?: boolean;
  },
) => {
  const { contentType, size, cacheControl, acceptRanges = false } = opts;
  const rangeHeader = req.headers.range;

  if (typeof rangeHeader === "string") {
    const match = rangeHeader.match(/^bytes=(\d+)-(\d+)?$/);
    if (match) {
      const start = Number.parseInt(match[1] ?? "", 10);
      const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;

      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < size) {
        res.writeHead(206, {
          "Content-Type": contentType,
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          ...(acceptRanges ? { "Accept-Ranges": "bytes" } : {}),
          "Cache-Control": cacheControl,
        });

        const fileStream = createReadStream(filePath, { start, end });
        fileStream.on("error", (error) => {
          console.error("Error streaming ranged file:", error);
          res.destroy(error);
        });
        fileStream.pipe(res);
        return;
      }

      res.writeHead(416, {
        "Content-Range": `bytes */${size}`,
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Requested Range Not Satisfiable" }));
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": size,
    ...(acceptRanges ? { "Accept-Ranges": "bytes" } : {}),
    "Cache-Control": cacheControl,
  });

  const fileStream = createReadStream(filePath);
  fileStream.on("error", (error) => {
    console.error("Error streaming file:", error);
    res.destroy(error);
  });
  fileStream.pipe(res);
};

/**
 * If no "metadata" provided in query params, default will just be a list of paths
 * @param url 
 * @param subPath MUST start and end with slash ("/" for root)
 * @param database 
 * @param res 
 * @returns 
 */
const queryHandler = async (
  url: URL,
  subPath: string | null,
  database: IndexDatabase,
  res: http.ServerResponse,
) => {
  const filterParam = url.searchParams.get("filter");
  const metadataParam = url.searchParams.get("metadata");
  const pageSize = url.searchParams.get("pageSize");
  const page = url.searchParams.get("page");
  const countOnly = url.searchParams.get("count") === "true";
  const includeSubfolders = url.searchParams.get("includeSubfolders") === "true";

  const folder:FilterCondition|null = subPath === null ?null: {
    folder: subPath ?? "/",
    recursive: includeSubfolders
  }

  const filter = {
    ...folder,
    ...(filterParam && JSON.parse(filterParam)),
  }

  const metadata = (()=>{
    if (!metadataParam){
      return [];
    }
    try{
      return JSON.parse(metadataParam);
    }catch{
      return metadataParam.split(',').map(s=>s.trim()).filter(Boolean)
    }
  })();

  const queryOptions = {
    filter,
    metadata: metadata as QueryOptions["metadata"],
    ...(pageSize && { pageSize: parseInt(pageSize, 10) }),
    ...(page && { page: parseInt(page, 10) }),
  };

  const result = await database.queryFiles(queryOptions);
  const responseBody = countOnly ? { count: result.total } : result;
  try {
    const payload = JSON.stringify(responseBody);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("invalid string length")) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Response too large",
          message:
            "The query result was too large to serialize. Try requesting fewer metadata fields or a smaller pageSize.",
        }),
      );
      return;
    }
    throw error;
  }
};

const fileHandler = async (
  req: http.IncomingMessage,
  url: URL,
  subPath: string,
  storageRoot: string,
  res: http.ServerResponse,
) => {
  if (!subPath) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing file path" }));
    return;
  }

  // Construct absolute path and check if it's within the storage path
  const normalizedPath = path.resolve(storageRoot, subPath);

  // Security check: ensure the path is within the storage directory
  // Use path.relative to check - if it starts with "..", it's outside
  const relativeToStorage = path.relative(storageRoot, normalizedPath);
  if (relativeToStorage.startsWith("..") || path.isAbsolute(relativeToStorage)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Access denied" }));
    return;
  }

  // Check if file exists and is a file
  let fileStats;
  try {
    fileStats = await stat(normalizedPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "File not found" }));
      return;
    }
    throw err;
  }

  if (!fileStats.isFile()) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "File not found" }));
    return;
  }

  // Determine content type
  const mimeType = mimeTypeForFilename(subPath) || "application/octet-stream";
  const representation = url.searchParams.get("representation");
  const heightParam = url.searchParams.get("height");

  const parseToStandardHeight = (value: string | null): StandardHeight | null => {
    const parsed = value && parseInt(value, 10);
    const nearest = standardHeights.find(h => typeof h === 'number' && typeof parsed === 'number' && h >= parsed) ?? 'original';

    if (nearest !== parsed){
      console.log(`Height (${value}) does not match standard height, using `, nearest);
    }
    return nearest;
  }

  const height = parseToStandardHeight(heightParam) ?? "original";

  const needsResize = height !== "original";
  const needsFormatChange =
    representation === "webSafe" &&
    (mimeType === "image/heic" || mimeType === "image/heif");

  const isImage = mimeType.startsWith("image/");
  const isVideo = mimeType.startsWith("video/");
  const streamTranscode = url.searchParams.get("stream") === "true";

  if (representation === "preview" && isVideo) {
    try {
      const queueSize = mediaProcessingQueue.getQueueSize();
      const processing = mediaProcessingQueue.getProcessing();
      console.log(`[filesRequest] Requesting video preview for: ${subPath} (queue: ${queueSize}, processing: ${processing})`);

      const cachedPath = await generateVideoPreview(normalizedPath, 320, 5_000, { priority: 'userBlocked' });
      const cachedStats = await stat(cachedPath);

      streamFile(req, res, cachedPath, {
        contentType: "video/mp4",
        size: cachedStats.size,
        cacheControl: "public, max-age=31536000",
        acceptRanges: true,
      });
      return;
    } catch (error) {
      console.error(`Error generating video preview for: ${subPath}`, error);
      // Fall through to stream the original file if conversion fails
    }
  }

  if (representation === "webSafe" && isVideo) {
    if (streamTranscode) {
      try {
        const modifiedTimeMs = (await stat(normalizedPath)).mtimeMs;
        const hash = getHash(normalizedPath, modifiedTimeMs);
        const cachedPath = getCachedFilePath(hash, `webSafe.${height}`, "mp4");

        // If already cached, serve the cached file with Range support.
        try {
          const cachedStats = await stat(cachedPath);
          streamFile(req, res, cachedPath, {
            contentType: "video/mp4",
            size: cachedStats.size,
            cacheControl: "public, max-age=31536000",
            acceptRanges: true,
          });
          return;
        } catch {
          // Not cached yet
        }

        const queueSize = mediaProcessingQueue.getQueueSize();
        const processing = mediaProcessingQueue.getProcessing();
        console.log(
          `[filesRequest] Streaming ${height} web-safe video for: ${subPath} (queue: ${queueSize}, processing: ${processing})`,
        );

        // Fragmented MP4 so the client can start playback before the file finishes.
        // We simultaneously write to a .part file and then rename into the cache when complete.
        const tempPath = `${cachedPath}.part`;
        const scaleFilter = height === "original" ? "-1:-2" : `-2:${height}`;
        const args = [
          "-y",
          "-i",
          normalizedPath,
          "-vf",
          `scale=${scaleFilter}`,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-preset",
          "fast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-movflags",
          "+frag_keyframe+empty_moov+default_base_moof",
          "-f",
          "mp4",
          "-progress",
          "pipe:2",
          "-nostats",
          "pipe:1",
        ];

        console.log(`[filesRequest] ffmpeg (stream webSafe) args: ${JSON.stringify(args)}`);
        const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

        const jobId = `webSafe:${height}:${normalizedPath.replace(/\\/g, "/")}`;
        upsertTranscodeStatus({
          id: jobId,
          kind: "webSafe",
          filePath: normalizedPath,
          height,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          state: "running",
        });

        // Send response headers early (no Content-Length => chunked transfer).
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Cache-Control": "public, max-age=31536000",
        });

        const fileOut = createWriteStream(tempPath);
        fileOut.on("error", (error) => {
          console.error("[filesRequest] Error writing streaming cache file:", error);
          try {
            ffmpeg.kill("SIGKILL");
          } catch {
            // ignore
          }
        });

        ffmpeg.stdout?.pipe(fileOut);
        ffmpeg.stdout?.pipe(res);

        // If the client disconnects, keep writing the cache file (but stop piping to res).
        res.on("close", () => {
          try {
            ffmpeg.stdout?.unpipe(res);
          } catch {
            // ignore
          }
        });

        // Parse progress from ffmpeg -progress output (stderr).
        let progressBuffer = "";
        ffmpeg.stderr?.on("data", (data) => {
          const text = data.toString();
          progressBuffer += text;
          const lines = progressBuffer.split(/\r?\n/);
          progressBuffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // -progress emits key=value lines.
            const [key, ...rest] = trimmed.split("=");
            if (!key || rest.length === 0) {
              // Also surface any other stderr to logs
              console.log(`[ffmpeg:webSafe:stderr] ${trimmed}`);
              continue;
            }
            const value = rest.join("=");
            if (key === "out_time_ms" || key === "speed" || key === "fps") {
              const outTimeMs = key === "out_time_ms" ? Number.parseInt(value, 10) : undefined;
              const outTimeSeconds = outTimeMs && Number.isFinite(outTimeMs) ? outTimeMs / 1_000_000 : undefined;
              upsertTranscodeStatus({
                id: jobId,
                kind: "webSafe",
                filePath: normalizedPath,
                height,
                startedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                state: "running",
                outTimeSeconds,
                speed: key === "speed" ? value : undefined,
                fps: key === "fps" ? Number.parseFloat(value) : undefined,
              });
            }
          }
        });

        ffmpeg.on("close", async (code) => {
          try {
            fileOut.end();
          } catch {
            // ignore
          }

          if (code === 0) {
            try {
              await rename(tempPath, cachedPath);
            } catch (error) {
              console.error("[filesRequest] Failed to finalize cached webSafe video:", error);
            }
            upsertTranscodeStatus({
              id: jobId,
              kind: "webSafe",
              filePath: normalizedPath,
              height,
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              state: "done",
              percent: 1,
            });
            removeTranscodeStatus(jobId);
            return;
          }

          console.error(`[filesRequest] ffmpeg webSafe stream failed (code ${code ?? "unknown"})`);
          upsertTranscodeStatus({
            id: jobId,
            kind: "webSafe",
            filePath: normalizedPath,
            height,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: "error",
            message: `ffmpeg exited with code ${code ?? "unknown"}`,
          });
          removeTranscodeStatus(jobId);
          try {
            await unlink(tempPath);
          } catch {
            // ignore
          }
        });

        ffmpeg.on("error", async (error) => {
          console.error("[filesRequest] Failed to start ffmpeg for streaming webSafe:", error);
          upsertTranscodeStatus({
            id: jobId,
            kind: "webSafe",
            filePath: normalizedPath,
            height,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: "error",
            message: error.message,
          });
          removeTranscodeStatus(jobId);
          try {
            await unlink(tempPath);
          } catch {
            // ignore
          }
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to start ffmpeg" }));
          } else {
            res.destroy(error);
          }
        });

        return;
      } catch (error) {
        console.error(`Error starting streaming web-safe video for: ${subPath}`, error);
        // Fall through to non-streaming path
      }
    }

    try {
      const queueSize = mediaProcessingQueue.getQueueSize();
      const processing = mediaProcessingQueue.getProcessing();
      console.log(
        `[filesRequest] Requesting ${height} web-safe video for: ${subPath} (queue: ${queueSize}, processing: ${processing})`,
      );

      const cachedPath = await generateWebSafeVideo(normalizedPath, height, { priority: "userBlocked" });
      const cachedStats = await stat(cachedPath);

      streamFile(req, res, cachedPath, {
        contentType: "video/mp4",
        size: cachedStats.size,
        cacheControl: "public, max-age=31536000",
        acceptRanges: true,
      });
      return;
    } catch (error) {
      console.error(`Error generating web-safe video for: ${subPath}`, error);
      // Fall through to thumbnail or original file if conversion fails
    }

    try {
      const queueSize = mediaProcessingQueue.getQueueSize();
      const processing = mediaProcessingQueue.getProcessing();
      console.log(
        `[filesRequest] Requesting ${height} thumbnail for video: ${subPath} (queue: ${queueSize}, processing: ${processing})`,
      );

      const cachedPath = await generateVideoThumbnail(normalizedPath, height, { priority: "userBlocked" });
      const cachedStats = await stat(cachedPath);

      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": cachedStats.size,
        "Cache-Control": "public, max-age=31536000",
      });

      const fileStream = createReadStream(cachedPath);
      fileStream.pipe(res);
      return;
    } catch (error) {
      console.error(`Error generating video thumbnail for: ${subPath}`, error);
      // Fall through to stream the original file if conversion fails
    }
  }

  if ((needsFormatChange || needsResize) && isImage) {
    try {
      const queueSize = mediaProcessingQueue.getQueueSize();
      const processing = mediaProcessingQueue.getProcessing();
      console.log(`[filesRequest] Requesting ${height} image for: ${subPath} (queue: ${queueSize}, processing: ${processing})`);

      // Generate all standard sizes in the background (except 'original') - low priority
      const allSizes = standardHeights.filter((h): h is Exclude<StandardHeight, "original"> => typeof h !== 'string');
      void convertImageToMultipleSizes(normalizedPath, allSizes, { priority: 'userImplicit' });
      
      // But wait for the requested size specifically - high priority
      const cachedPath = await convertImage(normalizedPath, height, { priority: 'userBlocked' });
      const cachedStats = await stat(cachedPath);

      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": cachedStats.size,
        "Cache-Control": "public, max-age=31536000",
      });

      const fileStream = createReadStream(cachedPath);
      fileStream.pipe(res);
      return;
    } catch (error) {
      console.error(`Error generating image for: ${subPath}`, error);
      // Fall through to stream the original file if conversion fails
    }
  } else if (needsResize && isVideo) {
    // Legacy behavior: if a client asks for a sized video without specifying a representation,
    // return a JPEG thumbnail rather than attempting a transcode.
    try {
      const queueSize = mediaProcessingQueue.getQueueSize();
      const processing = mediaProcessingQueue.getProcessing();
      console.log(
        `[filesRequest] Requesting ${height} thumbnail for video: ${subPath} (queue: ${queueSize}, processing: ${processing})`,
      );

      const cachedPath = await generateVideoThumbnail(normalizedPath, height, { priority: "userBlocked" });
      const cachedStats = await stat(cachedPath);

      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": cachedStats.size,
        "Cache-Control": "public, max-age=31536000",
      });

      const fileStream = createReadStream(cachedPath);
      fileStream.pipe(res);
      return;
    } catch (error) {
      console.error(`Error generating video thumbnail for: ${subPath}`, error);
      // Fall through to stream the original file if conversion fails
    }
  }

  // Stream the file
  streamFile(req, res, normalizedPath, {
    contentType: mimeType,
    size: fileStats.size,
    cacheControl: "public, max-age=31536000",
    acceptRanges: isVideo,
  });
};
