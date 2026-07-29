import {
  CheckmarkCircle24Filled,
  Circle24Regular,
  ClosedCaption24Regular,
  Filmstrip24Regular,
  Image24Regular,
  MusicNote224Regular,
  PlayCircle24Regular,
  Star12Filled,
} from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import type { PhotoItem, SearchSource } from "../api";
import { useNearViewport } from "../hooks/useNearViewport";
import { useSelectionContext } from "./selection/SelectionContext";
import css from "./ThumbnailTile.module.css";

const SOURCE_LABELS: Record<SearchSource, string> = {
  image: "Matched on image content",
  audio: "Matched on audio content",
  transcript: "Matched in transcript",
};

const SOURCE_ICONS: Record<SearchSource, React.ReactNode> = {
  image: <Image24Regular fontSize={14} />,
  audio: <MusicNote224Regular fontSize={14} />,
  transcript: <ClosedCaption24Regular fontSize={14} />,
};

const DEFAULT_RATIO = 1;
const clampRatio = (value: number): number => Math.min(Math.max(value, 0.25), 4);

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const getAspectRatio = (photo: PhotoItem): number => {
  const width = toFiniteNumber(photo.metadata?.dimensionWidth);
  const height = toFiniteNumber(photo.metadata?.dimensionHeight);

  if (width && height) {
    return clampRatio(width / height);
  }

  return DEFAULT_RATIO;
};

// Whether we have authoritative dimensions from metadata. When we do, the tile
// ratio is fixed up front and never re-derived from a decoded image, so the
// justified row never reflows as thumbnails progressively load.
const hasMetadataDimensions = (photo: PhotoItem): boolean => {
  const width = toFiniteNumber(photo.metadata?.dimensionWidth);
  const height = toFiniteNumber(photo.metadata?.dimensionHeight);
  return Boolean(width && height);
};

const isDisplayableImage = (photo: PhotoItem): boolean => {
  const mimeType = photo.metadata?.mimeType;
  if (!mimeType) {
    return true; // Assume displayable if no mime type info
  }
  return typeof mimeType === "string" && mimeType.toLowerCase().startsWith("image/");
};

const formatDuration = (totalSeconds: number): string => {
  const total = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
};

type Props = {
  photo: PhotoItem;
};

const LONG_PRESS_MS = 500;
// On touch devices there's no hover, so a video tile starts its low-quality
// preview after a short deliberate hold instead. Kept shorter than
// LONG_PRESS_MS so the preview appears before (and independent of) the
// existing long-press-to-select gesture.
const PREVIEW_DWELL_MS = 350;
const COARSE_POINTER_QUERY = "(pointer: coarse)";

