import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PhotoItem } from "../api";
import type { EditStyle } from "./PhotoEditor";
import css from "./SwipePhotoViewer.module.css";

const MAX_SCALE = 5;
const ZOOM_DEFAULT_SCALE = 2.5;
const SWIPE_COMMIT_RATIO = 0.22;
const SWIPE_COMMIT_MAX_PX = 90;
const DOUBLE_TAP_MS = 300;
const AXIS_LOCK_PX = 8;

const clampN = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const readAspect = (item: PhotoItem | null | undefined): number => {
  const width = Number(item?.metadata?.dimensionWidth);
  const height = Number(item?.metadata?.dimensionHeight);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return width / height;
  }
  return 1;
};

// Neighbours only need to look right during the swipe, so use the mid-size
// preview (or the poster thumbnail for videos) rather than the full asset.
const neighborSrc = (item: PhotoItem): string =>
  item.mediaType === "video" ? item.thumbnailUrl : item.previewUrl;

type GestureMode = "idle" | "swipe" | "pan" | "pinch";

type GestureState = {
  mode: GestureMode;
  startX: number;
  startY: number;
  startTx: number;
  startTy: number;
  pinchStartDist: number;
  pinchStartScale: number;
  axisLocked: "x" | "y" | null;
  moved: boolean;
};

type ZoomState = { scale: number; tx: number; ty: number };

const NO_ZOOM: ZoomState = { scale: 1, tx: 0, ty: 0 };

type SwipePhotoViewerProps = {
  photo: PhotoItem;
  prevPhoto: PhotoItem | null;
  nextPhoto: PhotoItem | null;
  photoAspectRatio: number;
  fullImageLoaded: boolean;
  editStyle?: EditStyle;
  onImageLoad: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  children?: ReactNode;
};

