import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import {
  probeVideoPlaybackProfile,
  invalidateVideoPlaybackProfile,
} from "../../videoPlaybackProfile";
import { attachHlsAbrUpswitchGuard } from "../../hlsAbrGuard";
import { negotiateVideoPlayback } from "../../api";
import { getToken } from "../../auth";
import { createClientOperationId, logClientEvent } from "../../diagnostics";
import { type PlaybackState } from "../VideoLoadingOverlay";
import { readStorage, writeStorage } from "../../storage";
import { playVideo } from "../playVideo";
import { attemptSync } from "../../result";
import type { RefObject } from "react";
import type { PhotoItem } from "../../api";

type DefaultLoader = InstanceType<typeof Hls.DefaultConfig.loader>;
type DefaultLoadArgs = Parameters<DefaultLoader["load"]>;

type HlsNetworkDetails = {
  xhr?: XMLHttpRequest;
};

type HlsMediaWithSource = HTMLMediaElement & {
  mediaSource?: MediaSource & { updating?: boolean };
};

// pause() and load() don't throw: removing src and reloading is what cancels
// the in-flight range request.
const clearVideoSource = (video: HTMLVideoElement) => {
  video.pause();
  video.removeAttribute("src");
  video.load();
};

export type VideoStatus = "hls" | "direct" | null;

// How long a direct stream may stay stalled before we give up on it and switch to
// adaptive HLS. Long enough to ride out a brief buffering blip, short enough that a
// genuinely under-provisioned link recovers quickly.
const DIRECT_STALL_FALLBACK_MS = 3000;

// The video quality the user last picked, as a height ("auto" or absent means
// ABR). Stored by height, not level index, because each video has its own
// ladder of variants.
const VIDEO_QUALITY_KEY = "photrix.videoQuality";

const readPreferredVideoHeight = (): number | null => {
  const height = Number(readStorage(VIDEO_QUALITY_KEY));
  return Number.isFinite(height) && height > 0 ? height : null;
};

const writePreferredVideoHeight = (height: number | null): void =>
  writeStorage(VIDEO_QUALITY_KEY, height ? String(height) : "auto");

// The tallest variant at or below the preferred height, else the shortest one,
// so a 1080p preference still applies to a video whose top rung is 720p.
const pickLevelForHeight = (levels: { height: number }[], preferred: number): number => {
  let best = -1;
  levels.forEach((level, index) => {
    if (level.height <= preferred && (best < 0 || level.height > levels[best].height)) {
      best = index;
    }
  });
  if (best >= 0) return best;
  return levels.reduce((low, level, index) => (level.height < levels[low].height ? index : low), 0);
};

type VideoPlaybackOptions = {
  photo: PhotoItem | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Shared with the viewer, which starts a new operation per selected video. */
  playbackOperationIdRef: RefObject<string | null>;
};

/**
 * Plays the viewer's video: negotiates direct playback or adaptive HLS, falls
 * back from a stalled direct stream to HLS (resuming where it stalled), keeps
 * the quality picker in step with the player, and reports playback progress
 * to diagnostics.
 */
