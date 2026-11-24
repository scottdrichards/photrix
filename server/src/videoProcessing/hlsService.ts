import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { attempt, attemptSync } from "../common/result.ts";
import { getLogger } from "../observability/logger.ts";
import { recordServerDiagnosticEvent } from "../observability/diagnosticsStore.ts";
import { buildVodVariantPlaylist } from "./buildHlsPlaylist.ts";
import {
  clampToSupportedHeight,
  getMultibitrateHLSInfo,
  getVariantPlaylistPath,
  getVariantSegmentPath,
  prepareMultibitrateHLSStructure,
} from "./generateMultibitrateHLS.ts";
import { getCachedVideoDuration, getCachedVideoSourceProfile } from "./getVideoMetadata.ts";
import { getGpuAcceleration } from "./gpuAcceleration.ts";
import { ensureVariantEncoding, type EncodeTarget } from "./hlsEncodeQueue.ts";
import {
  rewriteMasterPlaylist,
  rewriteVariantPlaylist,
  segmentUrlBase,
  variantUrlBase,
} from "./hlsPlaylistRewrite.ts";
import { parseSegmentIndex, segmentFileName } from "./hlsSegmentNames.ts";
import { waitForHlsFile } from "./hlsSegmentWatcher.ts";
import { keepVariantAlive, recentEncodeSpeed, touchHlsSession, touchVariant } from "./hlsSession.ts";

const hlsLog = getLogger("HLS");

/** What the index knows about the video; anything missing is probed or assumed. */
type IndexedVideo = {
  duration?: number | null;
  dimensionWidth?: number | null;
  dimensionHeight?: number | null;
};

export type HlsRequest = {
  /** Absolute path of the source video. */
  sourcePath: string;
  /** Library-relative path: names the file in rewritten URLs and diagnostics. */
  subPath: string;
  /** `variant`: a rung height such as "720". Absent for the master playlist. */
  variant: string | null;
  /** `segment`: `segment_NNN.ts`. With `variant`, asks for that segment. */
  segment: string | null;
  /** Auth token to carry into rewritten URLs, for players that can't send headers. */
  token: string | null;
  lookupVideo: () => Promise<IndexedVideo | null | undefined>;
  taskOrchestrator: EncodeTarget["taskOrchestrator"];
  /**
   * Calls `listener` when the client hangs up (at once if it already has) and
   * returns an unsubscribe. A segment wait gives up on it.
   */
  onClientGone: (listener: () => void) => () => void;
};

/** What to answer. Every playlist is ephemeral and must not be cached. */
export type HlsResponse =
  | { kind: "playlist"; content: string; durationSeconds: number | null }
  | {
      kind: "segment";
      path: string;
      /** How long the request waited for the encoder to write the segment. */
      waitMs: number;
      /** The encoder's recent pace in x realtime, when this request waited on it. */
      encodeSpeed: number | null;
    }
  | { kind: "unavailable"; status: 404 | 422; error: string; message?: string };

const SEGMENT_WAIT_MS = 60_000;
const SEGMENT_RECHECK_MS = 4_000;

/**
 * Long-polls for a segment the encoder hasn't written yet. Gives up when the
 * player hangs up: hls.js abandons a request on every seek and timeout, and a
 * stale request must neither keep the encode it no longer needs alive nor,
 * through `recheck`, restart it back at a position the player has left.
 */
const waitForSegment = async (opts: {
  hlsDir: string;
  segmentPath: string;
  onClientGone: HlsRequest["onClientGone"];
  endWait: () => void;
  recheck?: () => void;
}): Promise<boolean> => {
  const { hlsDir, segmentPath, onClientGone, endWait, recheck } = opts;
  let clientGone = false;
  const unsubscribe = onClientGone(() => {
    clientGone = true;
  });
  try {
    const deadline = Date.now() + SEGMENT_WAIT_MS;
    while (!clientGone) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      if (await waitForHlsFile(hlsDir, segmentPath, Math.min(SEGMENT_RECHECK_MS, remaining))) {
        return true;
      }
      if (!existsSync(hlsDir) || clientGone) return false;
      recheck?.();
    }
    return false;
  } finally {
    unsubscribe();
    endWait();
  }
};

const isKnownDuration = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

type Session = {
  request: HlsRequest;
  hlsDir: string;
  masterPlaylistPath: string;
  sourceSize: { width?: number | null; height?: number | null };
  durationSeconds: number | null;
};

