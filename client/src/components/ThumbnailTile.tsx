import {
  CheckmarkCircle24Filled,
  Circle24Regular,
  ClosedCaption24Regular,
  Image24Regular,
  ImageStackRegular,
  Live24Regular,
  MoreHorizontalRegular,
  MusicNote224Regular,
  PlayCircle24Regular,
  Star12Filled,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { buildMomentClusterPreviewUrl, type PhotoItem, type SearchSource } from "../api";
import { useNearViewport } from "../hooks/useNearViewport";
import { isHoverSuppressedByScroll } from "./ThumbnailTile.hoverIntent";
import { useSelectionContext } from "./selection/SelectionContext";
import { type EditAdj, computeStyle, isDirty, EditSvgDefs } from "./PhotoEditor";
import { formatDuration } from "./tileMedia/formatDuration";
import { requestLiveOpen } from "./tileMedia/liveOpenIntent";
import { useGatedThumbnailUrl } from "./tileMedia/useGatedThumbnailUrl";
import { useLivePhotoPreview } from "./tileMedia/useLivePhotoPreview";
import { useTileVideoPreview } from "./tileMedia/useTileVideoPreview";
import { useTileScrubPreview } from "./tileMedia/useTileScrubPreview";
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
  /**
   * Member count of this photo's moment (burst/near-duplicate) cluster; > 1
   * means this tile is a collapsed representative and should render the
   * stack badge. Omit or pass <= 1 for an ordinary tile with no cluster.
   * Mutually exclusive with `restackCount` — a tile is either the collapsed
   * stand-in for a stack, or one of that stack's members shown inline.
   */
  stackCount?: number;
  /**
   * Member count of this photo's cluster when this tile is one of that
   * cluster's members currently shown inline-unstacked (see
   * ThumbnailGrid's `openStackClusterIds`). Renders a "restack" badge — same
   * icon/style as the stack badge, no count shown — instead of the stack
   * badge. Mutually exclusive with `stackCount`.
   */
  restackCount?: number;
  /**
   * Toggles this tile's cluster between collapsed and inline-unstacked.
   * Used by both the stack badge (stackCount case: opens it) and the restack
   * badge (restackCount case: closes it) — the caller (ThumbnailGrid) owns
   * which state is current and what this does in each case.
   */
  onToggleStack?: () => void;
  /**
   * Opens the stack management modal (permanently unstack / pick a different
   * representative). Present whenever `stackCount` or `restackCount` is, so
   * those two actions stay reachable regardless of whether the cluster is
   * currently shown collapsed or inline-unstacked.
   */
  onOpenStackActions?: () => void;
  /**
   * Extra class appended to the root tile element, on top of the tile's own
   * state classes (selected). Currently only used by ThumbnailGrid to frame
   * an inline-unstacked cluster's members with a shared border — a pure
   * layout/style tweak, not a new concept this component needs to know
   * about.
   */
  className?: string;
  /**
   * CSS `view-transition-name` for this tile — lets the browser's View
   * Transitions API match this element across a stack toggle (the
   * representative tile becomes one of the unstacked members, or vice
   * versa) and animate it into its new position/size instead of a hard cut.
   * Only meaningful when the caller is also wrapping the state update that
   * changes what's rendered in `document.startViewTransition` (see
   * ThumbnailGrid's `runWithViewTransition`) — setting this alone does
   * nothing on its own.
   */
  viewTransitionName?: string;
  /**
   * Feedback #112: the per-source "why this matched" icons (image/audio/
   * transcript) are debug-oriented clutter for ordinary browsing — shown
   * only when the caller (ThumbnailGrid's "Why?" toggle next to the result
   * count) has explicitly turned match-reason display on. Defaults to
   * false so every other caller (which never passes this) keeps the icons
   * hidden with no change needed on their end.
   */
  showMatchReasons?: boolean;
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
  const {
    photo,
    stackCount,
    restackCount,
    onToggleStack,
    onOpenStackActions,
    className,
    viewTransitionName,
    showMatchReasons = false,
  } = props;
  const isStack = (stackCount ?? 0) > 1;
  const isRestackable = restackCount !== undefined;
  // Real thumbnails of a couple of the cluster's other members, so a
  // collapsed stack tile reads as an actual stack of photos rather than an
  // abstract count badge. Only meaningful (and only sent by the server)
  // alongside stackCount, never restackCount — an unstacked member is just
  // an ordinary photo, not itself a stack.
  const stackPreviewPaths = isStack ? (photo.metadata?.momentClusterPreviewPaths ?? []) : [];
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

  // Feedback #76: hover-scrub through a handful of cached still frames,
  // driven by pointer X position. Only while dwelling on a video tile with a
  // real mouse (coarse/touch pointers have no meaningful "position along the
  // strip" gesture) and before the ambient video preview has taken over —
  // once that's playing, scrubbing would fight it for the same pixels.
  const { scrubUrl } = useTileScrubPreview({
    photo,
    active: isVideo && isDwelt && isClose && !isCoarsePointer && !isPreviewPlaying,
    tileElement: tileRef.current,
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
  //
  // Gated on isVideo for the same reason sharpUrl is gated on !isVideo: the only
  // <img> that consumes this URL (and calls its release()) is the one in the
  // video branch below. Without the guard every *photo* tile also opened a
  // gatedVideoThumbnail slot for a URL it never rendered, so no load/error event
  // could ever free it — six photo tiles were enough to pin sharpThumbnailQueue
  // at capacity for good. After that nothing downstream was ever admitted, so
  // video tiles never even issued a thumbnail request (the reported "it doesn't
  // even request a thumbnail"); photos hid it because their micro thumbnail is
  // ungated and still painted.
  const videoThumbnailUrl = isVideo && shouldLoad ? photo.thumbnailUrl : undefined;
  const microUrl = shouldLoad ? photo.microThumbnailUrl : undefined;
  // Gated on `!isVideo && isImage`, not just hasMicro/wantSharp: the <img> that
  // would ever consume gatedSharpUrl (and call its release()) only renders in
  // the isImage JSX branch below. Videos never set a micro thumbnail, so
  // without this guard sharpUrl resolved to the same URL as the video's own
  // thumbnailUrl for every video tile — silently opening a *second*,
  // independent queue slot (via gatedSharpUrl below) that nothing ever
  // released, since the video branch only wires release() to its own
  // gatedVideoThumbnail. Three video tiles were enough to permanently pin
  // sharpThumbnailQueue at its 6-slot capacity, starving every thumbnail
  // (video or photo) requested after — the reported "video thumbnails aren't
  // showing".
  const sharpUrl =
    !isVideo && isImage && shouldLoad && (!hasMicro || wantSharp)
      ? photo.thumbnailUrl
      : undefined;

  // Both the video thumbnail and the photo "sharp" 320 are full decode-heavy
  // fetches, and neither is otherwise rate-limited: the video one fires as
  // soon as a tile enters the wide prefetch band, and the photo one is only
  // dwell-gated *per tile* — a screenful of tiles clearing that dwell at once
  // (a scroll that pauses, or one that simply isn't a fling) still asks for
  // every one of them in the same tick. Routing both through the shared queue
  // (see sharpThumbnailQueue) turns that burst into a steady trickle instead
  // of the reported "hangs like it's loading a bunch of images at once".
  const gatedVideoThumbnail = useGatedThumbnailUrl(videoThumbnailUrl);
  const gatedSharpUrl = useGatedThumbnailUrl(sharpUrl);

  // The slot release has to live in onDecoded, not the JSX onLoad handler:
  // useImageFade's own mount effect resolves an already-cached image (see its
  // "Served from cache before React could hear about it" branch below) by
  // calling onDecoded directly, without ever firing a `load` event for a JSX
  // onLoad handler to catch. Wiring release() only to onLoad left every
  // cache-resolved thumbnail's queue slot permanently held — six of those
  // (MAX_CONCURRENT_LOADS) and the shared queue wedges for every tile after,
  // which is disproportionately visible on video tiles since they have no
  // micro-thumbnail fallback to fall back on while starved.
  const videoFade = useImageFade(gatedVideoThumbnail.admittedUrl, (img) => {
    updateRatioFromImg(img);
    gatedVideoThumbnail.release();
  });
  const microFade = useImageFade(microUrl, updateRatioFromImg);
  const sharpFade = useImageFade(gatedSharpUrl.admittedUrl, (img) => {
    updateRatioFromImg(img);
    gatedSharpUrl.release();
  });

  return (
    <button
      type="button"
      ref={tileRef as React.RefObject<HTMLButtonElement>}
      className={`${css.tile}${isChecked ? ` ${css.tileSelected}` : ""}${className ? ` ${className}` : ""}`}
      style={
        {
          "--ratio": ratio.toString(),
          ...(viewTransitionName ? { viewTransitionName } : {}),
        } as React.CSSProperties
      }
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
      {stackPreviewPaths.length > 0 ? (
        // Purely decorative (the badge already carries the accessible
        // "N photos" label) — a couple of the cluster's other members
        // peeking out from a corner, fanned/rotated, so the collapsed tile
        // reads as a physical stack of photos. Rendered before (i.e. below,
        // in default paint order) the main image content, then lifted above
        // it with z-index — see .stackPreviewPeek's comment for why that's
        // necessary rather than actually layering behind.
        <span className={css.stackPreviewPeeks} aria-hidden="true">
          {stackPreviewPaths.slice(0, 2).map((path, index) => (
            <img
              key={path}
              src={buildMomentClusterPreviewUrl(path)}
              alt=""
              loading="lazy"
              className={css.stackPreviewPeek}
              style={
                {
                  "--peek-index": index,
                } as React.CSSProperties
              }
            />
          ))}
        </span>
      ) : null}
      {isStack ? (
        // Primary expand action, bottom-right — clicking the stack itself
        // (where the peeking preview photos are) opens it, rather than a
        // small top-right icon (see feedback #81). Always rendered when this
        // tile is a stack, even without preview-peek images to sit over, so
        // the click/keyboard target exists unconditionally. The count is
        // only shown once it's actually informative — two peeking photos
        // already reads as "a stack" on its own.
        <span
          className={css.stackExpandControl}
          role="button"
          tabIndex={0}
          aria-label={`${stackCount} photos of this moment — show separately`}
          title={`${stackCount} photos of this moment — click to show separately`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStack?.();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            e.stopPropagation();
            onToggleStack?.();
          }}
        >
          <ImageStackRegular fontSize={14} />
          {stackCount && stackCount > 2 ? stackCount : null}
        </span>
      ) : null}
      {isStack || isRestackable ? (
        <span className={css.stackControls}>
          {isRestackable ? (
            // Collapsing a stack keeps its previous top-right icon-only
            // affordance ("as before" — feedback #81 only asked to move the
            // *expand* trigger, not this one).
            <span
              className={css.stackBadge}
              role="button"
              tabIndex={0}
              aria-label={`Restack these ${restackCount} photos`}
              title="Restack these photos back into one tile"
              onClick={(e) => {
                e.stopPropagation();
                onToggleStack?.();
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                e.stopPropagation();
                onToggleStack?.();
              }}
            >
              <ImageStackRegular fontSize={14} />
            </span>
          ) : null}
          <span
            className={css.stackActionsBadge}
            role="button"
            tabIndex={0}
            aria-label="More stack options — unstack permanently or change which photo is shown"
            title="More stack options"
            onClick={(e) => {
              e.stopPropagation();
              onOpenStackActions?.();
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              e.stopPropagation();
              onOpenStackActions?.();
            }}
          >
            <MoreHorizontalRegular fontSize={14} />
          </span>
        </span>
      ) : null}
      {photo.livePhotoUrl ? (
        <span
          className={`${css.livePhotoBadge}${livePhoto.isVisible ? ` ${css.livePhotoBadgeActive}` : ""}`}
          aria-label="Live photo"
          title="Live photo"
          onMouseEnter={() => setIsLiveBadgeHovered(true)}
          onMouseLeave={() => setIsLiveBadgeHovered(false)}
        >
          {/* Feedback #117: this used to be Filmstrip24Regular — the exact
              same icon the media-type filter's "Videos" glyph uses (see
              Filter.tsx), so a live photo's badge visually claimed to be a
              video. Live24Regular is already the icon FullscreenViewer uses
              for its "Play live photo" button; this just makes the tile
              badge consistent with that instead of borrowing video's icon. */}
          <Live24Regular fontSize={14} />
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
      {showMatchReasons && searchSources && searchSources.length > 0 ? (
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
            src={gatedVideoThumbnail.admittedUrl}
            alt={photo.name}
            loading={loading}
            fetchPriority={fetchPriority}
            decoding="async"
            className={css.image}
            style={videoFade.style}
            onLoad={videoFade.onLoad}
            onError={gatedVideoThumbnail.release}
          />
          {scrubUrl && (
            // Feedback #76: swapped in over the poster while the pointer is
            // over the tile, before the ambient preview (below) takes over.
            // No fade — scrubbing is meant to feel immediate, matching the
            // pointer, not animate a beat behind it.
            <img
              key={scrubUrl}
              src={scrubUrl}
              alt=""
              aria-hidden="true"
              decoding="async"
              className={css.image}
            />
          )}
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
              decoding="async"
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
            src={gatedSharpUrl.admittedUrl}
            alt={photo.name}
            loading={loading}
            fetchPriority={hasMicro ? "low" : fetchPriority}
            decoding="async"
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
            onError={gatedSharpUrl.release}
          />
          {tileEditStyle?.vignetteBackground && (
            <div
              className={css.vignetteOverlay}
              aria-hidden="true"
              style={{
                background: tileEditStyle.vignetteBackground,
                ...(tileEditStyle.transform ? { transform: tileEditStyle.transform } : {}),
                ...(tileEditStyle.clipPath ? { clipPath: tileEditStyle.clipPath } : {}),
              }}
            />
          )}
        </>
      ) : (
        <div className={css.unknownFile}>
          <span className={css.unknownFileName}>{photo.name}</span>
        </div>
      )}
    </button>
  );
};