export const useVideoPlayback = ({
  photo,
  videoRef,
  playbackOperationIdRef,
}: VideoPlaybackOptions) => {
  const hlsRef = useRef<Hls | null>(null);
  const abrGuardDetachRef = useRef<(() => void) | null>(null);
  // Set to a video's path once direct playback stalled on buffering, so the load
  // effect re-negotiates that video as adaptive HLS. Reset implicitly when the
  // path changes (see the derived forceTranscode below).
  const [forcedTranscodePath, setForcedTranscodePath] = useState<string | null>(null);
  // Playback position to restore after a direct→HLS switch, so the fallback resumes
  // where buffering stalled instead of jumping to the start.
  const resumeTimeRef = useRef<number | null>(null);
  // Derived so navigating to a different video clears the flag in the same render
  // (no extra effect run / flicker) — a fresh video starts by trying direct again.
  const forceTranscode = forcedTranscodePath !== null && forcedTranscodePath === photo?.path;
  const [videoStatus, setVideoStatus] = useState<VideoStatus>(null);
  // What the player is waiting on, shown by VideoLoadingOverlay.
  const [playback, setPlayback] = useState<PlaybackState>({ phase: "idle", since: 0 });
  // When bytes last arrived; a ref because progress fires several times a second.
  const lastDataAtRef = useRef(0);
  const [retryNonce, setRetryNonce] = useState(0);
  // Per-attempt numbers for the `video.playback.summary` diagnostics event.
  const playbackStatsRef = useRef<{
    startedAt: number;
    mode: string | null;
    reason: string | null;
    firstFrameAt: number | null;
    stalls: number;
    stalledMs: number;
    stallStartedAt: number | null;
    levelSwitches: number;
  } | null>(null);
  // ABR quality selector. `hlsLevels` are the variants the player can switch between
  // (ascending height); `manualLevel` is -1 for Auto/ABR or a level index to lock to;
  // `activeLevelHeight` is the height ABR is currently playing (for the "Auto" label).
  const [hlsLevels, setHlsLevels] = useState<{ index: number; height: number }[]>([]);
  const [manualLevel, setManualLevel] = useState<number>(-1);
  const [activeLevelHeight, setActiveLevelHeight] = useState<number | null>(null);
  const [videoAspectRatio, setVideoAspectRatio] = useState<number | null>(null);

  // HLS setup effect
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !photo || photo.mediaType !== "video") return;

    let cancelled = false;
    const clientOperationId = playbackOperationIdRef.current ?? createClientOperationId();
    playbackOperationIdRef.current = clientOperationId;

    const destroyHls = () => {
      if (abrGuardDetachRef.current) {
        abrGuardDetachRef.current();
        abrGuardDetachRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };

    const markPlaybackUnavailable = (reason: string) => {
      destroyHls();
      clearVideoSource(video);
      if (cancelled) {
        return;
      }
      setPlayback({ phase: "unavailable", since: Date.now(), detail: reason });
      setVideoStatus(null);
      setHlsLevels([]);
      setManualLevel(-1);
      setActiveLevelHeight(null);
    };

    // Clean up previous HLS instance
    destroyHls();
    clearVideoSource(video);
    setVideoStatus(null);
    setVideoAspectRatio(null);
    setHlsLevels([]);
    setManualLevel(-1);
    setActiveLevelHeight(null);
    setPlayback({ phase: "measuring", since: Date.now() });
    lastDataAtRef.current = 0;
    const stats = {
      startedAt: Date.now(),
      mode: null as string | null,
      reason: null as string | null,
      firstFrameAt: null as number | null,
      stalls: 0,
      stalledMs: 0,
      stallStartedAt: null as number | null,
      levelSwitches: 0,
    };
    playbackStatsRef.current = stats;

    const loadSelectedPlayback = async () => {
      try {
        logClientEvent({
          level: "info",
          event: "video.negotiation.started",
          message: `Negotiating playback for ${photo.path}`,
          clientOperationId,
          data: { path: photo.path },
          immediate: true,
        });
        const playbackProfile = await probeVideoPlaybackProfile();
        if (cancelled) return;
        setPlayback({ phase: "negotiating", since: Date.now() });

        const negotiation = await negotiateVideoPlayback({
          path: photo.path,
          bandwidthMbps: playbackProfile.bandwidthMbps,
          hevcSupported: playbackProfile.hevcSupported,
          forceTranscode,
          clientOperationId,
        });
        if (cancelled) return;
        stats.mode = negotiation.mode;
        stats.reason = negotiation.reason;

        // Restore playback position after a direct→HLS fallback (the ref is only
        // set on that path). Registered before the source is attached so it catches
        // the fresh element's metadata load.
        const restorePlaybackPosition = () => {
          const resumeAt = resumeTimeRef.current;
          resumeTimeRef.current = null;
          if (resumeAt === null || !Number.isFinite(resumeAt) || resumeAt <= 0) return;
          video.addEventListener(
            "loadedmetadata",
            () => {
              // Metadata has loaded, so the element accepts a seek.
              if (!cancelled) video.currentTime = resumeAt;
            },
            { once: true },
          );
        };

        logClientEvent({
          level: negotiation.mode === "error" ? "warn" : "info",
          event: "video.negotiation.completed",
          message: `Playback negotiation returned ${negotiation.mode}`,
          clientOperationId,
          data: {
            path: photo.path,
            negotiation,
            playbackProfile,
          },
          immediate: negotiation.mode === "error",
        });

        if (negotiation.mode === "error") {
          // No transcode is available (e.g. no GPU) and the link can't carry the
          // raw file. We deliberately do NOT fall back to the raw original — it
          // would only buffer endlessly — so fail visibly instead.
          markPlaybackUnavailable(negotiation.reason);
          return;
        }

        if (negotiation.mode === "direct") {
          // The server measured the connection as fast enough for the untranscoded
          // file (and the browser supports its codec), so play it directly — no GPU.
          if (!cancelled) {
            setVideoStatus("direct");
            setPlayback({ phase: "starting", since: Date.now(), detail: "Loading original…" });
          }
          restorePlaybackPosition();
          // negotiation.url is server-built and token-less; use photo.originalUrl
          // (client-built, token-bearing) for the same file.
          video.src = photo.originalUrl;
          playVideo(video);
          return;
        }

        // mode === "hls"
        const hlsUrl = negotiation.url;

        const nativeHlsSupport = video.canPlayType("application/vnd.apple.mpegurl");
        const hlsJsSupported = Hls.isSupported();

        // Get the known duration from metadata (for progressive HLS)
        const rawDuration = photo.metadata?.duration;
        const knownDuration =
          typeof rawDuration === "number" && Number.isFinite(rawDuration)
            ? rawDuration
            : undefined;

        // Custom loader to capture duration header
        let serverDuration: number | undefined;

        class DurationCapturingLoader extends Hls.DefaultConfig.loader {
          load(...args: DefaultLoadArgs) {
            const [context, config, callbacks] = args;
            const originalOnSuccess = callbacks.onSuccess;
            callbacks.onSuccess = (...onSuccessArgs) => {
              const [, , callbackContext, networkDetails] = onSuccessArgs;
              const details =
                typeof networkDetails === "object" && networkDetails !== null
                  ? (networkDetails as HlsNetworkDetails)
                  : undefined;
              const requestType =
                typeof callbackContext === "object" && callbackContext !== null
                  ? (callbackContext as { type?: string }).type
                  : undefined;

              if (
                (requestType === "manifest" || requestType === "level") &&
                details?.xhr
              ) {
                const durationHeader =
                  details.xhr.getResponseHeader("X-Content-Duration");
                if (durationHeader) {
                  const parsed = parseFloat(durationHeader);
                  if (Number.isFinite(parsed) && parsed > 0) {
                    serverDuration = parsed;
                  }
                }
              }
              originalOnSuccess(...onSuccessArgs);
            };
            super.load(context, config, callbacks);
          }
        }

        if (hlsJsSupported) {
          const authToken = getToken();
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            loader: DurationCapturingLoader,
            // Inject auth token into every XHR hls.js makes (manifest, playlists, segments)
            ...(authToken
              ? {
                  xhrSetup: (xhr: XMLHttpRequest) => {
                    xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);
                  },
                }
              : {}),
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferSize: 60 * 1000 * 1000,
            maxBufferHole: 0.5,
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: Infinity,
            levelLoadingTimeOut: 20000,
            manifestLoadingTimeOut: 20000,
            levelLoadingRetryDelay: 1000,
            // Seed hls.js's own EWMA bandwidth estimator from the measurement we
            // already took for the direct-vs-HLS negotiation (playbackProfile),
            // instead of hls.js's hardcoded 500kbps default — reuses the existing
            // probe rather than starting ABR blind on a link we've already sampled.
            // With that measurement, also start at the rung it supports instead of
            // test-loading the lowest one first: every rung is a separate on-demand
            // GPU encode on the server, so climbing 360p→720p→1080p on open costs
            // two extra encodes and two visible quality jumps. Without one, hls.js
            // falls back to test-loading the lowest rung.
            ...(playbackProfile.bandwidthMbps
              ? {
                  abrEwmaDefaultEstimate: playbackProfile.bandwidthMbps * 1_000_000,
                  testBandwidth: false,
                }
              : {}),
          });

          restorePlaybackPosition();
          hls.loadSource(hlsUrl);
          hls.attachMedia(video);
          if (!cancelled) {
            setVideoStatus("hls");
            setPlayback({ phase: "starting", since: Date.now(), detail: "Starting stream…" });
          }
          hls.on(Hls.Events.FRAG_LOADED, () => {
            lastDataAtRef.current = Date.now();
          });

          const getDuration = () => serverDuration ?? knownDuration ?? video.duration;

          // Apply known duration to the MediaSource so the scrubber shows total length
          // even while the event playlist is still growing (no #EXT-X-ENDLIST yet).
          // Called after buffer appends (when updating is guaranteed false) and after
          // each variant playlist load — both are more reliable than a polling interval.
          // Unsubscribes once duration is successfully set to avoid redundant invocations.
          const applyKnownDuration = () => {
            const dur = getDuration();
            if (!(dur && Number.isFinite(dur) && dur > 0)) return;
            const media = hls.media as HlsMediaWithSource | null;
            const mediaSource = media?.mediaSource;
            // A duration change is refused while a SourceBuffer is mid-append.
            if (
              !mediaSource ||
              mediaSource.readyState !== "open" ||
              [...mediaSource.sourceBuffers].some((buffer) => buffer.updating)
            )
              return;
            if (media.duration === dur) return;
            // It can also be refused when media past `dur` is already buffered;
            // that resolves itself, so keep listening and try again later.
            const applied = attemptSync(() => {
              mediaSource.duration = dur;
            });
            if (!applied.ok) return;
            hls.off(Hls.Events.MANIFEST_PARSED, manifestParsedHandler);
            hls.off(Hls.Events.LEVEL_LOADED, applyKnownDuration);
            hls.off(Hls.Events.BUFFER_APPENDED, applyKnownDuration);
          };

          const manifestParsedHandler = () => {
            // Expose the available variants to the quality selector (ascending height).
            if (!cancelled) {
              setHlsLevels(
                hls.levels.map((level, index) => ({ index, height: level.height })),
              );
              // Feedback #149: start at the quality the user last chose. Nothing
              // is buffered yet, so locking the level here costs no flush.
              const preferredHeight = readPreferredVideoHeight();
              if (preferredHeight && hls.levels.length > 1) {
                const level = pickLevelForHeight(hls.levels, preferredHeight);
                hls.currentLevel = level;
                setManualLevel(level);
              }
            }
            logClientEvent({
              level: "info",
              event: "video.hls.manifest.parsed",
              message: `Parsed HLS manifest for ${photo.path}`,
              clientOperationId,
              data: { path: photo.path, levels: hls.levels.length },
            });
            playVideo(video);
            applyKnownDuration();
          };

          hls.on(Hls.Events.MANIFEST_PARSED, manifestParsedHandler);
          hls.on(Hls.Events.LEVEL_LOADED, applyKnownDuration);
          hls.on(Hls.Events.BUFFER_APPENDED, applyKnownDuration);

          // Reflect the level ABR has settled on so the "Auto" option can show it.
          hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
            stats.levelSwitches += 1;
            if (!cancelled) setActiveLevelHeight(hls.levels[data.level]?.height ?? null);
          });

          // Recover from transient failures in place rather than immediately dropping
          // to the raw source — the raw file is the original multi-tens-of-Mbps stream
          // and would buffer far worse over a constrained link. Only fall back to it
          // when HLS is genuinely unrecoverable.
          let mediaRecoveries = 0;
          let networkRecoveries = 0;
          hls.on(Hls.Events.ERROR, (_event, data) => {
            logClientEvent({
              level: data.fatal ? "error" : "warn",
              event: "video.hls.error",
              message: `HLS ${data.fatal ? "fatal" : "non-fatal"} error`,
              clientOperationId,
              data: {
                path: photo.path,
                type: data.type,
                details: data.details,
                fatal: data.fatal,
              },
              immediate: data.fatal,
            });
            if (!data.fatal) return;
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 2) {
              networkRecoveries += 1;
              hls.startLoad();
              return;
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
              mediaRecoveries += 1;
              hls.recoverMediaError();
              return;
            }
            // No raw fallback: an unrecoverable HLS error fails visibly rather
            // than dropping to the full-size original.
            markPlaybackUnavailable(`The stream failed (${data.details}).`);
          });
          hlsRef.current = hls;
          // Asymmetric ABR: downswitches stay on hls.js's own fast, untouched
          // path; upswitches are gated behind a dwell period + sustained
          // bandwidth headroom so a bad link settles instead of hunting (see
          // hlsAbrGuard.ts for the GPU-cost rationale).
          abrGuardDetachRef.current = attachHlsAbrUpswitchGuard(hls);
          return;
        }

        if (nativeHlsSupport) {
          if (!cancelled) {
            setVideoStatus("hls");
            setPlayback({ phase: "starting", since: Date.now(), detail: "Starting stream…" });
          }
          restorePlaybackPosition();
          // For native HLS (Safari), Authorization headers can't be set, so
          // embed the token as a query param. The server propagates it through
          // all rewritten variant/segment URLs.
          const nativeToken = getToken();
          video.src = nativeToken
            ? `${hlsUrl}&token=${encodeURIComponent(nativeToken)}`
            : hlsUrl;
          playVideo(video);
          return;
        }

        // Browser can play neither hls.js nor native HLS: no raw fallback.
        markPlaybackUnavailable("This browser can't play adaptive (HLS) streams.");
      } catch (error) {
        logClientEvent({
          level: "error",
          event: "video.negotiation.failed",
          message: `Playback setup failed for ${photo.path}`,
          clientOperationId,
          data: {
            path: photo.path,
            error: error instanceof Error ? error.message : String(error),
          },
          immediate: true,
        });
        markPlaybackUnavailable(
          `Couldn't start playback: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    void loadSelectedPlayback();

    return () => {
      cancelled = true;
      // One event per attempt that answers "was it slow, and why": startup
      // time (or how long the user waited before giving up), stalls, ABR
      // switches and frames the browser dropped.
      const now = Date.now();
      const quality = video.getVideoPlaybackQuality?.();
      logClientEvent({
        level: stats.stalls > 0 || !stats.firstFrameAt ? "warn" : "info",
        event: "video.playback.summary",
        message: `Playback summary for ${photo.path}`,
        clientOperationId,
        data: {
          path: photo.path,
          mode: stats.mode,
          reason: stats.reason,
          bytesPerSecondOfVideo:
            photo.metadata?.sizeInBytes && photo.metadata.duration
              ? Math.round(photo.metadata.sizeInBytes / photo.metadata.duration)
              : null,
          timeToFirstFrameMs: stats.firstFrameAt ? stats.firstFrameAt - stats.startedAt : null,
          gaveUpWaitingAfterMs: stats.firstFrameAt ? null : now - stats.startedAt,
          stalls: stats.stalls,
          stalledMs: stats.stalledMs + (stats.stallStartedAt ? now - stats.stallStartedAt : 0),
          levelSwitches: stats.levelSwitches,
          watchedS: Math.round(video.currentTime),
          droppedFrames: quality?.droppedVideoFrames ?? null,
          totalFrames: quality?.totalVideoFrames ?? null,
        },
      });
      destroyHls();
      clearVideoSource(video);
    };
    // forceTranscode re-runs this to switch a stalled direct stream over to HLS;
    // retryNonce re-runs it from the overlay's Retry button.
  }, [photo, forceTranscode, retryNonce, videoRef, playbackOperationIdRef]);

  useEffect(() => {
    const video = videoRef.current;
    const photoPath = photo?.path;
    const clientOperationId = playbackOperationIdRef.current;
    if (!video || !photoPath || photo?.mediaType !== "video" || !clientOperationId) return;

    const logVideoEvent = (event: string, level: "info" | "warn" | "error") => {
      logClientEvent({
        level,
        event,
        message: `${event} for ${photoPath}`,
        clientOperationId,
        data: {
          path: photoPath,
          currentTime: video.currentTime,
          readyState: video.readyState,
          networkState: video.networkState,
        },
        immediate: level !== "info",
      });
    };

    // Direct playback is a single fixed-bitrate file with no adaptation, so a link
    // that can't sustain it just buffers forever. If a direct stream stalls and
    // doesn't recover within the grace window, abandon it and re-negotiate as HLS
    // (which does real ABR). Only armed in direct mode — HLS adapts on its own.
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStallTimer = () => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    const armDirectStallFallback = () => {
      if (videoStatus !== "direct" || stallTimer !== null) return;
      stallTimer = setTimeout(() => {
        stallTimer = null;
        resumeTimeRef.current = video.currentTime;
        // A fresh probe next time — the earlier estimate was too optimistic for
        // this link (it may predate a network change or throttle).
        invalidateVideoPlaybackProfile();
        logClientEvent({
          level: "warn",
          event: "video.direct.fallback",
          message: `Direct playback stalled; switching to HLS for ${photoPath}`,
          clientOperationId,
          data: { path: photoPath, currentTime: video.currentTime },
          immediate: true,
        });
        setForcedTranscodePath(photoPath);
      }, DIRECT_STALL_FALLBACK_MS);
    };

    const stats = playbackStatsRef.current;
    const onPlaying = () => {
      clearStallTimer();
      logVideoEvent("video.element.playing", "info");
      const now = Date.now();
      if (stats) {
        stats.firstFrameAt ??= now;
        if (stats.stallStartedAt) stats.stalledMs += now - stats.stallStartedAt;
        stats.stallStartedAt = null;
      }
      setPlayback({ phase: "playing", since: now });
    };
    const onCanPlay = () => {
      logVideoEvent("video.element.canplay", "info");
      // Ready but not playing (autoplay blocked): nothing left to wait for.
      setPlayback((current) =>
        current.phase === "starting" ? { phase: "playing", since: Date.now() } : current,
      );
    };
    const onWaiting = () => {
      logVideoEvent("video.element.waiting", "warn");
      armDirectStallFallback();
      if (!stats?.firstFrameAt) return;
      stats.stalls += 1;
      stats.stallStartedAt ??= Date.now();
      setPlayback((current) =>
        current.phase === "playing" ? { phase: "buffering", since: Date.now() } : current,
      );
    };
    const onProgress = () => {
      lastDataAtRef.current = Date.now();
    };
    const onStalled = () => {
      logVideoEvent("video.element.stalled", "warn");
      armDirectStallFallback();
    };
    const onError = () => {
      logVideoEvent("video.element.error", "error");
      if (hlsRef.current || !(video.currentSrc || video.getAttribute("src"))) {
        return;
      }

      const mediaErrorCode = video.error?.code;
      clearVideoSource(video);
      setPlayback({
        phase: "unavailable",
        since: Date.now(),
        detail: `The browser couldn't play this file${mediaErrorCode ? ` (media error ${mediaErrorCode})` : ""}.`,
      });
      setVideoStatus(null);
      setHlsLevels([]);
      setManualLevel(-1);
      setActiveLevelHeight(null);
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onStalled);
    video.addEventListener("error", onError);
    video.addEventListener("progress", onProgress);

    return () => {
      clearStallTimer();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onStalled);
      video.removeEventListener("error", onError);
      video.removeEventListener("progress", onProgress);
    };
  }, [photo?.path, photo?.mediaType, videoStatus, videoRef, playbackOperationIdRef]);

  /** -1 for Auto (ABR), or a level index to lock playback to. */
  const chooseLevel = (level: number) => {
    setManualLevel(level);
    writePreferredVideoHeight(hlsLevels.find((l) => l.index === level)?.height ?? null);
    // `nextLevel`, not `currentLevel`: currentLevel flushes the whole buffer and
    // stalls until the new variant arrives (feedback #149); nextLevel keeps
    // playing what's buffered and switches at the next fragment.
    if (hlsRef.current) hlsRef.current.nextLevel = level;
  };

  return {
    videoStatus,
    /** What the player is waiting on, for VideoLoadingOverlay. */
    playback,
    lastDataAtRef,
    /** Starts playback negotiation over, from the overlay's Retry button. */
    retry: () => setRetryNonce((n) => n + 1),
    hlsLevels,
    manualLevel,
    activeLevelHeight,
    chooseLevel,
    videoAspectRatio,
    setVideoAspectRatio,
  };
};