const encodeTarget = (session: Session, variantHeight: number): EncodeTarget => ({
  sourcePath: session.request.sourcePath,
  subPath: session.request.subPath,
  hlsDir: session.hlsDir,
  variantHeight,
  taskOrchestrator: session.request.taskOrchestrator,
});

const serveSegment = async (
  session: Session,
  variant: string,
  segment: string,
): Promise<HlsResponse> => {
  const { request, hlsDir } = session;
  const { subPath, taskOrchestrator } = request;
  const variantHeight = clampToSupportedHeight(parseInt(variant, 10), session.sourceSize);
  const target = encodeTarget(session, variantHeight);
  const segmentPath = getVariantSegmentPath(hlsDir, variantHeight, segment);
  const segmentIndex = parseSegmentIndex(segment);
  touchVariant(hlsDir, variantHeight, segmentIndex ?? undefined);

  // If the segment isn't on disk yet, make sure an encode is running.
  const waitStartedAt = Date.now();
  const alreadyWritten = existsSync(segmentPath);
  if (!alreadyWritten && segmentIndex !== null) {
    ensureVariantEncoding(target, segmentIndex);
  }

  const diagnostics = { path: subPath, hlsDir, variantHeight, segment, segmentIndex };
  recordServerDiagnosticEvent({
    level: "info",
    event: "video.hls.segment.requested",
    message: `Requested HLS segment ${segment}`,
    data: { ...diagnostics, queueSnapshot: taskOrchestrator.getDiagnosticsSnapshot() },
  });

  const available = await waitForSegment({
    hlsDir,
    segmentPath,
    onClientGone: request.onClientGone,
    endWait: keepVariantAlive(hlsDir, variantHeight, segmentIndex ?? undefined),
    // Re-check coverage while waiting: the encode this request was counting
    // on can end (it reached the file's end, failed, or was dropped to make room
    // for other viewers' encodes), and only a new request would otherwise notice.
    recheck:
      segmentIndex === null ? undefined : () => ensureVariantEncoding(target, segmentIndex),
  });
  if (!available) {
    recordServerDiagnosticEvent({
      level: "error",
      event: "video.hls.segment.timeout",
      message: `Timed out waiting for HLS segment ${segment}`,
      data: { ...diagnostics, queueSnapshot: taskOrchestrator.getDiagnosticsSnapshot() },
    });
    return { kind: "unavailable", status: 404, error: "HLS segment not found or timed out" };
  }
  const waitMs = Date.now() - waitStartedAt;
  // Only a request that waited reads the encoder's pace: the encode was then
  // at its head, so the window is live encoding, not frozen pacing.
  const encodeSpeed =
    alreadyWritten || segmentIndex === null
      ? null
      : recentEncodeSpeed(hlsDir, variantHeight, segmentIndex, (index) => {
          const written = attemptSync(() =>
            statSync(getVariantSegmentPath(hlsDir, variantHeight, segmentFileName(index))),
          );
          return written.ok ? written.value.mtimeMs : null;
        });
  recordServerDiagnosticEvent({
    level: "info",
    event: "video.hls.segment.ready",
    message: `Served HLS segment ${segment}`,
    data: { path: subPath, hlsDir, variantHeight, segment, waitMs, encodeSpeed },
  });
  return { kind: "segment", path: segmentPath, waitMs, encodeSpeed };
};

