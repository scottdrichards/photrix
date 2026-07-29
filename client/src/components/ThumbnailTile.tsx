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
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { PhotoItem, SearchSource } from "../api";
import { useNearViewport } from "../hooks/useNearViewport";
import { isHoverSuppressedByScroll } from "./ThumbnailTile.hoverIntent";
import { useSelectionContext } from "./selection/SelectionContext";
import { type EditAdj, computeStyle, isDirty, EditSvgDefs } from "./PhotoEditor";
import { formatDuration } from "./tileMedia/formatDuration";
import { requestLiveOpen } from "./tileMedia/liveOpenIntent";
import { useLivePhotoPreview } from "./tileMedia/useLivePhotoPreview";
import { useTileVideoPreview } from "./tileMedia/useTileVideoPreview";
import {
  useCoarsePointer,
  useDelayedFlag,
  useViewportCentred,
} from "./tileMedia/useTileDwell";
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

type Props = {
  photo: PhotoItem;
};

const LONG_PRESS_MS = 500;

/** How long a tile must sit in the close band before it earns the sharp 320. */
const SHARP_DWELL_MS = 250;
/**
 * A load that resolves faster than this gets no fade. Cross-fading a thumbnail
 * that was already in the browser cache doesn't smooth anything — it just puts
 * 200ms of translucency between the user and a picture that was ready
 * instantly, which is what "the fade makes it feel slow" is describing.
 */
const INSTANT_LOAD_MS = 120;
const FADE_MS = 200;

const nowMs = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

type ImageFade = {
  ref: React.RefObject<HTMLImageElement | null>;
  onLoad: (event: React.SyntheticEvent<HTMLImageElement>) => void;
  style: React.CSSProperties;
};

/**
 * Reveal state for one thumbnail <img>.
 *
 * Beyond "has it loaded", this handles two things the plain onLoad flag got
 * wrong. An image already in the browser cache can finish before React attaches
 * its onLoad listener, which left the tile stuck at opacity 0 — a permanently
 * blank tile; the effect below re-checks `complete` whenever the src changes.
 * And an image that arrives instantly is shown instantly, with the fade
 * reserved for loads slow enough that a pop-in would be jarring.
 */
const useImageFade = (
  src: string | undefined,
  onDecoded: (img: HTMLImageElement) => void,
): ImageFade => {
  const [status, setStatus] = useState<"pending" | "instant" | "faded">("pending");
  const ref = useRef<HTMLImageElement | null>(null);
  const requestedAtRef = useRef<number | null>(null);
  const onDecodedRef = useRef(onDecoded);
  onDecodedRef.current = onDecoded;

  useEffect(() => {
    requestedAtRef.current = src ? nowMs() : null;
    const img = ref.current;
    if (src && img?.complete && img.naturalWidth > 0) {
      // Served from cache before React could hear about it.
      onDecodedRef.current(img);
      setStatus("instant");
      return;
    }
    setStatus("pending");
  }, [src]);

  const onLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const startedAt = requestedAtRef.current;
    onDecodedRef.current(event.currentTarget);
    setStatus(
      startedAt === null || nowMs() - startedAt < INSTANT_LOAD_MS ? "instant" : "faded",
    );
  }, []);

  return {
    ref,
    onLoad,
    style: {
      opacity: status === "pending" ? 0 : 1,
      // `none` rather than a 0ms duration so the instant path never creates a
      // compositor layer at all. A screenful of tiles revealing at once is the
      // moment we can least afford one throwaway layer per image.
      transition: status === "faded" ? `opacity ${FADE_MS}ms ease-in` : "none",
    },
  };
};

// Hover has to be held briefly before anything starts, so sweeping the pointer
// across a row never opens a stream. A full second (rather than a snappier
// value) specifically keeps a fast sweep across a row of video tiles from
// queuing up a negotiation — and, on GPU-available links, a live transcode —
// per tile it merely passed over. Touch has no hover, so the substitute is a
// longer dwell in the centre band of the viewport (see useViewportCentred).
const HOVER_DWELL_MS = 1000;
const TOUCH_DWELL_MS = 900;

