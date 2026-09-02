import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ArrowDownload24Regular,
  ChevronLeft48Regular,
  ChevronRight48Regular,
  ClosedCaption24Regular,
  ClosedCaptionOff24Regular,
  Dismiss24Regular,
  ImageEdit24Regular,
  Info24Regular,
  Live24Regular,
  Print24Regular,
  ScanPerson24Regular,
  Share24Regular,
} from "@fluentui/react-icons";
import Hls from "hls.js";
import {
  probeVideoPlaybackProfile,
  invalidateVideoPlaybackProfile,
} from "../videoPlaybackProfile";
import { attachHlsAbrUpswitchGuard } from "../hlsAbrGuard";
import { consumeLiveOpenIntent } from "./tileMedia/liveOpenIntent";
import {
  fetchPeopleFacesForFile,
  fetchPhotoCaption,
  fetchTranscriptSegments,
  negotiateVideoPlayback,
  updatePhotoMetadata,
} from "../api";
import type { PhotoPersonFace } from "../api/types";
import { StarRating } from "./StarRating";
import { TagEditor } from "./TagEditor";
import { DescriptionEditor } from "./DescriptionEditor";
import { getToken } from "../auth";
import { createClientOperationId, logClientEvent } from "../diagnostics";
import { FaceOverlay, parseFaceRegions, parseFaceTableBoxes, type NamedFace } from "./FaceOverlay";
import { FaceAssignPanel } from "./FaceAssignPanel";
import { useSelectionContext } from "./selection/SelectionContext";
import { MiniMap } from "./MiniMap";
import { ShareOptionsModal } from "./ShareOptionsModal";
import { PhotoEditor, type EditStyle, type EditAdj, DEFAULT_ADJ, computeStyle, isDirty, EditSvgDefs, applyPixelAdj } from "./PhotoEditor";
import { SwipePhotoViewer } from "./SwipePhotoViewer";
import { isSharedView } from "../hooks/useShareFilter";
import { cx } from "../cx";
import { photoViewTransitionName } from "./viewTransition";
import { suppressAmbientPlayback } from "./tileMedia/tilePlaybackCoordinator";
import css from "./FullscreenViewer.module.css";

// Star ratings and tags persist to the DB via PATCH, which the server rejects
// for share tokens — so hide the tagging bar entirely in a shared view.
const READ_ONLY = isSharedView();

const SWIPE_THRESHOLD_PX = 60;
const PHOTO_ZOOM_DEFAULT_SCALE = 2.5;
const PHOTO_ZOOM_MIN_SCALE = 1;
const PHOTO_ZOOM_MAX_SCALE = 6;
const PHOTO_ZOOM_STEP = 0.25;

type DefaultLoader = InstanceType<typeof Hls.DefaultConfig.loader>;
type DefaultLoadArgs = Parameters<DefaultLoader["load"]>;

type HlsNetworkDetails = {
  xhr?: XMLHttpRequest;
};

type HlsMediaWithSource = HTMLMediaElement & {
  mediaSource?: MediaSource & { updating?: boolean };
};

const segmentsToWebVTT = (
  segments: Array<{ start: number; end: number; text: string }>,
): string => {
  const toTimestamp = (s: number): string => {
    const h = Math.floor(s / 3600)
      .toString()
      .padStart(2, "0");
    const m = Math.floor((s % 3600) / 60)
      .toString()
      .padStart(2, "0");
    const sec = Math.floor(s % 60)
      .toString()
      .padStart(2, "0");
    const ms = Math.round((s % 1) * 1000)
      .toString()
      .padStart(3, "0");
    return `${h}:${m}:${sec}.${ms}`;
  };
  const cues = segments
    .map(
      (seg, i) =>
        `${i + 1}\n${toTimestamp(seg.start)} --> ${toTimestamp(seg.end)}\n${seg.text}`,
    )
    .join("\n\n");
  return `WEBVTT\n\n${cues}`;
};

const safePlay = (video: HTMLVideoElement, _logPrefix: string) => {
  const playResult = video.play();
  if (playResult && typeof playResult.catch === "function") {
    playResult.catch((_err) => {});
  }
};

const clearVideoSource = (video: HTMLVideoElement) => {
  try {
    video.pause();
  } catch {
    // Ignore best-effort cleanup failures.
  }

  try {
    video.removeAttribute("src");
    video.load();
  } catch {
    // Ignore best-effort cleanup failures.
  }
};

const syncDialogOpenState = (dialog: HTMLDialogElement, isOpen: boolean) => {
  try {
    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
      return;
    }

    if (dialog.open) {
      dialog.close();
    }
  } catch {
    // Ignore dialog state races during hot reload or interrupted renders.
  }
};

type VideoStatus = "hls" | "direct" | "unavailable" | null;

// How long a direct stream may stay stalled before we give up on it and switch to
// adaptive HLS. Long enough to ride out a brief buffering blip, short enough that a
// genuinely under-provisioned link recovers quickly.
const DIRECT_STALL_FALLBACK_MS = 3000;

const videoStatusLabel: Record<NonNullable<VideoStatus>, string> = {
  hls: "HLS",
  direct: "Raw Video",
  unavailable: "Playback Unavailable",
};

const formatShutterSpeed = (exposureTime: unknown): string | null => {
  const t =
    typeof exposureTime === "number" ? exposureTime : parseFloat(String(exposureTime));
  if (!isFinite(t) || t <= 0) return null;
  if (t >= 1) return `${t}s`;
  const denom = Math.round(1 / t);
  return `1/${denom}s`;
};

const formatAperture = (aperture: unknown): string | null => {
  const f = typeof aperture === "number" ? aperture : parseFloat(String(aperture));
  if (!isFinite(f) || f <= 0) return null;
  return `f/${f % 1 === 0 ? f.toFixed(0) : f.toFixed(1)}`;
};

const formatFocalLength = (focalLength: unknown): string | null => {
  if (typeof focalLength !== "string" && typeof focalLength !== "number") return null;
  const str = String(focalLength).trim();
  // Handle rational notation "50/1"
  const rationalMatch = str.match(/^(\d+)\/(\d+)$/);
  if (rationalMatch) {
    const val = parseInt(rationalMatch[1]) / parseInt(rationalMatch[2]);
    return `${Math.round(val)}mm`;
  }
  const num = parseFloat(str);
  if (!isFinite(num)) return str;
  return str.includes("mm")
    ? str
    : `${num % 1 === 0 ? num.toFixed(0) : num.toFixed(1)}mm`;
};

