import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowDownload24Regular,
  ChevronLeft48Regular,
  ChevronRight48Regular,
  ClosedCaption24Regular,
  ClosedCaptionOff24Regular,
  Dismiss24Regular,
  ImageEdit24Regular,
  Info24Regular,
  Live24Filled,
  Live24Regular,
  Print24Regular,
  ScanPerson24Regular,
  DocumentSearch24Regular,
  Share24Regular,
} from "@fluentui/react-icons";
import { consumeLiveOpenIntent } from "../grid/tileMedia/liveOpenIntent";
import { fetchPeopleFacesForFile, fetchPhotoCaption, fetchTranscriptSegments, setFaceVerdicts } from "../../api";
import type { PhotoPersonFace } from "../../api/types";
import { StarRating } from "../StarRating";
import { TagEditor } from "../TagEditor";
import { createClientOperationId, logClientEvent } from "../../diagnostics";
import { FaceOverlay, parseFaceRegions, parseFaceTableBoxes, type NamedFace } from "./FaceOverlay";
import { VideoPeopleTimeline } from "./VideoPeopleTimeline";
import { VideoLoadingOverlay } from "./VideoLoadingOverlay";
import { videoTimelineRows } from "./videoPeople";

// The people timeline under a video: its rows are this tall, and past this many
// it scrolls rather than squeezing the video further.
const PEOPLE_TIMELINE_ROW_PX = 28;
const PEOPLE_TIMELINE_PADDING_PX = 24;
const PEOPLE_TIMELINE_MAX_ROWS = 4;
import { FaceAssignPanel } from "./FaceAssignPanel";
import { useSelectionContext } from "../selection/SelectionContext";
import { ShareOptionsModal } from "../share/ShareOptionsModal";
import { PhotoEditor } from "./photoEdit/PhotoEditor";
import { type EditAdj, DEFAULT_ADJ, computeStyle, isDirty } from "./photoEdit/editAdj";
import { EditSvgDefs } from "./photoEdit/EditSvgDefs";
import { applyPixelAdj } from "./photoEdit/applyPixelAdj";
import { SwipePhotoViewer } from "./SwipePhotoViewer";
import { isSharedView } from "../../hooks/useShareFilter";
import { cx } from "../../cx";
import { photoViewTransitionName } from "../viewTransition";
import { suppressAmbientPlayback } from "../grid/tileMedia/tilePlaybackCoordinator";
import css from "./FullscreenViewer.module.css";
import { syncDialogOpenState } from "../syncDialogOpenState";
import { useMetadataSave } from "../selection/useMetadataSave";
import type { PhotoMetadataOverride } from "../selection/SelectionContext";
import { logFailure } from "../../logFailure";
import { attemptSync } from "../../result";
import { useVideoPlayback } from "./useVideoPlayback";
import { useAiDescription } from "./useAiDescription";
import { FileInfoPanel } from "./FileInfoPanel";
import { TranscriptSearch } from "./TranscriptSearch";
import type { TranscriptSegment } from "../../api/types";
import { useOptionalFilter } from "../filter/FilterContext";
import { segmentsToWebVTT } from "./segmentsToWebVTT";
import { playVideo } from "../playVideo";

// Star ratings and tags persist to the DB via PATCH, which the server rejects
// for share tokens — so hide the tagging bar entirely in a shared view.
const READ_ONLY = isSharedView();