export function SwipePhotoViewer({
  photo,
  prevPhoto,
  nextPhoto,
  photoAspectRatio,
  fullImageLoaded,
  editStyle,
  onImageLoad,
  onNext,
  onPrev,
  onClose,
  children,
}: SwipePhotoViewerProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pendingCommit = useRef<"next" | "prev" | null>(null);
  const lastTap = useRef(0);
  const gesture = useRef<GestureState>({
    mode: "idle",
    startX: 0,
    startY: 0,
    startTx: 0,
    startTy: 0,
    pinchStartDist: 1,
    pinchStartScale: 1,
    axisLocked: null,
    moved: false,
  });

  const [pane, setPane] = useState({ w: 0, h: 0 });
  const [dragDx, setDragDx] = useState(0);
  const [trackAnimating, setTrackAnimating] = useState(false);
  const [zoom, setZoom] = useState<ZoomState>(NO_ZOOM);
  const [zoomAnimating, setZoomAnimating] = useState(true);

  // Reset all interaction state whenever the centre photo changes.
  useEffect(() => {
    setZoom(NO_ZOOM);
    setZoomAnimating(true);
    setDragDx(0);
    setTrackAnimating(false);
    pointers.current.clear();
    gesture.current.mode = "idle";
    pendingCommit.current = null;
  }, [photo.path]);

  // Track the pane size so the letterboxed box is measured against the visible
  // area (which shrinks when the info panel opens), not the raw viewport.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => setPane({ w: el.clientWidth, h: el.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit = (aspect: number): { w: number; h: number } => {
    const { w, h } = pane;
    if (!w || !h) return { w: 0, h: 0 };
    let fitW = w;
    let fitH = w / aspect;
    if (fitH > h) {
      fitH = h;
      fitW = h * aspect;
    }
    return { w: fitW, h: fitH };
  };

  const centerFit = fit(photoAspectRatio);

  const clampPan = (tx: number, ty: number, scale: number): { tx: number; ty: number } => {
    const maxX = Math.max(0, (centerFit.w * scale - centerFit.w) / 2);
    const maxY = Math.max(0, (centerFit.h * scale - centerFit.h) / 2);
    return { tx: clampN(tx, -maxX, maxX), ty: clampN(ty, -maxY, maxY) };
  };

  const zoomToPoint = (clientX: number, clientY: number) => {
    setZoomAnimating(true);
    setZoom((current) => {
      if (current.scale > 1) return NO_ZOOM;
      const box = boxRef.current;
      if (!box) return { scale: ZOOM_DEFAULT_SCALE, tx: 0, ty: 0 };
      const rect = box.getBoundingClientRect();
      const offsetX = clientX - (rect.left + rect.width / 2);
      const offsetY = clientY - (rect.top + rect.height / 2);
      const { tx, ty } = clampPan(
        -offsetX * (ZOOM_DEFAULT_SCALE - 1),
        -offsetY * (ZOOM_DEFAULT_SCALE - 1),
        ZOOM_DEFAULT_SCALE,
      );
      return { scale: ZOOM_DEFAULT_SCALE, tx, ty };
    });
  };

  const handleTap = (e: React.PointerEvent) => {
    // setPointerCapture retargets all pointer events to the viewport element,
    // so e.target is always the viewport — check position against the box instead.
    const box = boxRef.current;
    const rect = box?.getBoundingClientRect();
    const isOnImage =
      rect != null &&
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!isOnImage) {
      onClose();
      return;
    }
    const now = Date.now();
    const isDoubleTap = now - lastTap.current < DOUBLE_TAP_MS;
    lastTap.current = now;
    // Mouse users get single-click zoom; touch users double-tap (a single tap
    // stays free for closing / future interactions).
    if (e.pointerType === "mouse" || isDoubleTap) {
      zoomToPoint(e.clientX, e.clientY);
    }
  };

  const finishSwipe = () => {
    const width = pane.w || viewportRef.current?.clientWidth || 1;
    const threshold = Math.min(width * SWIPE_COMMIT_RATIO, SWIPE_COMMIT_MAX_PX);
    setTrackAnimating(true);
    if (dragDx <= -threshold && nextPhoto) {
      pendingCommit.current = "next";
      setDragDx(-width);
    } else if (dragDx >= threshold && prevPhoto) {
      pendingCommit.current = "prev";
      setDragDx(width);
    } else {
      setDragDx(0);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture is unavailable in some environments (e.g. jsdom)
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    g.moved = false;

    if (pointers.current.size >= 2) {
      const [p1, p2] = [...pointers.current.values()];
      g.mode = "pinch";
      g.pinchStartDist = distance(p1, p2) || 1;
      g.pinchStartScale = zoom.scale;
      setTrackAnimating(false);
      setZoomAnimating(false);
      return;
    }

    g.startX = e.clientX;
    g.startY = e.clientY;
    g.axisLocked = null;
    if (zoom.scale > 1) {
      g.mode = "pan";
      g.startTx = zoom.tx;
      g.startTy = zoom.ty;
      setZoomAnimating(false);
    } else {
      g.mode = "swipe";
      setTrackAnimating(false);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;

    if (g.mode === "pinch" && pointers.current.size >= 2) {
      const [p1, p2] = [...pointers.current.values()];
      const scale = clampN((distance(p1, p2) / g.pinchStartDist) * g.pinchStartScale, 1, MAX_SCALE);
      setZoom((z) => {
        const { tx, ty } = clampPan(z.tx, z.ty, scale);
        return { scale, tx, ty };
      });
      return;
    }

    if (g.mode === "pan") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
      setZoom((z) => {
        const { tx, ty } = clampPan(g.startTx + dx, g.startTy + dy, z.scale);
        return { ...z, tx, ty };
      });
      return;
    }

    if (g.mode === "swipe") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (!g.axisLocked && (Math.abs(dx) > AXIS_LOCK_PX || Math.abs(dy) > AXIS_LOCK_PX)) {
        g.axisLocked = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      if (g.axisLocked !== "x") return;
      g.moved = true;
      // Rubber-band resistance when there's no neighbour in that direction.
      let d = dx;
      if ((d > 0 && !prevPhoto) || (d < 0 && !nextPhoto)) d *= 0.25;
      setDragDx(d);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const g = gesture.current;
    const wasMoved = g.moved;
    pointers.current.delete(e.pointerId);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // capture may already be gone
    }

    if (g.mode === "pinch") {
      // Lifting one finger of a pinch — continue with the remaining finger.
      if (pointers.current.size === 1) {
        const [remaining] = [...pointers.current.values()];
        g.startX = remaining.x;
        g.startY = remaining.y;
        if (zoom.scale > 1) {
          g.mode = "pan";
          g.startTx = zoom.tx;
          g.startTy = zoom.ty;
        } else {
          g.mode = "swipe";
          g.axisLocked = null;
        }
        return;
      }
      setZoomAnimating(true);
      if (zoom.scale <= 1.02) setZoom(NO_ZOOM);
      g.mode = "idle";
      return;
    }

    if (g.mode === "swipe") {
      finishSwipe();
    } else if (g.mode === "pan") {
      setZoomAnimating(true);
      if (zoom.scale <= 1.02) setZoom(NO_ZOOM);
    }
    g.mode = "idle";

    if (!wasMoved) handleTap(e);
  };

  const onWheel = (e: React.WheelEvent) => {
    // Only fine-tune an existing zoom; entry into zoom is via click / pinch.
    if (zoom.scale <= 1) return;
    setZoomAnimating(false);
    setZoom((z) => {
      const scale = clampN(z.scale + (e.deltaY < 0 ? 0.25 : -0.25), 1, MAX_SCALE);
      const { tx, ty } = clampPan(z.tx, z.ty, scale);
      return { scale, tx, ty };
    });
  };

  const onTrackTransitionEnd = (e: React.TransitionEvent) => {
    if (e.propertyName !== "transform") return;
    const commit = pendingCommit.current;
    pendingCommit.current = null;
    setTrackAnimating(false);
    setDragDx(0);
    if (commit === "next") onNext();
    else if (commit === "prev") onPrev();
  };

  const trackStyle: React.CSSProperties = {
    transform: `translateX(calc(-100% + ${dragDx}px))`,
    transition: trackAnimating ? "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)" : "none",
  };

  const boxStyle: React.CSSProperties = {
    width: centerFit.w || undefined,
    height: centerFit.h || undefined,
    transform: `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`,
    transition: zoomAnimating ? "transform 180ms ease-out" : "none",
    cursor: zoom.scale > 1 ? "grab" : "zoom-in",
    // Exposed so a nested FaceOverlay's name labels can counter-scale by the
    // inverse of this value — the box itself (and everything painted inside
    // it, including the face label layer) is being scaled up by `zoom.scale`,
    // so without this the labels would grow right along with the photo.
    "--label-counter-scale": (1 / zoom.scale).toString(),
  } as React.CSSProperties;

  const renderNeighbor = (item: PhotoItem | null, key: string) => (
    <div className={css.pane} key={key} data-role="pane">
      {item && pane.w > 0 && (
        <img
          src={neighborSrc(item)}
          alt=""
          aria-hidden="true"
          className={css.neighborImage}
          style={{ width: fit(readAspect(item)).w, height: fit(readAspect(item)).h }}
          draggable={false}
        />
      )}
    </div>
  );

  return (
    <div
      ref={viewportRef}
      className={css.viewport}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <div className={css.track} style={trackStyle} onTransitionEnd={onTrackTransitionEnd}>
        {renderNeighbor(prevPhoto, "prev")}

        <div className={css.pane} data-role="pane">
          <div ref={boxRef} className={css.box} style={boxStyle}>
            <div
              className={css.thumb}
              aria-hidden="true"
              style={{
                backgroundImage: `url("${photo.thumbnailUrl}")`,
                opacity: fullImageLoaded ? 0 : 1,
              }}
            />
            <img
              src={photo.fullUrl}
              alt={photo.name}
              data-role="image"
              className={css.image}
              draggable={false}
              onLoad={onImageLoad}
              style={{
                opacity: fullImageLoaded ? 1 : 0,
                ...(editStyle?.filter ? { filter: editStyle.filter } : {}),
                ...(editStyle?.transform ? { transform: editStyle.transform } : {}),
                ...(editStyle?.clipPath ? { clipPath: editStyle.clipPath } : {}),
              }}
            />
            {children}
          </div>
        </div>

        {renderNeighbor(nextPhoto, "next")}
      </div>
    </div>
  );
}