const formatFileSize = (bytes: unknown): string | null => {
  const b = typeof bytes === "number" ? bytes : parseInt(String(bytes));
  if (!isFinite(b) || b < 0) return null;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatDuration = (seconds: unknown): string | null => {
  const s = typeof seconds === "number" ? seconds : parseFloat(String(seconds));
  if (!isFinite(s) || s < 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
};

// Size the photo frame from known metadata dimensions so the cached thumbnail
// placeholder occupies the correct box before the full image reports its size.
const readMetadataAspectRatio = (metadata: Record<string, unknown> | undefined): number => {
  const width = Number(metadata?.dimensionWidth);
  const height = Number(metadata?.dimensionHeight);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return width / height;
  }
  return 1;
};

const PREVIEW_MAX_EDGE = 1200;

// Draws the full, uncropped, unrotated image (pixel adjustments only — tone,
// color, dehaze, clarity/sharpness convolution, vignette). Rotation, flip,
// and crop are applied afterward as CSS on the canvas element itself, so the
// canvas/frame never resizes based on the crop or rotation angle — it stays
// the one stable coordinate space the crop-box overlay's handle math expects.
function drawEditPreview(canvas: HTMLCanvasElement, img: HTMLImageElement, adj: EditAdj) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (iw === 0 || ih === 0) return;

  const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(iw, ih));
  const pw = Math.max(1, Math.round(iw * scale));
  const ph = Math.max(1, Math.round(ih * scale));

  canvas.width = pw;
  canvas.height = ph;

  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, pw, ph);

  const imageData = ctx.getImageData(0, 0, pw, ph);
  applyPixelAdj(imageData.data, pw, ph, adj);
  ctx.putImageData(imageData, 0, 0);
}