const SWIPE_THRESHOLD_PX = 60;
const PHOTO_ZOOM_DEFAULT_SCALE = 2.5;
const PHOTO_ZOOM_MIN_SCALE = 1;
const PHOTO_ZOOM_MAX_SCALE = 6;
const PHOTO_ZOOM_STEP = 0.25;











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
  } = useSelectionContext();
  const photo = selectedPhoto;
  const filterContext = useOptionalFilter();
  // Feedback #164: a folder in the file-info path opens that folder. Search and
  // content filters are dropped so all the photo's neighbours show. The viewer
  // closes first and the folder is applied in the effect below, in the same
  // render as the URL's preview going away, so it is one history entry: Back
  // returns to the search with this photo open.
  const pendingFolderRef = useRef<string | null>(null);
  const openFolder = filterContext
    ? (folderPath: string) => {
        pendingFolderRef.current = folderPath;
        setSelected(null);
      }
    : undefined;
  const setFilter = filterContext?.setFilter;
  useEffect(() => {
    const folderPath = pendingFolderRef.current;
    if (photo || folderPath === null || !setFilter) return;
    pendingFolderRef.current = null;
    setFilter((prev) => ({
      ...prev,
      path: folderPath,
      semanticQuery: undefined,
      expandToFolder: false,
      peopleInImageFilter: undefined,
      faceClusterFilter: undefined,
      faceAttributeFilter: undefined,
      cameraModelFilter: undefined,
      lensFilter: undefined,
      ratingFilter: undefined,
      locationBounds: undefined,
      dateRange: undefined,
    }));
  }, [photo, setFilter]);

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
  const playbackOperationIdRef = useRef<string | null>(null);

  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
  const [photoAspectRatio, setPhotoAspectRatio] = useState(1);
  const [fullImageLoaded, setFullImageLoaded] = useState(false);
  const [showLiveVideo, setShowLiveVideo] = useState(false);
  // Opening a photo starts on the still, unless the grid says the user clicked
  // that tile's live badge — then go straight to the motion clip.
  useEffect(() => {
    setShowLiveVideo(consumeLiveOpenIntent(photo?.path));
  }, [photo?.path]);
  const [showFileInfo, setShowFileInfo] = useState(false);
  const aiDescription = useAiDescription(photo, showFileInfo);
  const [showFaces, setShowFaces] = useState(false);
  const [hasFaceOverlayData, setHasFaceOverlayData] = useState(false);
  const [peopleFaces, setPeopleFaces] = useState<PhotoPersonFace[]>([]);
  // Which file `peopleFaces` belongs to. The list stays in state until the next
  // file's fetch lands, so the video timeline checks it rather than showing the
  // last video's people over this one.
  const [peopleFacesPath, setPeopleFacesPath] = useState<string | null>(null);
  // Which unnamed face's "Who is this?" chip is open, if any (see
  // FaceAssignPanel). Bumping facesRefreshToken re-runs the faces-fetch
  // effect below to pick up a just-saved name/merge without duplicating its
  // fetch logic.
  const [activeFaceAssign, setActiveFaceAssign] = useState<NamedFace | null>(null);
  const [facesRefreshToken, setFacesRefreshToken] = useState(0);
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
  // The transcript itself, for finding where something is said (feedback #169).
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [showTranscriptSearch, setShowTranscriptSearch] = useState(false);
  const captionBlobUrlRef = useRef<string | null>(null);
  const {
    videoStatus,
    playback,
    lastDataAtRef,
    retry: retryPlayback,
    hlsLevels,
    manualLevel,
    activeLevelHeight,
    chooseLevel,
    videoAspectRatio,
    setVideoAspectRatio,
  } = useVideoPlayback({ photo, videoRef, playbackOperationIdRef });
  const [photoZoom, setPhotoZoom] = useState({
    isZoomed: false,
    originXPercent: 50,
    originYPercent: 50,
    scale: PHOTO_ZOOM_DEFAULT_SCALE,
  });

  // The effects below re-run when the viewer moves to another photo, not on
  // every new photo object (a rating or tag edit produces one). They key on
  // the path and read anything else through latestPhotoRef.
  const photoPath = photo?.path ?? null;
  const photoMediaType = photo?.mediaType ?? null;
  const latestPhotoRef = useRef(photo);
  latestPhotoRef.current = photo;

  useEffect(() => {
    const photo = latestPhotoRef.current;
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
    const parsed =
      rawEditAdj && typeof rawEditAdj === "string"
        ? attemptSync(() => JSON.parse(rawEditAdj) as EditAdj)
        : null;
    if (parsed && !parsed.ok) {
      logFailure("viewer.edits.unreadable", "Saved photo edits are unreadable; showing the original")(parsed.error);
    }
    const parsedAdj = parsed?.ok ? parsed.value : DEFAULT_ADJ;
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
    setTranscriptSegments([]);
    setShowTranscriptSearch(false);
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
  }, [photoPath]);

  // Fetch the photo's detected faces (with resolved People names) so the face
  // overlay can label each face and link to its person page. facesRefreshToken
  // is bumped after a successful FaceAssignPanel save so a just-named/merged
  // face's label updates immediately, without a second copy of this fetch.
  // Videos too: their faces carry when each person is on screen, which the
  // people timeline under the player draws.
  useEffect(() => {
    if (!photoPath) return;

    const abortController = new AbortController();
    fetchPeopleFacesForFile(photoPath, abortController.signal)
      .then((faces) => {
        setPeopleFaces(faces);
        setPeopleFacesPath(photoPath);
      })
      // Names are an enhancement: without them the overlay shows the metadata boxes.
      .catch(logFailure("viewer.faces.failed", "Could not load face names for the viewer"));

    return () => abortController.abort();
  }, [photoPath, facesRefreshToken]);

  // Feedback #145: "this isn't {name}" from the viewer. A rejected verdict
  // pulls the face out of that person, and the refetch drops it from the
  // overlay (only clustered faces come back). Saying who it *is* instead is the
  // name button -> FaceAssignPanel's change mode (feedback #160).
  const handleRejectFace = (face: NamedFace) => {
    setFaceVerdicts([face.faceId], "rejected")
      .then(() => setFacesRefreshToken((token) => token + 1))
      .catch((error: unknown) => {
        logClientEvent({
          level: "warn",
          event: "faces.reject.failed",
          message: `Could not remove ${face.name ?? "face"} from ${photo?.path ?? "photo"}`,
          data: { faceId: face.faceId, error: String(error) },
        });
      });
  };

  // Closes any open "Who is this?" panel when the viewer moves to a
  // different photo, rather than leaving it open against the wrong face.
  useEffect(() => {
    setActiveFaceAssign(null);
  }, [photo?.path]);

  // AI caption: fired on every photo open, used as the tab title while this
  // photo stays open. A real generation takes
  // ~90-100s on the current Ollama host, and users flip through photos far
  // faster than that — so this must be cancelled (not just ignored) the
  // moment the photo changes or the viewer closes, or a slow response for a
  // long-since-abandoned photo could land after a later one already has its
  // own caption showing.
  useEffect(() => {
    if (!photoPath) {
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
    if (photoMediaType === "video") return;

    const abortController = new AbortController();
    fetchPhotoCaption(photoPath, abortController.signal)
      .then((caption) => {
        if (caption) document.title = caption;
      })
      .catch(logFailure("viewer.caption.failed", "Could not load the photo caption"));

    return () => abortController.abort();
  }, [photoPath, photoMediaType]);

  // Fetch transcript segments for videos
  useEffect(() => {
    if (!photoPath || photoMediaType !== "video") return;

    const abortController = new AbortController();

    fetchTranscriptSegments(
      photoPath,
      abortController.signal,
      playbackOperationIdRef.current ?? undefined,
    )
      .then((segments) => {
        if (segments.length === 0) return;
        setTranscriptSegments(segments);
        const vtt = segmentsToWebVTT(segments);
        const blob = new Blob([vtt], { type: "text/vtt" });
        const url = URL.createObjectURL(blob);
        captionBlobUrlRef.current = url;
        setTranscriptTrackUrl(url);
      })
      // Without a transcript the caption button stays hidden.
      .catch(logFailure("viewer.transcript.failed", "Could not load the video transcript"));

    return () => {
      abortController.abort();
    };
  }, [photoPath, photoMediaType]);

  // Sync caption track mode with showCaptions toggle
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const track = video.textTracks[0];
    if (!track) return;
    track.mode = showCaptions ? "showing" : "hidden";
  }, [showCaptions, transcriptTrackUrl]);


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
  const currentTags = useMemo(
    () => (Array.isArray(meta?.tags) ? (meta.tags as string[]) : []),
    [meta?.tags],
  );

  // Optimistically apply a tagging change to the selected item, then persist it.
  // The override survives grid re-pushes; a rejected save puts the previous
  // value back and shows metadataSaveError.
  const { save: saveMetadata, error: metadataSaveError } = useMetadataSave();
  const persistTagging = useCallback(
    (patch: { rating?: number; tags?: string[]; description?: string | null }) => {
      const path = photo?.path;
      if (!path) return;
      const shown: PhotoMetadataOverride = {};
      const previous: PhotoMetadataOverride = {};
      if (patch.rating !== undefined) {
        shown.rating = patch.rating > 0 ? patch.rating : null;
        previous.rating = currentRating > 0 ? currentRating : null;
      }
      if (patch.tags !== undefined) {
        shown.tags = patch.tags;
        previous.tags = currentTags;
      }
      if (patch.description !== undefined) {
        shown.description = patch.description;
        previous.description = typeof meta?.description === "string" ? meta.description : null;
      }
      saveMetadata([{ path, patch, shown, previous }]);
    },
    [photo?.path, saveMetadata, currentRating, currentTags, meta?.description],
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

  // Who is in this video and when.
  const videoFaces =
    photo?.mediaType === "video" && peopleFacesPath === photo.path ? peopleFaces : [];
  const peopleInVideo = videoTimelineRows(videoFaces);
  const peopleTimelinePx =
    peopleInVideo.length > 0
      ? PEOPLE_TIMELINE_PADDING_PX +
        Math.min(peopleInVideo.length, PEOPLE_TIMELINE_MAX_ROWS) * PEOPLE_TIMELINE_ROW_PX
      : 0;
  const seekVideo = (ms: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = ms / 1000;
    // An autoplay refusal is fine: the seek itself still happened.
    playVideo(video);
  };

  const faceToggleDisabled =
    photo?.mediaType === "video" || (!hasFaceOverlayData && peopleFaces.length === 0);

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
                      onChange={(e) => chooseLevel(Number(e.target.value))}
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
                {photo.mediaType === "video" && transcriptSegments.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowTranscriptSearch((current) => !current)}
                    className={css.faceButton}
                    aria-label="Search captions"
                    aria-pressed={showTranscriptSearch}
                    title="Find where something is said"
                  >
                    <DocumentSearch24Regular />
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
                  // Feedback #136: this toggled the still/live view with no
                  // visual sign of which one was current -- the icon never
                  // changed, only the (invisible-until-hover) title/aria-label
                  // text did. Filled + an active background when live video
                  // is showing, matching the same on/off pattern the grid's
                  // own live badge already uses.
                  className={`${css.livePhotoButton} ${showLiveVideo ? css.livePhotoButtonActive : ""}`}
                  aria-pressed={showLiveVideo}
                  aria-label={showLiveVideo ? "Show photo" : "Play live photo"}
                  title={showLiveVideo ? "Show photo" : "Play live photo"}
                >
                  {showLiveVideo ? <Live24Filled /> : <Live24Regular />}
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
                        "--people-h": `${peopleTimelinePx}px`,
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
                      <track
                        key={transcriptTrackUrl ?? "none"}
                        kind="captions"
                        src={transcriptTrackUrl ?? "data:,"}
                        label={transcriptTrackUrl ? "Transcript" : "Captions not provided"}
                        default={Boolean(transcriptTrackUrl) && showCaptions}
                      />
                      Your browser does not support HTML video playback.
                    </video>
                    {showTranscriptSearch && transcriptSegments.length > 0 && (
                      <TranscriptSearch
                        segments={transcriptSegments}
                        onSeek={(seconds) => {
                          // Show the line that was searched for as it plays.
                          setShowCaptions(true);
                          seekVideo(seconds * 1000);
                        }}
                        onClose={() => setShowTranscriptSearch(false)}
                      />
                    )}
                    <VideoLoadingOverlay
                      state={playback}
                      lastDataAtRef={lastDataAtRef}
                      onRetry={retryPlayback}
                    />
                  </div>
                  {videoStatus && (
                    <span className={css.videoBadge} data-testid="video-status">
                      {videoStatus === "direct"
                        ? "Original"
                        : `Streaming${activeLevelHeight ? ` · ${activeLevelHeight}p` : ""}`}
                    </span>
                  )}
                  {peopleInVideo.length > 0 && (
                    <div
                      className={css.videoPeople}
                      style={{ maxHeight: `${peopleTimelinePx}px` }}
                    >
                      <VideoPeopleTimeline
                        faces={videoFaces}
                        durationMs={
                          photo.metadata?.duration
                            ? photo.metadata.duration * 1000
                            : undefined
                        }
                        onSeek={seekVideo}
                      />
                    </div>
                  )}
                </>
              ) : showLiveVideo && photo.livePhotoUrl ? (
                // Feedback #104: without a poster, the still image
                // disappears the instant this switches from the <img>
                // branch, leaving a blank frame until the live clip has
                // enough data to paint. previewUrl is the same image the
                // still branch was just showing, so this reads as a
                // continuous transition instead of a flash of nothing.
                <video
                  key={photo.livePhotoUrl}
                  src={photo.livePhotoUrl}
                  poster={photo.previewUrl}
                  autoPlay
                  loop
                  playsInline
                  muted
                  // Feedback #136: with no preload hint, some mobile browsers
                  // default to fetching only metadata and don't start
                  // downloading the actual clip until autoplay kicks in --
                  // this is a single clip the user explicitly asked to see
                  // (unlike the grid's ambient previews, which deliberately
                  // preload="none" to avoid fetching clips nobody asked for),
                  // so eagerly fetching it is the right tradeoff here.
                  preload="auto"
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
                  { }
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
                  { }
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
                      onRejectFace={READ_ONLY ? undefined : handleRejectFace}
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
                  {showFaces && (
                    <FaceOverlay
                      regionsRaw={photo.metadata?.regions}
                      faceTableBoxesRaw={photo.metadata?.faceTableBoxes}
                      aspectRatio={photoAspectRatio}
                      namedFaces={peopleFaces}
                      onAssignFace={READ_ONLY ? undefined : setActiveFaceAssign}
                      onRejectFace={READ_ONLY ? undefined : handleRejectFace}
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
                  {metadataSaveError && (
                    <span className={css.taggingError} role="alert">
                      {metadataSaveError}
                    </span>
                  )}
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
                    saveMetadata([
                      {
                        path: photo.path,
                        patch: { editAdj: isDirty(adj) ? JSON.stringify(adj) : null },
                        shown: {},
                        previous: {},
                      },
                    ]);
                  }
                }}
              />
            )}
            {!editMode && showFileInfo && (
              <FileInfoPanel
                photo={photo}
                aiDescription={aiDescription}
                onOpenFolder={openFolder}
                onSaveDescription={(next) =>
                  persistTagging({ description: next.length > 0 ? next : null })
                }
              />
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
