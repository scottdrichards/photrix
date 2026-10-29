import { useCallback, useRef } from "react";
import css from "../PhotoEditor.module.css";

interface CropBoxProps {
  top: number;
  right: number;
  bottom: number;
  left: number;
  rotationDeg: number;
  minCrop: { top: number; right: number; bottom: number; left: number };
  onChange: (crop: { top: number; right: number; bottom: number; left: number }) => void;
}
export function CropBox({ top, right, bottom, left, rotationDeg, minCrop, onChange }: CropBoxProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    handle: string;
    startX: number;
    startY: number;
    startTop: number;
    startRight: number;
    startBottom: number;
    startLeft: number;
    containerW: number;
    containerH: number;
  } | null>(null);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, handle: string) => {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const container = containerRef.current;
      if (!container) return;
      dragRef.current = {
        handle,
        startX: e.clientX,
        startY: e.clientY,
        startTop: top,
        startRight: right,
        startBottom: bottom,
        startLeft: left,
        containerW: container.clientWidth,
        containerH: container.clientHeight,
      };
    },
    [top, right, bottom, left],
  );

  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const ds = dragRef.current;
      if (!ds) return;
      e.preventDefault();

      const screenDx = e.clientX - ds.startX;
      const screenDy = e.clientY - ds.startY;

      // Inverse-rotate mouse delta to local (pre-rotation) image space
      const θ = -rotationDeg * Math.PI / 180;
      const ldx = screenDx * Math.cos(θ) - screenDy * Math.sin(θ);
      const ldy = screenDx * Math.sin(θ) + screenDy * Math.cos(θ);

      const pctX = (ldx / ds.containerW) * 100;
      const pctY = (ldy / ds.containerH) * 100;

      const h = ds.handle;
      let newTop = ds.startTop;
      let newRight = ds.startRight;
      let newBottom = ds.startBottom;
      let newLeft = ds.startLeft;

      if (h.includes("t")) newTop = Math.max(minCrop.top, Math.min(49, ds.startTop + pctY));
      if (h.includes("b")) newBottom = Math.max(minCrop.bottom, Math.min(49, ds.startBottom - pctY));
      if (h.includes("l")) newLeft = Math.max(minCrop.left, Math.min(49, ds.startLeft + pctX));
      if (h.includes("r")) newRight = Math.max(minCrop.right, Math.min(49, ds.startRight - pctX));

      onChange({ top: newTop, right: newRight, bottom: newBottom, left: newLeft });
    },
    [rotationDeg, minCrop, onChange],
  );

  const onHandlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const makeHandle = (pos: string, style: React.CSSProperties) => (
    <div
      key={pos}
      className={css.cropHandle}
      style={style}
      onPointerDown={(e) => onHandlePointerDown(e, pos)}
      onPointerMove={onHandlePointerMove}
      onPointerUp={onHandlePointerUp}
    />
  );

  // Derived positions (from-left / from-top in %) for handles
  const tPct = top;
  const bPct = 100 - bottom;
  const lPct = left;
  const rPct = 100 - right;
  const midX = (lPct + rPct) / 2;
  const midY = (tPct + bPct) / 2;

  return (
    <div
      ref={containerRef}
      className={css.cropOverlay}
      style={rotationDeg !== 0 ? { transform: `rotate(${rotationDeg}deg)` } : undefined}
    >
      {/* Shadow over cropped areas */}
      <div className={css.cropShadow} style={{ top: 0, left: 0, right: 0, height: `${tPct}%` }} />
      <div className={css.cropShadow} style={{ bottom: 0, left: 0, right: 0, height: `${100 - bPct}%` }} />
      <div className={css.cropShadow} style={{ top: `${tPct}%`, bottom: `${100 - bPct}%`, left: 0, width: `${lPct}%` }} />
      <div className={css.cropShadow} style={{ top: `${tPct}%`, bottom: `${100 - bPct}%`, right: 0, width: `${100 - rPct}%` }} />
      {/* Crop border */}
      <div
        className={css.cropBorder}
        style={{ top: `${tPct}%`, left: `${lPct}%`, width: `${rPct - lPct}%`, height: `${bPct - tPct}%` }}
      />
      {/* Corner handles */}
      {makeHandle("tl", { top: `${tPct}%`, left: `${lPct}%`, cursor: "nwse-resize" })}
      {makeHandle("tr", { top: `${tPct}%`, left: `${rPct}%`, cursor: "nesw-resize" })}
      {makeHandle("bl", { top: `${bPct}%`, left: `${lPct}%`, cursor: "nesw-resize" })}
      {makeHandle("br", { top: `${bPct}%`, left: `${rPct}%`, cursor: "nwse-resize" })}
      {/* Edge handles */}
      {makeHandle("t", { top: `${tPct}%`, left: `${midX}%`, cursor: "ns-resize" })}
      {makeHandle("b", { top: `${bPct}%`, left: `${midX}%`, cursor: "ns-resize" })}
      {makeHandle("l", { top: `${midY}%`, left: `${lPct}%`, cursor: "ew-resize" })}
      {makeHandle("r", { top: `${midY}%`, left: `${rPct}%`, cursor: "ew-resize" })}
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────
