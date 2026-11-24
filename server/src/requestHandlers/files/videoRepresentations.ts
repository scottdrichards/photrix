import { stat } from "fs/promises";
import { attempt } from "../../common/result.ts";
import { writeJson } from "../../common/writeJson.ts";
import { getLogger } from "../../observability/logger.ts";
import {
  exportShareVideo,
  parseShareVideoShortSide,
} from "../../videoProcessing/exportShareVideo.ts";
import { serveHls } from "../../videoProcessing/hlsService.ts";
import {
  generateVideoThumbnail,
  generateVideoScrubFrame,
  generateVideoFrameCrop,
  VIDEO_SCRUB_FRAME_COUNT,
} from "../../videoProcessing/videoUtils.ts";
import { generateVideoStoryboard } from "../../videoProcessing/videoStoryboard.ts";
// Let the player tell a slow encoder from a slow network (feedback #178).
import {
  ENCODE_SPEED_HEADER,
  SEGMENT_WAIT_HEADER,
} from "@photrix/hls-segment-headers";
import { messageOf, unsupported, type FileHandlingContext } from "./fileHandlingContext.ts";
import {
  streamCachedFile,
  streamEmbeddedVideo,
  streamFile,
  streamHlsSegment,
  writeHlsPlaylist,
} from "./streamFile.ts";

// The video representations of /api/files: each maps the request to a
// videoProcessing call and its result to a response.

const storyboardLog = getLogger("storyboard");

export const tryVideoThumbnail = async (ctx: FileHandlingContext) => {
  if (!ctx.isVideo) return false;
  const isPreview = ctx.representation === "preview";
  const wantsThumb = isPreview || ctx.representation === "webSafe" || ctx.needsResize;
  if (!wantsThumb) return false;
  try {
    const cachedPath = await generateVideoThumbnail(ctx.normalizedPath, isPreview ? 320 : ctx.height, {
      priority: "userBlocked",
    });
    await streamCachedFile(ctx.res, cachedPath, { contentType: "image/jpeg" });
    return true;
  } catch {
    return false;
  }
};

/** Maps a request to the on-demand HLS service and its answer to a response. */
export const tryHLSStream = async (ctx: FileHandlingContext): Promise<boolean> => {
  const { isVideo, representation, normalizedPath, subPath, res, url, database } = ctx;
  if (!isVideo || representation !== "hls") return false;

  try {
    const result = await serveHls({
      sourcePath: normalizedPath,
      subPath,
      variant: url.searchParams.get("variant"),
      segment: url.searchParams.get("segment"),
      token: url.searchParams.get("token"),
      lookupVideo: () => database.getFileRecord(subPath),
      taskOrchestrator: ctx.taskOrchestrator,
      onClientGone: (listener) => {
        if (res.destroyed) listener();
        res.once("close", listener);
        return () => res.off("close", listener);
      },
    });
    switch (result.kind) {
      case "playlist":
        writeHlsPlaylist(res, result.content, result.durationSeconds);
        break;
      case "segment":
        res.setHeader(SEGMENT_WAIT_HEADER, String(result.waitMs));
        if (result.encodeSpeed !== null) {
          res.setHeader(ENCODE_SPEED_HEADER, String(result.encodeSpeed));
        }
        await streamHlsSegment(res, result.path);
        break;
      case "unavailable":
        writeJson(res, result.status, {
          error: result.error,
          ...(result.message ? { message: result.message } : {}),
        });
        break;
    }
  } catch (error) {
    writeJson(res, 500, { error: "HLS generation failed", message: messageOf(error) });
  }
  return true;
};

/** A face crop of a face found in a video: one frame, cropped. */
export const tryVideoFrameCrop = async (ctx: FileHandlingContext) => {
  const { crop, isVideo, frameTimeMs, normalizedPath, height, res } = ctx;
  if (!crop || !isVideo || frameTimeMs === null) return false;
  try {
    const cachedPath = await generateVideoFrameCrop(normalizedPath, frameTimeMs, crop, height);
    await streamCachedFile(res, cachedPath, { contentType: "image/jpeg" });
  } catch (error) {
    // Includes a `t` past the end, where ffmpeg succeeds but writes nothing.
    writeJson(res, 422, { error: "Could not crop video frame", message: messageOf(error) });
  }
  return true;
};