export const ThumbnailTile: React.FC<Props> = (props) => {
  const { photo } = props;
  const searchSources = photo.searchSources;
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const previewDwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const isScrubbingRef = useRef(false);
  const [isNear, tileRef] = useNearViewport<HTMLButtonElement>();
  const [isHovered, setIsHovered] = useState(false);
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  const [isMicroLoaded, setIsMicroLoaded] = useState(false);
  // Whether to load the sharp 320 tile. The grid paints the cheap embedded micro
  // thumbnail instantly and only upgrades to the (full-decode, disk-heavy) 320
  // once the tile is dwelt on or hovered — so a fast scroll never triggers the
  // full-file reads across a large library.
  const [wantSharp, setWantSharp] = useState(false);
  const [loadedRatio, setLoadedRatio] = useState<number | null>(null);
  // Touch-and-hold substitute for hover, used to start/reveal the video
  // preview and duration overlay on coarse pointers (no mouseenter/leave).
  const [isPreviewDwelling, setIsPreviewDwelling] = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [isCoarsePointer] = useState(
    () => typeof window !== "undefined" && Boolean(window.matchMedia?.(COARSE_POINTER_QUERY).matches),
  );
  const { setSelected, selectionMode, checkedPaths, enterSelectionMode, toggleChecked } =
    useSelectionContext();
  const metadataRatio = getAspectRatio(photo);
  const knowsRatioFromMetadata = hasMetadataDimensions(photo);
  const ratio = loadedRatio ?? metadataRatio;
  const isChecked = checkedPaths.has(photo.path);
  const showCheckbox = selectionMode || isHovered;
  const ratingRaw = toFiniteNumber(photo.metadata?.rating);
  const ratingValue = ratingRaw && ratingRaw > 0 ? Math.min(5, Math.round(ratingRaw)) : 0;
  const isVideo = photo.mediaType === "video";
  const hasVideoPreview = isVideo && Boolean(photo.videoPreviewUrl);
  // Same hover/dwell signal drives both the inline preview playback and the
  // duration overlay reveal.
  const isPreviewTriggered = isCoarsePointer ? isPreviewDwelling : isHovered;
  // Gate on isNear too: a tile that has scrolled out of view must not keep
  // decoding/playing video, even if a stale hover/dwell state lingers (e.g.
  // the page scrolled under a stationary mouse without a mouseleave firing).
  const previewPlaying = isNear && hasVideoPreview && isPreviewTriggered;
  const durationSeconds = toFiniteNumber(photo.metadata?.duration);
  const durationLabel = isVideo && durationSeconds !== null ? formatDuration(durationSeconds) : null;

  // Reset per-photo load state when a virtualized tile is reused for a new photo.
  useEffect(() => {
    setIsImageLoaded(false);
    setIsMicroLoaded(false);
    setWantSharp(false);
    setLoadedRatio(null);
    setIsPreviewDwelling(false);
    setPreviewProgress(0);
    if (previewDwellTimerRef.current !== null) {
      clearTimeout(previewDwellTimerRef.current);
      previewDwellTimerRef.current = null;
    }
  }, [photo.thumbnailUrl]);

  // Hover immediately upgrades to the sharp tile.
  useEffect(() => {
    if (isHovered) setWantSharp(true);
  }, [isHovered]);

  // Aggressively stop the preview the moment it's no longer visible, even if
  // the dwell/hover state hasn't otherwise cleared (e.g. scrolled away mid-hold).
  useEffect(() => {
    if (!isNear && isPreviewDwelling) setIsPreviewDwelling(false);
  }, [isNear, isPreviewDwelling]);

  // Reset the scrub position once playback stops so the next play (a fresh
  // <video> element, starting at time 0) doesn't briefly show a stale fill.
  useEffect(() => {
    if (!previewPlaying) setPreviewProgress(0);
  }, [previewPlaying]);

  // Dwell upgrade: once the tile has stayed near the viewport briefly, load the
  // sharp tile so slow browsing fills in quality without a fast scroll doing so.
  useEffect(() => {
    if (!isNear || wantSharp) return;
    const timer = setTimeout(() => setWantSharp(true), 300);
    return () => clearTimeout(timer);
  }, [isNear, wantSharp]);

  const handleClick = () => {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    if (selectionMode) {
      toggleChecked(photo);
    } else {
      setSelected(photo);
    }
  };

  const handlePointerDown = () => {
    longPressTriggeredRef.current = false;
    if (isCoarsePointer && hasVideoPreview) {
      previewDwellTimerRef.current = setTimeout(() => {
        setIsPreviewDwelling(true);
      }, PREVIEW_DWELL_MS);
    }
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      if (!selectionMode) {
        enterSelectionMode();
      }
      toggleChecked(photo);
    }, LONG_PRESS_MS);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // Clears a still-pending dwell timer (hasn't started previewing yet).
  const cancelPendingPreviewDwell = () => {
    if (previewDwellTimerRef.current !== null) {
      clearTimeout(previewDwellTimerRef.current);
      previewDwellTimerRef.current = null;
    }
  };

  // Ends an already-active preview outright — used when the touch actually
  // lifts/cancels, i.e. the mobile equivalent of "mouse leaves".
  const stopPreviewDwell = () => {
    cancelPendingPreviewDwell();
    setIsPreviewDwelling(false);
  };

  const handlePointerUp = () => {
    cancelLongPress();
    stopPreviewDwell();
  };

  const handlePointerMove = () => {
    cancelLongPress();
    // Only cancel a not-yet-fired dwell timer here — small touch jitter while
    // an already-playing preview is being watched shouldn't kill it.
    cancelPendingPreviewDwell();
  };

  const handlePointerCancel = () => {
    cancelLongPress();
    stopPreviewDwell();
  };

  const handlePreviewTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (isScrubbingRef.current) return;
    const video = e.currentTarget;
    const dur = video.duration || durationSeconds || 0;
    if (dur > 0 && Number.isFinite(video.currentTime)) {
      setPreviewProgress(Math.min(1, Math.max(0, video.currentTime / dur)));
    }
  };

  const seekFromClientX = (clientX: number, bar: HTMLElement) => {
    const video = previewVideoRef.current;
    if (!video) return;
    const rect = bar.getBoundingClientRect();
    const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    const dur = video.duration || durationSeconds || 0;
    if (dur > 0) {
      video.currentTime = ratio * dur;
    }
    setPreviewProgress(ratio);
  };

  const handleScrubPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    isScrubbingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX, e.currentTarget);
  };

  const handleScrubPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (!isScrubbingRef.current) return;
    seekFromClientX(e.clientX, e.currentTarget);
  };

  const handleScrubPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    isScrubbingRef.current = false;
  };

  const handleScrubClick = (e: React.MouseEvent) => {
    // Prevent the tile's own onClick (open fullscreen) from firing when the
    // user is just seeking the inline preview.
    e.stopPropagation();
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!selectionMode) {
      enterSelectionMode();
    }
    toggleChecked(photo);
  };

  const updateRatioFromImg = (img: HTMLImageElement) => {
    // Metadata dimensions describe the full image and are authoritative, so keep
    // the tile locked to them. Only fall back to measuring the decoded image when
    // metadata is missing, and lock that first measurement so the progressive
    // micro → sharp swap can't reflow the row a second time.
    if (knowsRatioFromMetadata || loadedRatio !== null) return;
    if (img.naturalWidth && img.naturalHeight) {
      setLoadedRatio(clampRatio(img.naturalWidth / img.naturalHeight));
    }
  };

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setIsImageLoaded(true);
    updateRatioFromImg(e.currentTarget);
  };

  const handleMicroLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setIsMicroLoaded(true);
    updateRatioFromImg(e.currentTarget);
  };

  const loading = isNear ? "eager" : "lazy";
  const fetchPriority = isNear ? "high" : "low";
  const thumbnailUrl = isNear ? photo.thumbnailUrl : undefined;
  const isImage = isDisplayableImage(photo);
  // Progressive photo tiles: paint the embedded micro thumbnail instantly, then
  // upgrade to the sharp 320 on dwell/hover. Photos without a micro URL (and the
  // video branch) fall back to loading the 320 directly when near.
  const microUrl = isNear ? photo.microThumbnailUrl : undefined;
  const hasMicro = Boolean(photo.microThumbnailUrl);
  const sharpUrl = isNear && (!hasMicro || wantSharp) ? photo.thumbnailUrl : undefined;

  return (
    <button
      type="button"
      ref={tileRef as React.RefObject<HTMLButtonElement>}
      className={`${css.tile}${isChecked ? ` ${css.tileSelected}` : ""}`}
      style={{ "--ratio": ratio.toString() } as React.CSSProperties}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerMove={handlePointerMove}
      onPointerCancel={handlePointerCancel}
      aria-label={photo.name}
      aria-pressed={selectionMode ? isChecked : undefined}
    >
      {showCheckbox && (
        <span
          className={css.checkboxOverlay}
          onClick={handleCheckboxClick}
          aria-hidden="true"
        >
          {isChecked ? (
            <CheckmarkCircle24Filled className={css.checkboxChecked} />
          ) : (
            <Circle24Regular className={css.checkboxUnchecked} />
          )}
        </span>
      )}
      {isChecked && <span className={css.checkedOverlay} aria-hidden="true" />}
      {photo.livePhotoUrl ? (
        <span className={css.livePhotoBadge} aria-label="Live photo" title="Live photo">
          <Filmstrip24Regular fontSize={14} />
        </span>
      ) : null}
      {searchSources && searchSources.length > 0 ? (
        <span
          className={css.sourceBadges}
          aria-label={`Matched by: ${searchSources.map((s) => SOURCE_LABELS[s]).join(", ")}`}
        >
          {searchSources.map((source) => (
            <span key={source} className={css.sourceBadge} title={SOURCE_LABELS[source]}>
              {SOURCE_ICONS[source]}
            </span>
          ))}
        </span>
      ) : null}
      {ratingValue > 0 ? (
        <span
          className={css.ratingBadge}
          aria-label={`Rated ${ratingValue} of 5`}
          title={`Rated ${ratingValue} of 5`}
        >
          <Star12Filled fontSize={12} />
          {ratingValue}
        </span>
      ) : null}
      {photo.mediaType === "video" ? (
        <>
          <span className={css.videoBadge} aria-hidden="true">
            <PlayCircle24Regular fontSize={24} />
          </span>
          {durationLabel ? (
            <span
              className={css.durationBadge}
              style={{ opacity: isPreviewTriggered ? 1 : 0 }}
              aria-hidden="true"
            >
              {durationLabel}
            </span>
          ) : null}
          <img
            src={thumbnailUrl}
            alt={photo.name}
            loading={loading}
            fetchPriority={fetchPriority}
            className={css.image}
            style={{
              opacity: isImageLoaded ? 1 : 0,
              transition: "opacity 200ms ease-in",
            }}
            onLoad={handleImageLoad}
          />
          {previewPlaying && (
            <>
              <video
                ref={previewVideoRef}
                src={photo.videoPreviewUrl}
                className={css.image}
                style={{ position: "absolute", top: 0, left: 0 }}
                muted
                loop
                playsInline
                autoPlay
                onTimeUpdate={handlePreviewTimeUpdate}
              />
              <div
                className={css.scrubBar}
                onClick={handleScrubClick}
                onPointerDown={handleScrubPointerDown}
                onPointerMove={handleScrubPointerMove}
                onPointerUp={handleScrubPointerUp}
                onPointerCancel={handleScrubPointerUp}
                aria-hidden="true"
              >
                <div className={css.scrubTrack}>
                  <div
                    className={css.scrubFill}
                    style={{ width: `${previewProgress * 100}%` }}
                  />
                </div>
              </div>
            </>
          )}
        </>
      ) : isImage ? (
        <>
          {hasMicro && (
            <img
              src={microUrl}
              alt={photo.name}
              loading={loading}
              fetchPriority={fetchPriority}
              className={css.image}
              style={{ opacity: isMicroLoaded ? 1 : 0, transition: "opacity 200ms ease-in" }}
              onLoad={handleMicroLoad}
            />
          )}
          <img
            src={sharpUrl}
            alt={photo.name}
            loading={loading}
            fetchPriority={hasMicro ? "low" : fetchPriority}
            className={css.image}
            style={{
              opacity: isImageLoaded ? 1 : 0,
              transition: "opacity 200ms ease-in",
              // When layered over the micro base, cover it; otherwise flow normally.
              ...(hasMicro ? { position: "absolute", inset: 0 } : {}),
            }}
            onLoad={handleImageLoad}
          />
        </>
      ) : (
        <div className={css.unknownFile}>
          <span className={css.unknownFileName}>{photo.name}</span>
        </div>
      )}
    </button>
  );
};