export const ThumbnailTile: React.FC<Props> = (props) => {
  const { photo } = props;
  const searchSources = photo.searchSources;
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  // Scrub-seeking state for the inline video preview (see the scrub bar below).
  // A ref rather than state for "is the user dragging": it's read inside the
  // preview's onTimeUpdate handler purely to suppress a progress-bar fight
  // between playback and an in-progress drag, and doesn't need a re-render.
  const isScrubbingRef = useRef(false);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [isNear, tileRef, isClose] = useNearViewport<HTMLButtonElement>();
  const [isHovered, setIsHovered] = useState(false);
  // Whether to load the sharp 320 tile. The grid paints the cheap embedded micro
  // thumbnail across the wide prefetch band and only upgrades to the
  // (full-decode, disk-heavy) 320 once the tile settles in the close band or is
  // deliberately hovered — so a fast scroll never triggers the full-file reads
  // across a large library.
  const [wantSharp, setWantSharp] = useState(false);
  const [loadedRatio, setLoadedRatio] = useState<number | null>(null);
  // Once a tile has been prepared it keeps its <img> src for good. Clearing the
  // src when a tile left the band — what this used to do — makes the browser
  // drop the image *and its decoded bitmap*, so every scroll reversal re-fetched
  // and re-decoded a whole screenful at once. That burst is the reported "the
  // browser hangs as it loads a bunch of images at once".
  const hasBeenNearRef = useRef(false);
  useEffect(() => {
    if (isNear) hasBeenNearRef.current = true;
  }, [isNear]);
  const shouldLoad = isNear || hasBeenNearRef.current;
  const { setSelected, selectionMode, checkedPaths, enterSelectionMode, toggleChecked } =
    useSelectionContext();
  const metadataRatio = getAspectRatio(photo);
  const knowsRatioFromMetadata = hasMetadataDimensions(photo);
  const ratio = loadedRatio ?? metadataRatio;
  const isChecked = checkedPaths.has(photo.path);
  const showCheckbox = selectionMode || isHovered;
  const ratingRaw = toFiniteNumber(photo.metadata?.rating);
  const ratingValue = ratingRaw && ratingRaw > 0 ? Math.min(5, Math.round(ratingRaw)) : 0;

  const rawEditAdj = photo.metadata?.editAdj;
  const editAdj: EditAdj | null = (() => {
    if (!rawEditAdj || typeof rawEditAdj !== "string") return null;
    try { const a = JSON.parse(rawEditAdj) as EditAdj; return isDirty(a) ? a : null; }
    catch { return null; }
  })();
  const rawTileId = useId();
  const tileFilterId = `pth-${rawTileId.replace(/:/g, "")}`;
  const tileEditStyle = editAdj ? computeStyle(editAdj, tileFilterId) : null;

  const isVideo = photo.mediaType === "video";
  const isCoarsePointer = useCoarsePointer();
  const [isLiveBadgeHovered, setIsLiveBadgeHovered] = useState(false);

  // Two ways to say "the user is looking at this tile": a held hover on desktop,
  // or a settled dwell in the middle of the screen on touch. Both feed the same
  // downstream behaviour (preview playback + the info overlay).
  const hoverDwell = useDelayedFlag(isHovered && !isCoarsePointer, HOVER_DWELL_MS);
  const touchDwell = useViewportCentred(tileRef, {
    delayMs: TOUCH_DWELL_MS,
    enabled: isCoarsePointer && isClose,
  });
  const isDwelt = isCoarsePointer ? touchDwell : hoverDwell;

  // Motion is gated on the *close* band, not the wide prefetch one: prefetching
  // reaches over a viewport ahead, and nothing that far off screen should be
  // holding a video slot or feeding the ambient live-photo rotation.
  const {
    videoRef,
    isPlaying: isPreviewPlaying,
    isLeaving: isPreviewLeaving,
  } = useTileVideoPreview({
    photo,
    // isClose is part of the condition, not just an optimisation: a tile that
    // scrolls out of range must stop playing even if the pointer never moved.
    active: isDwelt && isClose,
    deliberate: !isCoarsePointer,
  });

  const livePhoto = useLivePhotoPreview({
    livePhotoUrl: photo.livePhotoUrl,
    isNear: isClose,
    // On touch there is no hover, so the live badge is a plain indicator and the
    // idle rotation is the only thing that animates it.
    hovered: isLiveBadgeHovered && !isCoarsePointer,
  });

  const durationLabel = isVideo ? formatDuration(photo.metadata?.duration) : null;
  const durationSeconds = toFiniteNumber(photo.metadata?.duration);

  // Reset per-photo load state when a virtualized tile is reused for a new photo.
  useEffect(() => {
    setWantSharp(false);
    setLoadedRatio(null);
  }, [photo.thumbnailUrl]);

  // Hover immediately upgrades to the sharp tile. Hover is intent-gated (see
  // handleMouseEnter), so scrolling a wheel over the grid no longer drags a
  // full-resolution fetch behind the cursor.
  useEffect(() => {
    if (isHovered) setWantSharp(true);
  }, [isHovered]);

  // Dwell upgrade: once the tile has settled in the close band, load the sharp
  // tile so slow browsing fills in quality. A fling never lingers here long
  // enough, so flinging past a thousand tiles costs micro thumbnails only.
  useEffect(() => {
    if (!isClose || wantSharp) return;
    const timer = setTimeout(() => setWantSharp(true), SHARP_DWELL_MS);
    return () => clearTimeout(timer);
  }, [isClose, wantSharp]);

  // Reset the scrub position once playback stops so the next play (a fresh
  // <video> element, starting at time 0) doesn't briefly show a stale fill.
  useEffect(() => {
    if (!isPreviewPlaying) setPreviewProgress(0);
  }, [isPreviewPlaying]);

  const handlePreviewTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (isScrubbingRef.current) return;
    const video = e.currentTarget;
    const dur = video.duration || durationSeconds || 0;
    if (dur > 0 && Number.isFinite(video.currentTime)) {
      setPreviewProgress(Math.min(1, Math.max(0, video.currentTime / dur)));
    }
  };

  const seekFromClientX = (clientX: number, bar: HTMLElement) => {
    const video = videoRef.current;
    if (!video) return;
    const rect = bar.getBoundingClientRect();
    const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    const dur = video.duration || durationSeconds || 0;
    if (dur > 0) video.currentTime = ratio * dur;
    setPreviewProgress(ratio);
  };

  // Every handler stops propagation: the scrub bar sits inside the tile
  // <button>, and without this a drag would also toggle selection or open the
  // fullscreen viewer via the tile's own click/pointer handlers.
  const handleScrubPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    isScrubbingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture is unavailable in some environments (e.g. jsdom)
    }
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
    e.stopPropagation();
  };

  const handleClick = () => {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    if (selectionMode) {
      toggleChecked(photo);
      return;
    }
    // Clicking while the badge is showing its clip means "open the motion, not
    // the still". The badge itself stays a non-interactive indicator so it can
    // never intercept a tap on touch, where there is no hover to trigger this.
    if (isLiveBadgeHovered && photo.livePhotoUrl) {
      requestLiveOpen(photo.path);
    }
    setSelected(photo);
  };

  const handlePointerDown = () => {
    longPressTriggeredRef.current = false;
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

  const handlePointerUp = () => {
    cancelLongPress();
  };

  const handlePointerMove = () => {
    cancelLongPress();
  };

  // Ignore a mouseenter the page scrolling under a parked cursor produced. See
  // ThumbnailTile.hoverIntent — on Windows a wheel scroll otherwise drags a
  // re-render, an overlay mount, a hover repaint and a full-resolution fetch
  // across every tile it passes.
  const handleMouseEnter = () => {
    if (isHoverSuppressedByScroll()) return;
    setIsHovered(true);
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!selectionMode) {
      enterSelectionMode();
    }
    toggleChecked(photo);
  };

  const updateRatioFromImg = useCallback(
    (img: HTMLImageElement) => {
      // Metadata dimensions describe the full image and are authoritative, so
      // keep the tile locked to them. Only fall back to measuring the decoded
      // image when metadata is missing, and lock that first measurement so the
      // progressive micro → sharp swap can't reflow the row a second time.
      if (knowsRatioFromMetadata || loadedRatio !== null) return;
      if (img.naturalWidth && img.naturalHeight) {
        setLoadedRatio(clampRatio(img.naturalWidth / img.naturalHeight));
      }
    },
    [knowsRatioFromMetadata, loadedRatio],
  );

  const loading = shouldLoad ? "eager" : "lazy";
  const fetchPriority = isClose ? "high" : "low";
  const isImage = isDisplayableImage(photo);
  const hasMicro = Boolean(photo.microThumbnailUrl);
  // Progressive photo tiles: paint the embedded micro thumbnail across the wide
  // prefetch band, then upgrade to the sharp 320 on dwell/hover. Photos without
  // a micro URL (and the video branch) load the 320 directly instead. Both URLs
  // are latched — see hasBeenNearRef — so leaving the band never unloads an
  // image the user is about to scroll back to.
  const thumbnailUrl = shouldLoad ? photo.thumbnailUrl : undefined;
  const microUrl = shouldLoad ? photo.microThumbnailUrl : undefined;
  const sharpUrl = shouldLoad && (!hasMicro || wantSharp) ? photo.thumbnailUrl : undefined;

  const videoFade = useImageFade(thumbnailUrl, updateRatioFromImg);
  const microFade = useImageFade(microUrl, updateRatioFromImg);
  const sharpFade = useImageFade(sharpUrl, updateRatioFromImg);

  return (
    <button
      type="button"
      ref={tileRef as React.RefObject<HTMLButtonElement>}
      className={`${css.tile}${isChecked ? ` ${css.tileSelected}` : ""}`}
      style={{ "--ratio": ratio.toString() } as React.CSSProperties}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setIsHovered(false)}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerMove={handlePointerMove}
      onPointerCancel={cancelLongPress}
      aria-label={photo.name}
      aria-pressed={selectionMode ? isChecked : undefined}
    >
      {editAdj && <EditSvgDefs adj={editAdj} filterId={tileFilterId} />}
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
        <span
          className={`${css.livePhotoBadge}${livePhoto.isVisible ? ` ${css.livePhotoBadgeActive}` : ""}`}
          aria-label="Live photo"
          title="Live photo"
          onMouseEnter={() => setIsLiveBadgeHovered(true)}
          onMouseLeave={() => setIsLiveBadgeHovered(false)}
        >
          <Filmstrip24Regular fontSize={14} />
        </span>
      ) : null}
      {livePhoto.isMounted && photo.livePhotoUrl ? (
        <video
          ref={livePhoto.videoRef}
          src={photo.livePhotoUrl}
          className={`${css.motionLayer}${livePhoto.isVisible ? ` ${css.motionLayerVisible}` : ""}`}
          muted
          playsInline
          autoPlay
          preload="none"
          onEnded={livePhoto.handleEnded}
          aria-hidden="true"
        />
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
      {/* Bottom-right meta strip. Everything in it is pointer-events: none so a
          dwell overlay can never swallow the tap that opens the photo. */}
      {ratingValue > 0 || durationLabel ? (
        <span className={css.metaRow}>
          {durationLabel ? (
            <span
              className={`${css.durationBadge}${isDwelt ? ` ${css.metaVisible}` : ""}`}
              aria-label={`Duration ${durationLabel}`}
            >
              {durationLabel}
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
        </span>
      ) : null}
      {isVideo ? (
        <>
          <span
            className={`${css.videoBadge}${isPreviewPlaying || isPreviewLeaving ? ` ${css.videoBadgeDimmed}` : ""}`}
            aria-hidden="true"
          >
            <PlayCircle24Regular fontSize={24} />
          </span>
          <img
            ref={videoFade.ref}
            src={thumbnailUrl}
            alt={photo.name}
            loading={loading}
            fetchPriority={fetchPriority}
            className={css.image}
            style={videoFade.style}
            onLoad={videoFade.onLoad}
          />
          {(isDwelt || isPreviewPlaying || isPreviewLeaving) && isNear && (
            // Mounted for the whole dwell, and for the coast-to-a-stop-then-fade
            // tail after the hover ends, so the hook always has an element to
            // attach to and the frozen last frame has something to fade out of.
            // isPreviewPlaying is what bridges the one render where isDwelt has
            // already gone false but the hook's cleanup (which flips isLeaving
            // true) hasn't run yet — without it the element would unmount for a
            // frame and the coast-down would have nothing left to animate.
            // It stays transparent until playback actually starts, and the
            // thumbnail underneath is what shows if it never does.
            <video
              ref={videoRef}
              className={`${css.motionLayer}${isPreviewPlaying || isPreviewLeaving ? ` ${css.motionLayerVisible}` : ""}`}
              muted
              loop={false}
              playsInline
              preload="none"
              aria-hidden="true"
              onTimeUpdate={handlePreviewTimeUpdate}
            />
          )}
          {isPreviewPlaying && (
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
                <div className={css.scrubFill} style={{ width: `${previewProgress * 100}%` }} />
              </div>
            </div>
          )}
        </>
      ) : isImage ? (
        <>
          {hasMicro && (
            <img
              ref={microFade.ref}
              src={microUrl}
              alt={photo.name}
              loading={loading}
              fetchPriority={fetchPriority}
              className={css.image}
              style={{
                ...microFade.style,
                ...(tileEditStyle?.filter ? { filter: tileEditStyle.filter } : {}),
                ...(tileEditStyle?.transform ? { transform: tileEditStyle.transform } : {}),
                ...(tileEditStyle?.clipPath ? { clipPath: tileEditStyle.clipPath } : {}),
              }}
              onLoad={microFade.onLoad}
            />
          )}
          <img
            ref={sharpFade.ref}
            src={sharpUrl}
            alt={photo.name}
            loading={loading}
            fetchPriority={hasMicro ? "low" : fetchPriority}
            className={css.image}
            style={{
              ...sharpFade.style,
              // When layered over the micro base, cover it; otherwise flow normally.
              ...(hasMicro ? { position: "absolute", inset: 0 } : {}),
              ...(tileEditStyle?.filter ? { filter: tileEditStyle.filter } : {}),
              ...(tileEditStyle?.transform ? { transform: tileEditStyle.transform } : {}),
              ...(tileEditStyle?.clipPath ? { clipPath: tileEditStyle.clipPath } : {}),
            }}
            onLoad={sharpFade.onLoad}
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