export function FullscreenViewer() {
  const {
    items = [],
    selected: selectedPhoto,
    setSelected,
    selectNext,
    selectPrevious,
    applyMetadataOverride,
  } = useSelectionContext();
  const photo = selectedPhoto;

  // While the viewer is open, the grid behind it must not keep animating a
  // live photo the user isn't looking at — see feedback #80. Reuses the same
  // suppression the tile hover previews claim, so opening the viewer stops
  // any ambient clip already running and blocks new ones until it closes.
  useEffect(() => {
    if (!photo) return undefined;
    return suppressAmbientPlayback();
    // Only whether a photo is open matters here, not which one — re-running
    // per photo-to-photo navigation would needlessly flicker the suppression
    // off and back on between two photos that are both "the viewer is open".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(photo)]);

  // Prefetch adjacent images so arrow-key navigation feels instant.
  useEffect(() => {
    if (!photo) return;
    const idx = items.findIndex((item) => item.path === photo.path);
    const neighbors = [items[idx - 1], items[idx + 1]].filter(
      (item) => item?.mediaType === "photo",
    );
    const links: HTMLLinkElement[] = neighbors.map((item) => {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.as = "image";
      link.href = item.previewUrl;
      document.head.appendChild(link);
      return link;
    });
    return () => {
      links.forEach((link) => link.remove());
    };
  }, [photo, items]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const abrGuardDetachRef = useRef<(() => void) | null>(null);
  const playbackOperationIdRef = useRef<string | null>(null);
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

  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
  const [videoStatus, setVideoStatus] = useState<VideoStatus>(null);
  // ABR quality selector. `hlsLevels` are the variants the player can switch between
  // (ascending height); `manualLevel` is -1 for Auto/ABR or a level index to lock to;
  // `activeLevelHeight` is the height ABR is currently playing (for the "Auto" label).
  const [hlsLevels, setHlsLevels] = useState<{ index: number; height: number }[]>([]);
  const [manualLevel, setManualLevel] = useState<number>(-1);
  const [activeLevelHeight, setActiveLevelHeight] = useState<number | null>(null);
  const [videoAspectRatio, setVideoAspectRatio] = useState<number | null>(null);
  const [photoAspectRatio, setPhotoAspectRatio] = useState(1);
  const [fullImageLoaded, setFullImageLoaded] = useState(false);
  const [showLiveVideo, setShowLiveVideo] = useState(false);
  // Opening a photo starts on the still, unless the grid says the user clicked
  // that tile's live badge — then go straight to the motion clip.
  useEffect(() => {
    setShowLiveVideo(consumeLiveOpenIntent(photo?.path));
  }, [photo?.path]);
  const [showFileInfo, setShowFileInfo] = useState(false);
  const [showFaces, setShowFaces] = useState(false);
  const [hasFaceOverlayData, setHasFaceOverlayData] = useState(false);
  const [peopleFaces, setPeopleFaces] = useState<PhotoPersonFace[]>([]);
  // Which unnamed face's "Who is this?" chip is open, if any (see
  // FaceAssignPanel). Bumping facesRefreshToken re-runs the faces-fetch
  // effect below to pick up a just-saved name/merge without duplicating its
  // fetch logic.
  const [activeFaceAssign, setActiveFaceAssign] = useState<NamedFace | null>(null);
  const [facesRefreshToken, setFacesRefreshToken] = useState(0);
  // AI caption (<=6 words, from the vision model on Ollama): drives both the
  // slide-down toast and a temporary document.title override while this
  // photo is open. `toastKey` bumps on every new caption so the CSS
  // slide-down animation replays even if the same photo re-fetches.
  const [aiCaption, setAiCaption] = useState<{ text: string; toastKey: number } | null>(null);
  const captionToastKeyRef = useRef(0);
  const previousDocumentTitleRef = useRef<string | null>(null);
  const [exportMode, setExportMode] = useState<"share" | "download" | null>(null);
  const [showCaptions, setShowCaptions] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [cropActive, setCropActive] = useState(false);
  const [canvasAdj, setCanvasAdj] = useState<EditAdj>(DEFAULT_ADJ);
  const [previewImgLoaded, setPreviewImgLoaded] = useState(false);
  const previewImgRef = useRef<HTMLImageElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRafRef = useRef<number | null>(null);
  const [savedAdj, setSavedAdj] = useState<EditAdj>(DEFAULT_ADJ);
  const latestAdjRef = useRef<EditAdj>(DEFAULT_ADJ);
  const rawSavedSvgId = useId();
  const savedSvgId = `pev-${rawSavedSvgId.replace(/:/g, "")}`;
  const [cropContainerEl, setCropContainerEl] = useState<HTMLDivElement | null>(null);
  const [transcriptTrackUrl, setTranscriptTrackUrl] = useState<string | null>(null);
  const captionBlobUrlRef = useRef<string | null>(null);
  const [photoZoom, setPhotoZoom] = useState({
    isZoomed: false,
    originXPercent: 50,
    originYPercent: 50,
    scale: PHOTO_ZOOM_DEFAULT_SCALE,
  });

  useEffect(() => {
    const hasFaceRegions =
      photo !== null &&
      photo.mediaType !== "video" &&
      parseFaceRegions(photo.metadata?.regions).length > 0;
    const hasFaceTableBoxes =
      photo !== null &&
      photo.mediaType !== "video" &&
      parseFaceTableBoxes(photo.metadata?.faceTableBoxes).length > 0;

    setShowLiveVideo(false);
    setShowFaces(false);
    setHasFaceOverlayData(hasFaceRegions || hasFaceTableBoxes);
    setPeopleFaces([]);
    setExportMode(null);
    setEditMode(false);
    setPreviewImgLoaded(false);
    setCanvasAdj(DEFAULT_ADJ);
    const rawEditAdj = photo?.metadata?.editAdj;
    const parsedAdj =
      rawEditAdj && typeof rawEditAdj === "string"
        ? (() => { try { return JSON.parse(rawEditAdj) as EditAdj; } catch { return DEFAULT_ADJ; } })()
        : DEFAULT_ADJ;
    setSavedAdj(parsedAdj);
    latestAdjRef.current = parsedAdj;
    setPhotoAspectRatio(readMetadataAspectRatio(photo?.metadata));
    setFullImageLoaded(false);
    setPhotoZoom({
      isZoomed: false,
      originXPercent: 50,
      originYPercent: 50,
      scale: PHOTO_ZOOM_DEFAULT_SCALE,
    });

    // Reset captions for new item
    if (captionBlobUrlRef.current) {
      URL.revokeObjectURL(captionBlobUrlRef.current);
      captionBlobUrlRef.current = null;
    }
    setTranscriptTrackUrl(null);
    setShowCaptions(false);

    if (photo?.mediaType === "video") {
      const clientOperationId = createClientOperationId();
      playbackOperationIdRef.current = clientOperationId;
      logClientEvent({
        level: "info",
        event: "video.playback.selected",
        message: `Selected video ${photo.path}`,
        clientOperationId,
        data: { path: photo.path },
        immediate: true,
      });
      return;
    }

    playbackOperationIdRef.current = null;
  }, [photo?.path]);

  // Fetch the photo's detected faces (with resolved People names) so the face
  // overlay can label each face and link to its person page. facesRefreshToken
  // is bumped after a successful FaceAssignPanel save so a just-named/merged
  // face's label updates immediately, without a second copy of this fetch.
  useEffect(() => {
    if (!photo || photo.mediaType === "video") return;

    const abortController = new AbortController();
    fetchPeopleFacesForFile(photo.path, abortController.signal)
      .then((faces) => setPeopleFaces(faces))
      .catch(() => {
        // Face names are a non-essential enhancement; leave the overlay to fall
        // back to metadata boxes if the lookup fails or is aborted.
      });

    return () => abortController.abort();
  }, [photo?.path, photo?.mediaType, facesRefreshToken]);

  // Closes any open "Who is this?" panel when the viewer moves to a
  // different photo, rather than leaving it open against the wrong face.
  useEffect(() => {
    setActiveFaceAssign(null);
  }, [photo?.path]);

  // AI caption: fired on every photo open, shown as a slide-down toast and
  // (while this photo stays open) the tab title. A real generation takes
  // ~90-100s on the current Ollama host, and users flip through photos far
  // faster than that — so this must be cancelled (not just ignored) the
  // moment the photo changes or the viewer closes, or a slow response for a
  // long-since-abandoned photo could land after a later one already has its
  // own caption showing.
  useEffect(() => {
    setAiCaption(null);
    if (!photo) {
      // Viewer closed: hand the tab title back to whatever owned it before
      // (usePageTitle's filter-derived title, or the static "Photrix"
      // default) rather than leaving a stale caption in the tab forever.
      if (previousDocumentTitleRef.current !== null) {
        document.title = previousDocumentTitleRef.current;
        previousDocumentTitleRef.current = null;
      }
      return;
    }

    // Capture the title as it stood *before* this photo's caption can touch
    // it, so closing (or the caption never arriving) restores exactly that —
    // usePageTitle can keep updating this in the background (filter changes)
    // without the two fighting: whichever one wrote most recently wins while
    // the viewer is open, and closing always hands control back to
    // usePageTitle rather than freezing on a stale caption title.
    if (previousDocumentTitleRef.current === null) {
      previousDocumentTitleRef.current = document.title;
    } else {
      // Flipping between photos inside an already-open viewer: don't let the
      // previous photo's caption linger in the tab title while this one's is
      // still pending.
      document.title = previousDocumentTitleRef.current;
    }

    // Captioning is photo-only (the vision model takes a single still, not a
    // video) — the server would also just return null for a video, but skip
    // the round-trip entirely rather than firing a request that can never
    // succeed.
    if (photo.mediaType === "video") return;

    const abortController = new AbortController();
    fetchPhotoCaption(photo.path, abortController.signal)
      .then((caption) => {
        if (!caption) return;
        captionToastKeyRef.current += 1;
        setAiCaption({ text: caption, toastKey: captionToastKeyRef.current });
        document.title = caption;
      })
      .catch(() => {
        // Aborted (photo changed / viewer closed) or network error — no
        // caption for this photo; nothing to show or roll back.
      });

    return () => abortController.abort();
  }, [photo?.path, photo?.mediaType]);

  // Auto-dismiss the toast a few seconds after it appears (it's a passing
  // notification, not persistent UI) — the tab title is unaffected, it stays
  // the caption until the photo changes or the viewer closes.
  useEffect(() => {
    if (!aiCaption) return;
    const timer = setTimeout(() => setAiCaption(null), 6000);
    return () => clearTimeout(timer);
  }, [aiCaption?.toastKey]);

  // Fetch transcript segments for videos
  useEffect(() => {
    if (!photo || photo.mediaType !== "video") return;

    const abortController = new AbortController();

    fetchTranscriptSegments(
      photo.path,
      abortController.signal,
      playbackOperationIdRef.current ?? undefined,
    )
      .then((segments) => {
        if (segments.length === 0) return;
        const vtt = segmentsToWebVTT(segments);
        const blob = new Blob([vtt], { type: "text/vtt" });
        const url = URL.createObjectURL(blob);
        captionBlobUrlRef.current = url;
        setTranscriptTrackUrl(url);
      })
      .catch(() => {
        // No transcript available — caption button stays hidden
      });

    return () => {
      abortController.abort();
    };
  }, [photo?.path, photo?.mediaType]);

  // Sync caption track mode with showCaptions toggle
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const track = video.textTracks[0];
    if (!track) return;
    track.mode = showCaptions ? "showing" : "hidden";
  }, [showCaptions, transcriptTrackUrl]);

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

    const markPlaybackUnavailable = () => {
      destroyHls();
      clearVideoSource(video);
      if (cancelled) {
        return;
      }
      setVideoStatus("unavailable");
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

        const negotiation = await negotiateVideoPlayback({
          path: photo.path,
          bandwidthMbps: playbackProfile.bandwidthMbps,
          hevcSupported: playbackProfile.hevcSupported,
          forceTranscode,
          clientOperationId,
        });
        if (cancelled) return;

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
              if (!cancelled) {
                try {
                  video.currentTime = resumeAt;
                } catch {
                  // Seeking may be rejected if the media isn't seekable yet; the
                  // stream still plays from the start, which is acceptable.
                }
              }
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
          markPlaybackUnavailable();
          return;
        }

        if (negotiation.mode === "direct") {
          // The server measured the connection as fast enough for the untranscoded
          // file (and the browser supports its codec), so play it directly — no GPU.
          if (!cancelled) setVideoStatus("direct");
          restorePlaybackPosition();
          // negotiation.url is server-built and token-less; use photo.originalUrl
          // (client-built, token-bearing) for the same file.
          video.src = photo.originalUrl;
          safePlay(video, "[Video] Autoplay prevented (direct):");
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
            startLevel: 0,
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
            ...(playbackProfile.bandwidthMbps
              ? { abrEwmaDefaultEstimate: playbackProfile.bandwidthMbps * 1_000_000 }
              : {}),
          });

          restorePlaybackPosition();
          hls.loadSource(hlsUrl);
          hls.attachMedia(video);
          if (!cancelled) setVideoStatus("hls");

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
            if (!mediaSource || mediaSource.readyState !== "open" || mediaSource.updating)
              return;
            if (media.duration === dur) return;
            try {
              mediaSource.duration = dur;
              // Successfully set duration; stop listening to avoid redundant calls
              hls.off(Hls.Events.MANIFEST_PARSED, manifestParsedHandler);
              hls.off(Hls.Events.LEVEL_LOADED, applyKnownDuration);
              hls.off(Hls.Events.BUFFER_APPENDED, applyKnownDuration);
            } catch {
              // Setting duration may not be permitted at this moment; keep listening
            }
          };

          const manifestParsedHandler = () => {
            // Expose the available variants to the quality selector (ascending height).
            if (!cancelled) {
              setHlsLevels(
                hls.levels.map((level, index) => ({ index, height: level.height })),
              );
            }
            logClientEvent({
              level: "info",
              event: "video.hls.manifest.parsed",
              message: `Parsed HLS manifest for ${photo.path}`,
              clientOperationId,
              data: { path: photo.path, levels: hls.levels.length },
            });
            safePlay(video, "[HLS] Autoplay prevented:");
            applyKnownDuration();
          };

          hls.on(Hls.Events.MANIFEST_PARSED, manifestParsedHandler);
          hls.on(Hls.Events.LEVEL_LOADED, applyKnownDuration);
          hls.on(Hls.Events.BUFFER_APPENDED, applyKnownDuration);

          // Reflect the level ABR has settled on so the "Auto" option can show it.
          hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
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
            markPlaybackUnavailable();
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
          if (!cancelled) setVideoStatus("hls");
          restorePlaybackPosition();
          // For native HLS (Safari), Authorization headers can't be set, so
          // embed the token as a query param. The server propagates it through
          // all rewritten variant/segment URLs.
          const nativeToken = getToken();
          video.src = nativeToken
            ? `${hlsUrl}&token=${encodeURIComponent(nativeToken)}`
            : hlsUrl;
          safePlay(video, "[HLS] Autoplay prevented (native):");
          return;
        }

        // Browser can play neither hls.js nor native HLS: no raw fallback.
        markPlaybackUnavailable();
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
        markPlaybackUnavailable();
      }
    };

    void loadSelectedPlayback();

    return () => {
      cancelled = true;
      logClientEvent({
        level: "info",
        event: "video.playback.cleanup",
        message: `Cleaned up playback for ${photo.path}`,
        clientOperationId,
        data: { path: photo.path },
      });
      destroyHls();
      clearVideoSource(video);
    };
    // forceTranscode re-runs this to switch a stalled direct stream over to HLS.
  }, [photo, forceTranscode]);

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

    const onPlaying = () => {
      clearStallTimer();
      logVideoEvent("video.element.playing", "info");
    };
    const onCanPlay = () => logVideoEvent("video.element.canplay", "info");
    const onWaiting = () => {
      logVideoEvent("video.element.waiting", "warn");
      armDirectStallFallback();
    };
    const onStalled = () => {
      logVideoEvent("video.element.stalled", "warn");
      armDirectStallFallback();
    };
    const onError = () => {
      logVideoEvent("video.element.error", "error");
      if (
        hlsRef.current ||
        videoStatus === "unavailable" ||
        !(video.currentSrc || video.getAttribute("src"))
      ) {
        return;
      }

      clearVideoSource(video);
      setVideoStatus("unavailable");
      setHlsLevels([]);
      setManualLevel(-1);
      setActiveLevelHeight(null);
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onStalled);
    video.addEventListener("error", onError);

    return () => {
      clearStallTimer();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onStalled);
      video.removeEventListener("error", onError);
    };
  }, [photo?.path, photo?.mediaType, videoStatus]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    syncDialogOpenState(dialog, Boolean(photo));
  }, [photo]);

  useEffect(() => {
    if (!photo) return;
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.scrollbarGutter = "unset";
    return () => {
      document.documentElement.style.overflow = "";
      document.documentElement.style.scrollbarGutter = "";
    };
  }, [photo]);

  useEffect(() => {
    if (!photo) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (editMode) {
          setEditMode(false);
        } else {
          setSelected(null);
        }
        return;
      }
      if (editMode) return;
      if (e.key === "ArrowRight") { e.preventDefault(); selectNext(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); selectPrevious(); }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [photo, editMode, selectNext, selectPrevious, setSelected]);

  const handleClose = () => {
    setSelected(null);
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) {
      setSelected(null);
    }
  };

  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      setSelected(null);
    }
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.changedTouches[0];
    setTouchStart({ x: touch.clientX, y: touch.clientY });
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!touchStart) {
      return;
    }

    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = touch.clientY - touchStart.y;
    setTouchStart(null);

    const isHorizontalSwipe = Math.abs(deltaX) > Math.abs(deltaY);
    if (!isHorizontalSwipe || Math.abs(deltaX) < SWIPE_THRESHOLD_PX) {
      return;
    }

    if (deltaX < 0) {
      selectNext();
      return;
    }

    selectPrevious();
  };

  const handleCropActiveChange = useCallback((active: boolean) => {
    setCropActive(active);
    if (active) setPhotoZoom((z) => ({ ...z, isZoomed: false }));
  }, []);

  const handlePhotoClick = (e: React.MouseEvent<HTMLElement>) => {
    if (cropActive) return;
    if (photoZoom.isZoomed) {
      setPhotoZoom((current) => ({ ...current, isZoomed: false }));
      return;
    }

    const bounds = e.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) {
      return;
    }

    const originXPercent = ((e.clientX - bounds.left) / bounds.width) * 100;
    const originYPercent = ((e.clientY - bounds.top) / bounds.height) * 100;

    setPhotoZoom({
      isZoomed: true,
      originXPercent: Math.min(Math.max(originXPercent, 0), 100),
      originYPercent: Math.min(Math.max(originYPercent, 0), 100),
      scale: PHOTO_ZOOM_DEFAULT_SCALE,
    });
  };

  const handlePhotoWheel = (e: React.WheelEvent<HTMLElement>) => {
    if (cropActive || !photoZoom.isZoomed) {
      return;
    }

    setPhotoZoom((current) => {
      const direction = e.deltaY < 0 ? 1 : -1;
      const nextScale = Math.min(
        PHOTO_ZOOM_MAX_SCALE,
        Math.max(PHOTO_ZOOM_MIN_SCALE, current.scale + direction * PHOTO_ZOOM_STEP),
      );
      return {
        ...current,
        scale: nextScale,
        isZoomed: nextScale > PHOTO_ZOOM_MIN_SCALE,
      };
    });
  };

  const meta = photo?.metadata;

  const currentRating =
    typeof meta?.rating === "number" && meta.rating > 0 ? meta.rating : 0;
  const currentTags = Array.isArray(meta?.tags) ? (meta.tags as string[]) : [];

  // Optimistically apply a tagging change to the selected item, then persist it.
  // The override survives grid re-pushes; a failed PATCH just logs (the value is
  // reconciled on the next refetch).
  const persistTagging = useCallback(
    (patch: { rating?: number; tags?: string[]; description?: string | null }) => {
      const path = photo?.path;
      if (!path) return;
      const override: { rating?: number | null; tags?: string[]; description?: string | null } =
        {};
      if (patch.rating !== undefined) override.rating = patch.rating > 0 ? patch.rating : null;
      if (patch.tags !== undefined) override.tags = patch.tags;
      if (patch.description !== undefined) override.description = patch.description;
      applyMetadataOverride([path], override);
      void updatePhotoMetadata(path, patch).catch(() => {
        // Best-effort; optimistic value stays until the next refetch.
      });
    },
    [photo?.path, applyMetadataOverride],
  );

  // Number keys 1–5 set the star rating, 0 clears it — quick tagging while
  // stepping through a slideshow. Ignored while typing in the label field.
  useEffect(() => {
    if (!photo || editMode || READ_ONLY) return;

    const handleRatingKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key >= "1" && e.key <= "5") {
        e.preventDefault();
        persistTagging({ rating: Number(e.key) });
      } else if (e.key === "0") {
        e.preventDefault();
        persistTagging({ rating: 0 });
      }
    };

    window.addEventListener("keydown", handleRatingKey);
    return () => window.removeEventListener("keydown", handleRatingKey);
  }, [photo, editMode, persistTagging]);

  useEffect(() => {
    if (!editMode || !previewImgLoaded) return;
    const canvas = previewCanvasRef.current;
    const img = previewImgRef.current;
    if (!canvas || !img) return;
    const adj = canvasAdj;
    if (previewRafRef.current !== null) cancelAnimationFrame(previewRafRef.current);
    previewRafRef.current = requestAnimationFrame(() => {
      previewRafRef.current = null;
      drawEditPreview(canvas, img, adj);
    });
    return () => {
      if (previewRafRef.current !== null) {
        cancelAnimationFrame(previewRafRef.current);
        previewRafRef.current = null;
      }
    };
  }, [canvasAdj, editMode, previewImgLoaded]);

  // Neighbours for the swipe carousel (photos in normal viewing mode).
  const currentIndex = photo ? items.findIndex((item) => item.path === photo.path) : -1;
  const prevPhoto = currentIndex > 0 ? items[currentIndex - 1] : null;
  const nextPhoto =
    currentIndex >= 0 && currentIndex < items.length - 1 ? items[currentIndex + 1] : null;
  // The carousel owns swipe navigation for still photos; the container-level
  // swipe fallback stays for video / live-photo / editing.
  const usesSwipeViewer =
    photo != null && photo.mediaType !== "video" && !showLiveVideo && !editMode;

  const faceToggleDisabled =
    photo?.mediaType === "video" || (!hasFaceOverlayData && peopleFaces.length === 0);
  const aiCaptionToast = aiCaption ? (
    <div key={aiCaption.toastKey} className={css.aiCaptionToast} role="status">
      {aiCaption.text}
    </div>
  ) : null;

  const zoomStyle = {
    "--zoom-origin-x": `${photoZoom.originXPercent}%`,
    "--zoom-origin-y": `${photoZoom.originYPercent}%`,
    "--zoom-scale": photoZoom.isZoomed ? photoZoom.scale.toString() : "1",
    "--zoom-cursor": cropActive ? "default" : photoZoom.isZoomed ? "zoom-out" : "zoom-in",
    // Counter-scale for face labels: they must stay a fixed screen size while
    // the photo (and their own anchor position) zooms in, otherwise a crowded
    // photo becomes *harder* to read the more you zoom in on it.
    "--label-counter-scale": photoZoom.isZoomed ? (1 / photoZoom.scale).toString() : "1",
  } as React.CSSProperties;

  const editTotalDeg = canvasAdj.rotation + canvasAdj.rotate90 * 90;
  const editClipPath =
    canvasAdj.cropTop === 0 && canvasAdj.cropRight === 0 &&
    canvasAdj.cropBottom === 0 && canvasAdj.cropLeft === 0
      ? "none"
      : `inset(${canvasAdj.cropTop}% ${canvasAdj.cropRight}% ${canvasAdj.cropBottom}% ${canvasAdj.cropLeft}%)`;

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialogRef}
      className={css.dialog}
      onClose={handleClose}
      onCancel={handleClose}
      onClick={handleBackdropClick}
    >
      {photo && (
        <>
          {/* SVG filter for saved edits, active in the non-edit view */}
          {isDirty(savedAdj) && !editMode && <EditSvgDefs adj={savedAdj} filterId={savedSvgId} />}
          {exportMode && (
            <ShareOptionsModal
              photos={[photo]}
              mode={exportMode}
              portalRoot={dialogRef.current}
              onClose={() => setExportMode(null)}
            />
          )}
          <div className={css.viewerLayout}>
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div
              className={
                editMode && photo.mediaType !== "video"
                  ? cx(css.container, css.containerEditing)
                  : css.container
              }
              onClick={handleContainerClick}
              onTouchStart={usesSwipeViewer ? undefined : handleTouchStart}
              onTouchEnd={usesSwipeViewer ? undefined : handleTouchEnd}
            >
              <div className={css.topRightActions}>
                {photo.mediaType === "video" &&
                  videoStatus === "hls" &&
                  hlsLevels.length > 1 && (
                    <select
                      className={css.qualitySelect}
                      value={manualLevel}
                      aria-label="Video quality"
                      title="Video quality"
                      onChange={(e) => {
                        const level = Number(e.target.value);
                        setManualLevel(level);
                        const hls = hlsRef.current;
                        // -1 re-enables ABR (auto); a level index locks to that quality.
                        if (hls) hls.currentLevel = level;
                      }}
                    >
                      <option value={-1}>
                        {`Auto${activeLevelHeight ? ` (${activeLevelHeight}p)` : ""}`}
                      </option>
                      {[...hlsLevels].reverse().map((level) => (
                        <option key={level.index} value={level.index}>
                          {`${level.height}p`}
                        </option>
                      ))}
                    </select>
                  )}
                <button
                  type="button"
                  onClick={() => setExportMode("share")}
                  className={css.infoButton}
                  aria-label="Share item"
                  title="Share item"
                >
                  <Share24Regular />
                </button>
                <button
                  type="button"
                  onClick={() => setExportMode("download")}
                  className={css.infoButton}
                  aria-label="Download item"
                  title="Download item"
                >
                  <ArrowDownload24Regular />
                </button>
                {photo.mediaType !== "video" && (
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className={css.infoButton}
                    aria-label="Print item"
                    title="Print item"
                  >
                    <Print24Regular />
                  </button>
                )}
                {photo.mediaType === "video" && transcriptTrackUrl && (
                  <button
                    type="button"
                    onClick={() => setShowCaptions((current) => !current)}
                    className={css.faceButton}
                    aria-label={showCaptions ? "Hide captions" : "Show captions"}
                    title={showCaptions ? "Hide captions" : "Show captions"}
                  >
                    {showCaptions ? (
                      <ClosedCaption24Regular />
                    ) : (
                      <ClosedCaptionOff24Regular />
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowFaces((current) => !current)}
                  className={css.faceButton}
                  aria-label={showFaces ? "Hide faces" : "Show faces"}
                  title={showFaces ? "Hide faces" : "Show faces"}
                  disabled={faceToggleDisabled}
                >
                  <ScanPerson24Regular />
                </button>
                {photo.mediaType !== "video" && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditMode((m) => !m);
                      if (!editMode) setShowFileInfo(false);
                    }}
                    className={editMode ? `${css.infoButton} ${css.infoButtonActive}` : css.infoButton}
                    aria-label={editMode ? "Close editor" : "Edit photo"}
                    title={editMode ? "Close editor" : "Edit photo"}
                  >
                    <ImageEdit24Regular />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowFileInfo((current) => !current)}
                  className={css.infoButton}
                  aria-label={showFileInfo ? "Hide file info" : "Show file info"}
                  title={showFileInfo ? "Hide file info" : "Show file info"}
                >
                  <Info24Regular />
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className={css.closeButton}
                  aria-label="Close"
                >
                  <Dismiss24Regular />
                </button>
              </div>
              {photo.mediaType !== "video" && photo.livePhotoUrl && (
                <button
                  type="button"
                  onClick={() => setShowLiveVideo((v) => !v)}
                  className={css.livePhotoButton}
                  aria-label={showLiveVideo ? "Show photo" : "Play live photo"}
                  title={showLiveVideo ? "Show photo" : "Play live photo"}
                >
                  <Live24Regular />
                </button>
              )}
              {!editMode && currentIndex > 0 && (
                <button
                  type="button"
                  className={`${css.navButton} ${css.navPrev}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectPrevious();
                  }}
                  aria-label="Previous"
                  title="Previous"
                >
                  <ChevronLeft48Regular />
                </button>
              )}
              {!editMode && currentIndex >= 0 && currentIndex < items.length - 1 && (
                <button
                  type="button"
                  className={`${css.navButton} ${css.navNext}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectNext();
                  }}
                  aria-label="Next"
                  title="Next"
                >
                  <ChevronRight48Regular />
                </button>
              )}
              {photo.mediaType === "video" ? (
                <>
                  <div
                    className={css.videoWrapper}
                    // Same name as this photo's grid tile (see
                    // ThumbnailGrid) so the View Transitions API morphs the
                    // clicked thumbnail into this wrapper instead of a hard
                    // cut — the "expand in place" open feedback #77 asked for.
                    style={
                      {
                        ...(videoAspectRatio
                          ? {
                              aspectRatio: videoAspectRatio,
                              "--video-ar": videoAspectRatio,
                            }
                          : {}),
                        viewTransitionName: photoViewTransitionName(photo.path),
                      } as React.CSSProperties
                    }
                  >
                    <video
                      ref={videoRef}
                      key={photo.path}
                      controls
                      className={css.videoMedia}
                      poster={photo.previewUrl}
                      preload="metadata"
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        if (v.videoWidth && v.videoHeight) {
                          setVideoAspectRatio(v.videoWidth / v.videoHeight);
                        }
                      }}
                    >
                      {transcriptTrackUrl ? (
                        <track
                          key={transcriptTrackUrl}
                          kind="captions"
                          src={transcriptTrackUrl}
                          label="Transcript"
                          default={showCaptions}
                        />
                      ) : (
                        <track
                          kind="captions"
                          src="data:,"
                          label="Captions not provided"
                        />
                      )}
                      Your browser does not support HTML video playback.
                    </video>
                  </div>
                  {videoStatus && (
                    <span className={css.videoBadge} data-testid="video-status">
                      {videoStatusLabel[videoStatus]}
                    </span>
                  )}
                </>
              ) : showLiveVideo && photo.livePhotoUrl ? (
                <video
                  key={photo.livePhotoUrl}
                  src={photo.livePhotoUrl}
                  autoPlay
                  loop
                  playsInline
                  muted
                  className={css.media}
                />
              ) : editMode ? (
                <div
                  className={css.photoFrame}
                  style={
                    {
                      ...zoomStyle,
                      "--photo-ar": String(photoAspectRatio),
                    } as React.CSSProperties
                  }
                >
                  {aiCaptionToast}
                  {/* Thumbnail shown until canvas is ready */}
                  <div
                    className={css.thumbnailClip}
                    aria-hidden="true"
                    style={{ opacity: previewImgLoaded ? 0 : 1 }}
                  >
                    <div
                      className={css.thumbnailUnderlay}
                      style={{ backgroundImage: `url("${photo.thumbnailUrl}")` }}
                    />
                  </div>
                  {/* Hidden source image for canvas drawing */}
                  {/* eslint-disable-next-line jsx-a11y/alt-text */}
                  <img
                    ref={previewImgRef}
                    src={photo.fullUrl}
                    alt=""
                    style={{ display: "none" }}
                    onLoad={() => {
                      const img = previewImgRef.current;
                      if (!img) return;
                      setPreviewImgLoaded(true);
                      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                        setPhotoAspectRatio(img.naturalWidth / img.naturalHeight);
                        setFullImageLoaded(true);
                      }
                    }}
                  />
                  {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
                  <canvas
                    ref={previewCanvasRef}
                    className={
                      photoZoom.isZoomed
                        ? `${css.photoMedia} ${css.zoomedMedia}`
                        : css.photoMedia
                    }
                    onClick={handlePhotoClick}
                    onWheel={handlePhotoWheel}
                    style={{
                      ...zoomStyle,
                      opacity: previewImgLoaded ? 1 : 0,
                      "--edit-rotate-deg": `${editTotalDeg}deg`,
                      "--edit-flip-x": canvasAdj.flipH ? -1 : 1,
                      "--edit-flip-y": canvasAdj.flipV ? -1 : 1,
                      "--edit-clip-path": editClipPath,
                    } as React.CSSProperties}
                  />
                  {showFaces && (
                    <FaceOverlay
                      regionsRaw={photo.metadata?.regions}
                      faceTableBoxesRaw={photo.metadata?.faceTableBoxes}
                      aspectRatio={photoAspectRatio}
                      namedFaces={peopleFaces}
                      onAssignFace={READ_ONLY ? undefined : setActiveFaceAssign}
                    />
                  )}
                  <div ref={setCropContainerEl} className={css.cropOverlayContainer} />
                </div>
              ) : (
                <SwipePhotoViewer
                  photo={photo}
                  prevPhoto={prevPhoto}
                  nextPhoto={nextPhoto}
                  photoAspectRatio={photoAspectRatio}
                  fullImageLoaded={fullImageLoaded}
                  viewTransitionName={photoViewTransitionName(photo.path)}
                  editStyle={isDirty(savedAdj) ? computeStyle(savedAdj, savedSvgId) : undefined}
                  onImageLoad={(e) => {
                    setFullImageLoaded(true);
                    const { naturalWidth, naturalHeight } = e.currentTarget;
                    if (naturalWidth > 0 && naturalHeight > 0) {
                      setPhotoAspectRatio(naturalWidth / naturalHeight);
                    }
                  }}
                  onNext={selectNext}
                  onPrev={selectPrevious}
                  onClose={() => setSelected(null)}
                >
                  {aiCaptionToast}
                  {showFaces && (
                    <FaceOverlay
                      regionsRaw={photo.metadata?.regions}
                      faceTableBoxesRaw={photo.metadata?.faceTableBoxes}
                      aspectRatio={photoAspectRatio}
                      namedFaces={peopleFaces}
                      onAssignFace={READ_ONLY ? undefined : setActiveFaceAssign}
                    />
                  )}
                </SwipePhotoViewer>
              )}
              {!editMode && !READ_ONLY && photo.mediaType !== "video" && activeFaceAssign && (
                <FaceAssignPanel
                  face={activeFaceAssign}
                  onClose={() => setActiveFaceAssign(null)}
                  onAssigned={() => {
                    setActiveFaceAssign(null);
                    setFacesRefreshToken((token) => token + 1);
                  }}
                />
              )}
              {!editMode && !READ_ONLY && photo.mediaType !== "video" && !activeFaceAssign && (
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
                <div
                  className={css.taggingBar}
                  onClick={(e) => e.stopPropagation()}
                >
                  <StarRating
                    value={currentRating}
                    onChange={(rating) => persistTagging({ rating })}
                    label="Star rating"
                  />
                  <span className={css.taggingDivider} aria-hidden="true" />
                  <TagEditor
                    tags={currentTags}
                    onChange={(tags) => persistTagging({ tags })}
                  />
                </div>
              )}
            </div>
            {editMode && photo.mediaType !== "video" && (
              <PhotoEditor
                photoName={photo.name}
                photoPath={photo.path}
                photoFullUrl={photo.fullUrl}
                imageAspectRatio={photoAspectRatio}
                cropContainerEl={cropContainerEl}
                initialAdj={savedAdj}
                onAdjChange={(adj) => { latestAdjRef.current = adj; setCanvasAdj(adj); }}
                onCropActiveChange={handleCropActiveChange}
                onClose={() => {
                  setCropActive(false);
                  const adj = latestAdjRef.current;
                  setSavedAdj(adj);
                  setEditMode(false);
                  if (!READ_ONLY) {
                    void updatePhotoMetadata(photo.path, {
                      editAdj: isDirty(adj) ? JSON.stringify(adj) : null,
                    }).catch(() => {});
                  }
                }}
              />
            )}
            {!editMode && showFileInfo && (
              <aside className={css.infoSidebar} aria-label="File info panel">
                <h3 className={css.infoTitle}>File info</h3>

                {/* Human-authored caption: seeded from the file's embedded EXIF/IPTC/XMP
                    caption if present, and editable in-app (DB-only, the file itself is
                    never modified) — same overlay pattern as the star rating/tags below. */}
                <h4 className={css.infoSubtitle}>Description</h4>
                {READ_ONLY ? (
                  Boolean(meta?.description) && (
                    <p className={css.infoDescription}>{String(meta?.description)}</p>
                  )
                ) : (
                  <DescriptionEditor
                    key={photo.path}
                    value={typeof meta?.description === "string" ? meta.description : ""}
                    onSave={(next) => persistTagging({ description: next.length > 0 ? next : null })}
                  />
                )}

                {/* AI-generated description */}
                {Boolean(meta?.aiDescription) && (
                  <>
                    <h4 className={css.infoSubtitle}>AI Description</h4>
                    <p className={css.infoDescription}>{String(meta?.aiDescription)}</p>
                  </>
                )}

                {/* Camera */}
                {Boolean(meta?.cameraMake || meta?.cameraModel || meta?.lens) && (
                  <>
                    <h4 className={css.infoSubtitle}>Camera</h4>
                    <dl className={css.infoList}>
                      {Boolean(meta?.cameraMake || meta?.cameraModel) && (
                        <div className={css.infoRow}>
                          <dt>Camera</dt>
                          <dd>
                            {[meta?.cameraMake, meta?.cameraModel]
                              .filter(Boolean)
                              .join(" ")}
                          </dd>
                        </div>
                      )}
                      {Boolean(meta?.lens) && (
                        <div className={css.infoRow}>
                          <dt>Lens</dt>
                          <dd>{String(meta?.lens)}</dd>
                        </div>
                      )}
                    </dl>
                  </>
                )}

                {/* Capture settings */}
                {(meta?.aperture != null ||
                  meta?.exposureTime != null ||
                  meta?.iso != null ||
                  meta?.focalLength != null ||
                  meta?.flash != null ||
                  meta?.whiteBalance != null ||
                  meta?.subjectDistance != null) && (
                  <>
                    <h4 className={css.infoSubtitle}>Capture</h4>
                    <dl className={css.infoList}>
                      {meta.aperture != null && (
                        <div className={css.infoRow}>
                          <dt>Aperture</dt>
                          <dd>{formatAperture(meta.aperture)}</dd>
                        </div>
                      )}
                      {meta.exposureTime != null && (
                        <div className={css.infoRow}>
                          <dt>Shutter Speed</dt>
                          <dd>{formatShutterSpeed(meta.exposureTime)}</dd>
                        </div>
                      )}
                      {meta.iso != null && (
                        <div className={css.infoRow}>
                          <dt>ISO</dt>
                          <dd>{String(meta.iso)}</dd>
                        </div>
                      )}
                      {meta.focalLength != null && (
                        <div className={css.infoRow}>
                          <dt>Focal Length</dt>
                          <dd>{formatFocalLength(meta.focalLength)}</dd>
                        </div>
                      )}
                      {meta.flash != null && (
                        <div className={css.infoRow}>
                          <dt>Flash</dt>
                          <dd>{meta.flash ? "Fired" : "Did not fire"}</dd>
                        </div>
                      )}
                      {meta.whiteBalance != null && (
                        <div className={css.infoRow}>
                          <dt>White Balance</dt>
                          <dd>{String(meta.whiteBalance)}</dd>
                        </div>
                      )}
                      {meta.subjectDistance != null && (
                        <div className={css.infoRow}>
                          <dt>Subject Distance</dt>
                          <dd>{Number(meta.subjectDistance).toFixed(2)} m</dd>
                        </div>
                      )}
                    </dl>
                  </>
                )}

                {/* Derived photo-ready quality aggregate (see server's
                    photoQuality.ts): worst-scoring detected face's
                    smiling/eyes-open/in-focus/well-exposed attributes. Shown
                    only when at least one face has been scored — absent
                    entirely (not "0%") otherwise, since null means "no
                    signal" rather than "bad". Informational only: this never
                    sets or suggests a star rating. */}
                {meta?.photoQualityScore != null && (
                  <>
                    <h4 className={css.infoSubtitle}>Photo quality</h4>
                    <dl className={css.infoList}>
                      <div className={css.infoRow}>
                        <dt>Quality</dt>
                        <dd>{Math.round(meta.photoQualityScore * 100)}%</dd>
                      </div>
                    </dl>
                  </>
                )}

                {/* File details */}
                <h4 className={css.infoSubtitle}>File</h4>
                <dl className={css.infoList}>
                  <div className={css.infoRow}>
                    <dt>Filename</dt>
                    <dd>{photo.name}</dd>
                  </div>
                  <div className={css.infoRow}>
                    <dt>Path</dt>
                    <dd>{photo.path}</dd>
                  </div>
                  {meta?.dateTaken && (
                    <div className={css.infoRow}>
                      <dt>Date Taken</dt>
                      <dd>{new Date(String(meta.dateTaken)).toLocaleString()}</dd>
                    </div>
                  )}
                  {meta?.dimensionWidth != null && meta?.dimensionHeight != null && (
                    <div className={css.infoRow}>
                      <dt>Dimensions</dt>
                      <dd>
                        {String(meta.dimensionWidth)} × {String(meta.dimensionHeight)}
                      </dd>
                    </div>
                  )}
                  {meta?.sizeInBytes != null && (
                    <div className={css.infoRow}>
                      <dt>File Size</dt>
                      <dd>{formatFileSize(meta.sizeInBytes)}</dd>
                    </div>
                  )}
                  {meta?.mimeType && (
                    <div className={css.infoRow}>
                      <dt>Type</dt>
                      <dd>{String(meta.mimeType)}</dd>
                    </div>
                  )}
                  {meta?.duration != null && (
                    <div className={css.infoRow}>
                      <dt>Duration</dt>
                      <dd>{formatDuration(meta.duration)}</dd>
                    </div>
                  )}
                  {meta?.framerate != null && (
                    <div className={css.infoRow}>
                      <dt>Frame Rate</dt>
                      <dd>{String(meta.framerate)} fps</dd>
                    </div>
                  )}
                  {meta?.videoCodec && (
                    <div className={css.infoRow}>
                      <dt>Codec</dt>
                      <dd>{String(meta.videoCodec)}</dd>
                    </div>
                  )}
                  {meta?.rating != null && (
                    <div className={css.infoRow}>
                      <dt>Rating</dt>
                      <dd>{"★".repeat(Number(meta.rating))}</dd>
                    </div>
                  )}
                  {Array.isArray(meta?.tags) && (meta.tags as string[]).length > 0 && (
                    <div className={css.infoRow}>
                      <dt>Tags</dt>
                      <dd>{(meta.tags as string[]).join(", ")}</dd>
                    </div>
                  )}
                </dl>

                <MiniMap
                  latitude={photo.metadata?.locationLatitude}
                  longitude={photo.metadata?.locationLongitude}
                />
              </aside>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