/** The embedded video of a motion photo: the tail slice of the file. */
export const serveLivePhoto = async (ctx: FileHandlingContext, fileSize: number) => {
  const { req, res, database, subPath, normalizedPath } = ctx;
  const videoLength = (await database.getFileRecord(subPath))?.embeddedVideoLength;
  if (!videoLength) {
    return writeJson(res, 404, { error: "No embedded motion photo video" });
  }
  const videoStart = fileSize - videoLength;
  if (videoStart < 0) {
    return writeJson(res, 500, { error: "Embedded video length exceeds file size" });
  }
  streamEmbeddedVideo(req, res, normalizedPath, { offset: videoStart, size: videoLength });
};

// Feedback #76: a handful of cached low-res frames for the hover/scrub
// preview strip — see generateVideoScrubFrame's doc comment for why this
// is a scoped-down "cycle through N stills" rather than true per-frame
// scrubbing. `index` selects which of VIDEO_SCRUB_FRAME_COUNT frames.
export const serveScrubFrame = async (ctx: FileHandlingContext) => {
  const { res, url, database, subPath, normalizedPath } = ctx;
  if (!ctx.isVideo) return unsupported(res, "Scrub frames are only available for video files");
  const indexParam = url.searchParams.get("index");
  const index = indexParam ? Number.parseInt(indexParam, 10) : NaN;
  if (!Number.isInteger(index) || index < 0 || index >= VIDEO_SCRUB_FRAME_COUNT) {
    return writeJson(res, 400, {
      error: `index must be an integer in [0, ${VIDEO_SCRUB_FRAME_COUNT})`,
    });
  }
  const duration = (await database.getFileRecord(subPath))?.duration;
  if (!duration) {
    return writeJson(res, 404, { error: "Video duration unknown" });
  }
  try {
    const cachedPath = await generateVideoScrubFrame(normalizedPath, index, duration, {
      priority: "userBlocked",
    });
    if (!cachedPath) {
      return writeJson(res, 404, { error: "Could not generate scrub frame" });
    }
    await streamCachedFile(res, cachedPath, { contentType: "image/jpeg" });
  } catch (error) {
    return writeJson(res, 500, {
      error: "Failed to generate scrub frame",
      message: messageOf(error),
    });
  }
};

// Feedback #168: the storyboard sprite the viewer shows while a video is
// being dragged through. Built on first request and cached; the layout is
// shared with the client (shared/video-storyboard).
export const serveStoryboard = async (ctx: FileHandlingContext) => {
  const { res, database, subPath, normalizedPath } = ctx;
  if (!ctx.isVideo) return unsupported(res, "Storyboards are only available for video files");
  const duration = (await database.getFileRecord(subPath))?.duration;
  if (!duration) {
    return writeJson(res, 404, { error: "Video duration unknown" });
  }
  const built = await attempt(generateVideoStoryboard(normalizedPath, duration));
  if (!built.ok) {
    storyboardLog.warn({ err: built.error, path: subPath }, "Storyboard generation failed");
    return writeJson(res, 500, {
      error: "Failed to generate storyboard",
      message: built.error.message,
    });
  }
  if (!built.value) {
    return writeJson(res, 404, { error: "Could not generate storyboard" });
  }
  await streamCachedFile(res, built.value, { contentType: "image/jpeg" });
};

// A whole H.264/AAC MP4 for the share dialog's "web-safe" and "smaller"
// video options — something a share sheet or another phone can take, unlike
// HLS segments or a 4K HEVC original. Encoded once and cached.
export const serveShareMp4 = async (ctx: FileHandlingContext) => {
  const { req, res, url, normalizedPath } = ctx;
  if (!ctx.isVideo) return unsupported(res, "shareMp4 is only available for video files");
  try {
    const sharePath = await exportShareVideo(
      normalizedPath,
      parseShareVideoShortSide(url.searchParams.get("size")),
    );
    const shareStats = await stat(sharePath);
    streamFile(req, res, sharePath, {
      contentType: "video/mp4",
      size: shareStats.size,
      cacheControl: "private, max-age=86400",
      acceptRanges: true,
    });
  } catch (error) {
    return writeJson(res, 500, {
      error: "Failed to prepare video for sharing",
      message: messageOf(error),
    });
  }
};