const serveVariantPlaylist = async (session: Session, variant: string): Promise<HlsResponse> => {
  const { request, hlsDir, durationSeconds } = session;
  const { subPath } = request;
  const variantHeight = clampToSupportedHeight(parseInt(variant, 10), session.sourceSize);
  touchVariant(hlsDir, variantHeight);
  const baseUrl = segmentUrlBase(subPath, variant, request.token);

  // When the total duration is known, synthesize a complete VOD playlist that
  // lists every segment up front and ends with #EXT-X-ENDLIST. This gives the
  // player the true total length immediately, instead of FFmpeg's growing EVENT
  // playlist whose duration creeps up as segments are appended. The encode runs
  // from segment 0; the segment handler waits for each segment to be produced.
  if (durationSeconds !== null && durationSeconds > 0) {
    recordServerDiagnosticEvent({
      level: "info",
      event: "video.hls.variant.playlist",
      message: `Served synthetic VOD playlist for ${variantHeight}p`,
      data: { path: subPath, hlsDir, variantHeight, knownDuration: durationSeconds },
    });
    const content = buildVodVariantPlaylist({ durationSeconds, segmentBaseUrl: baseUrl });
    return { kind: "playlist", content, durationSeconds };
  }

  // Duration unknown — fall back to FFmpeg's own growing EVENT playlist.
  ensureVariantEncoding(encodeTarget(session, variantHeight));
  const variantPlaylistPath = getVariantPlaylistPath(hlsDir, variantHeight);
  if (!(await waitForHlsFile(hlsDir, variantPlaylistPath))) {
    recordServerDiagnosticEvent({
      level: "error",
      event: "video.hls.variant.playlist.timeout",
      message: `Timed out waiting for ${variantHeight}p playlist`,
      data: {
        path: subPath,
        hlsDir,
        variantHeight,
        queueSnapshot: request.taskOrchestrator.getDiagnosticsSnapshot(),
      },
    });
    return { kind: "unavailable", status: 404, error: "HLS variant playlist not found or timed out" };
  }
  const content = rewriteVariantPlaylist(await readFile(variantPlaylistPath, "utf-8"), baseUrl);
  return { kind: "playlist", content, durationSeconds };
};

const serveMasterPlaylist = async (session: Session): Promise<HlsResponse> => {
  const { request, hlsDir } = session;
  // The player's next requests are a variant playlist and then a segment,
  // which spawns the first encode; probing the source now takes the probe off
  // that critical path.
  getCachedVideoSourceProfile(request.sourcePath).catch((err: unknown) =>
    hlsLog.debug({ err }, "Source profile prewarm failed"),
  );
  recordServerDiagnosticEvent({
    level: "info",
    event: "video.hls.master.playlist",
    message: `Served HLS master playlist for ${request.subPath}`,
    data: {
      path: request.subPath,
      hlsDir,
      queueSnapshot: request.taskOrchestrator.getDiagnosticsSnapshot(),
    },
  });
  const content = rewriteMasterPlaylist(
    await readFile(session.masterPlaylistPath, "utf-8"),
    variantUrlBase(request.subPath, request.token),
  );
  return { kind: "playlist", content, durationSeconds: session.durationSeconds };
};

/**
 * On-demand HLS for one video: the master playlist, a variant playlist, or a
 * segment, encoding lazily per variant as the player asks for segments.
 * Throws only on an unexpected failure (an unreadable playlist, say).
 */
export const serveHls = async (request: HlsRequest): Promise<HlsResponse> => {
  const { sourcePath, variant, segment } = request;
  const indexed = await request.lookupVideo();
  // Decides whether the 4K rung is offered (feedback #165).
  const sourceSize = { width: indexed?.dimensionWidth, height: indexed?.dimensionHeight };

  const indexedDuration = indexed?.duration;
  let durationSeconds = isKnownDuration(indexedDuration) ? indexedDuration : null;
  if (durationSeconds === null) {
    // Without a duration the player still works; it just can't size the scrubber up front.
    // Memoized: this runs for every playlist and segment request of an unindexed file.
    const probed = await attempt(getCachedVideoDuration(sourcePath));
    if (!probed.ok) hlsLog.warn({ err: probed.error }, "ffprobe failed; streaming without a known duration");
    else if (probed.value !== null) durationSeconds = probed.value;
  }

  const info = await getMultibitrateHLSInfo(sourcePath);
  // Mark this HLS tree as actively in use so the reaper keeps it alive while the
  // player is fetching, then deletes it (and kills any running encode) once idle.
  touchHlsSession(info.hlsDir);

  // If not initialized, set up the directory structure immediately so the master
  // playlist can be returned right away. Encodes start lazily per variant when
  // segments are requested; segments are served as FFmpeg writes them.
  if (!info.initialized) {
    if (!(await getGpuAcceleration())) {
      return {
        kind: "unavailable",
        status: 422,
        error: "HLS not available",
        message: "No cached HLS and hardware acceleration is not available for on-the-fly encoding",
      };
    }
    // Writes the dirs and the multi-variant master.m3u8 before answering.
    await prepareMultibitrateHLSStructure(sourcePath, sourceSize);
  }

  const session: Session = {
    request,
    hlsDir: info.hlsDir,
    masterPlaylistPath: info.masterPlaylistPath,
    sourceSize,
    durationSeconds,
  };
  if (segment && variant) return serveSegment(session, variant, segment);
  if (variant) return serveVariantPlaylist(session, variant);
  return serveMasterPlaylist(session);
};
