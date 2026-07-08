import { useEffect, useRef, useState, useCallback } from "react";
import type { FaceClusterPCAPoint } from "../api";
import { buildFaceCropUrl } from "../api";
import css from "./FaceClusterViz.module.css";

type Props = {
  points: FaceClusterPCAPoint[];
  onFocusCluster: (id: string) => void;
  onResetOverview: () => void;
  onOpenCluster: (id: string) => void;
  onClose: () => void;
};

// Palette of visually distinct hues
const HUES = [0, 210, 120, 45, 270, 180, 330, 90, 15, 240, 300, 60, 195, 165, 345];

const hueForIndex = (i: number) => HUES[i % HUES.length];

type Pt3D = { x: number; y: number; z: number; index: number };

// Multiply 3×3 rotation matrix by vector
const rotVec = (m: number[], v: [number, number, number]): [number, number, number] => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

const rotX = (a: number): number[] => [
  1, 0, 0,
  0, Math.cos(a), -Math.sin(a),
  0, Math.sin(a), Math.cos(a),
];
const rotY = (a: number): number[] => [
  Math.cos(a), 0, Math.sin(a),
  0, 1, 0,
  -Math.sin(a), 0, Math.cos(a),
];
const mulMat = (a: number[], b: number[]): number[] => {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 3; k++) {
        out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
      }
    }
  }
  return out;
};

const FACE_SIZE = 48; // px diameter of each face circle
const PERSPECTIVE = 900;
const FACE_IMAGE_COUNT_THRESHOLD = 1000;

const pointUsesImage = (point: FaceClusterPCAPoint, focusedView: boolean) =>
  focusedView || point.count >= FACE_IMAGE_COUNT_THRESHOLD;

const pointRadius = (
  point: FaceClusterPCAPoint,
  focused: boolean,
  focusedView: boolean,
) => {
  if (pointUsesImage(point, focusedView)) return FACE_SIZE / 2;
  return focused ? 7 : 5;
};

export const FaceClusterViz = ({
  points,
  onFocusCluster,
  onResetOverview,
  onOpenCluster,
  onClose,
}: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const rotRef = useRef<[number, number]>([0.3, -0.5]); // [angleX, angleY]
  const autoRef = useRef(true);
  const dragRef = useRef<{ startX: number; startY: number; rot: [number, number] } | null>(null);
  const rafRef = useRef<number>(0);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const hoveredIdxRef = useRef<number | null>(null);
  const focusedView = points.some((point) => point.focused);

  // Preload face images
  useEffect(() => {
    for (const p of points) {
      if (!pointUsesImage(p, focusedView)) continue;
      const url = buildFaceCropUrl(p.representative, 96);
      if (!imagesRef.current.has(url)) {
        const img = new Image();
        img.src = url;
        imagesRef.current.set(url, img);
      }
    }
  }, [focusedView, points]);

  // Normalize coords to [-1, 1]
  const normalizedRef = useRef<Pt3D[]>([]);
  useEffect(() => {
    if (points.length === 0) { normalizedRef.current = []; return; }
    const focusedPoint = points.find((point) => point.focused);
    if (focusedPoint) {
      const rangeX = Math.max(...points.map((point) => Math.abs(point.x))) || 1;
      const rangeY = Math.max(...points.map((point) => Math.abs(point.y))) || 1;
      const rangeZ = Math.max(...points.map((point) => Math.abs(point.z))) || 1;
      normalizedRef.current = points.map((p, index) => ({
        x: p.x / rangeX,
        y: p.y / rangeY,
        z: p.z / rangeZ,
        index,
      }));
      return;
    }

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const rangeZ = maxZ - minZ || 1;
    normalizedRef.current = points.map((p, index) => ({
      x: ((p.x - minX) / rangeX) * 2 - 1,
      y: ((p.y - minY) / rangeY) * 2 - 1,
      z: ((p.z - minZ) / rangeZ) * 2 - 1,
      index,
    }));
  }, [points]);

  useEffect(() => {
    hoveredIdxRef.current = null;
    setHoveredIdx(null);
  }, [points]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const scale = Math.min(W, H) * 0.38;

    ctx.clearRect(0, 0, W, H);

    const [ax, ay] = rotRef.current;
    const mat = mulMat(rotX(ax), rotY(ay));

    // Project all points
    type Projected = {
      sx: number;
      sy: number;
      z: number;
      index: number;
      radius: number;
      usesImage: boolean;
      focused: boolean;
    };
    const projected: Projected[] = normalizedRef.current.map((p) => {
      const [rx, ry, rz] = rotVec(mat, [p.x, p.y, p.z]);
      const d = PERSPECTIVE / (PERSPECTIVE + rz * scale);
      const point = points[p.index]!;
      const focused = point.focused;
      return {
        sx: cx + rx * scale * d,
        sy: cy - ry * scale * d,
        z: rz,
        index: p.index,
        radius: pointRadius(point, focused, focusedView) * d,
        usesImage: pointUsesImage(point, focusedView),
        focused,
      };
    });

    // Larger z values are farther away with this projection, so draw them first.
    projected.sort((a, b) => b.z - a.z);

    for (const proj of projected) {
      const { sx, sy, index, radius, usesImage, focused } = proj;
      const hue = hueForIndex(index);
      const isHovered = hoveredIdxRef.current === index;
      const point = points[index]!;
      const url = usesImage ? buildFaceCropUrl(point.representative, 96) : null;
      const img = url ? imagesRef.current.get(url) : null;

      // Shadow / glow for hovered
      if (isHovered || focused) {
        ctx.shadowColor = `hsl(${hue}, 80%, 55%)`;
        ctx.shadowBlur = focused ? 20 : 16;
      }

      if (usesImage) {
        // Circular clip + face image
        ctx.save();
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.clip();

        if (img?.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, sx - radius, sy - radius, radius * 2, radius * 2);
        } else {
          // Placeholder
          ctx.fillStyle = `hsl(${hue}, 60%, 40%)`;
          ctx.fillRect(sx - radius, sy - radius, radius * 2, radius * 2);
        }
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fillStyle = focused ? `hsl(${hue}, 80%, 68%)` : `hsl(${hue}, 70%, 55%)`;
        ctx.fill();
      }

      ctx.shadowBlur = 0;

      // Outline
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = focused
        ? "#ffffff"
        : isHovered
          ? `hsl(${hue}, 90%, 70%)`
          : `hsl(${hue}, 70%, 55%)`;
      ctx.lineWidth = focused ? 3 : isHovered ? 3 : usesImage ? 2 : 1.5;
      ctx.stroke();

      // Label below
      if (isHovered || focused) {
        const label = point.name ?? `${point.count} faces`;
        ctx.font = "bold 13px sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#fff";
        ctx.shadowColor = "rgba(0,0,0,0.8)";
        ctx.shadowBlur = 4;
        ctx.fillText(label, sx, sy + radius + 16);
        ctx.shadowBlur = 0;
      }
    }
  }, [focusedView, points]);

  // Animation loop
  useEffect(() => {
    let lastTime = 0;
    const loop = (time: number) => {
      const dt = (time - lastTime) / 1000;
      lastTime = time;
      if (autoRef.current && !dragRef.current) {
        rotRef.current = [rotRef.current[0], rotRef.current[1] + dt * 0.3];
      }
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  // Hit-test: find the closest point to (mx, my) in screen space
  const hitTest = useCallback(
    (mx: number, my: number): number | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const W = canvas.width;
      const H = canvas.height;
      const cx = W / 2;
      const cy = H / 2;
      const scale = Math.min(W, H) * 0.38;
      const [ax, ay] = rotRef.current;
      const mat = mulMat(rotX(ax), rotY(ay));

      let closest: number | null = null;
      let closestDist = Infinity;

      for (const p of normalizedRef.current) {
        const [rx, ry, rz] = rotVec(mat, [p.x, p.y, p.z]);
        const d = PERSPECTIVE / (PERSPECTIVE + rz * scale);
        const sx = cx + rx * scale * d;
        const sy = cy - ry * scale * d;
        const point = points[p.index]!;
        const maxDistance = pointRadius(point, point.focused, focusedView) * d + 6;
        const dist = Math.hypot(mx - sx, my - sy);
        if (dist <= maxDistance && dist < closestDist) {
          closestDist = dist;
          closest = p.index;
        }
      }
      return closest;
    },
    [focusedView, points],
  );

  const getCanvasXY = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const scaleX = canvasRef.current!.width / rect.width;
    const scaleY = canvasRef.current!.height / rect.height;
    return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY] as const;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const [mx, my] = getCanvasXY(e);
    if (dragRef.current) {
      autoRef.current = false;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      rotRef.current = [
        dragRef.current.rot[0] + dy * 0.008,
        dragRef.current.rot[1] + dx * 0.008,
      ];
    } else {
      const idx = hitTest(mx, my);
      hoveredIdxRef.current = idx;
      setHoveredIdx(idx);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      rot: [...rotRef.current] as [number, number],
    };
  };

  const handleMouseUp = () => {
    dragRef.current = null;
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const [mx, my] = getCanvasXY(e);
    const idx = hitTest(mx, my);
    if (idx !== null) {
      onFocusCluster(points[idx].id);
    }
  };

  const handleDoubleClick = () => {
    autoRef.current = !autoRef.current;
  };

  const focusedPoint = points.find((point) => point.focused) ?? null;

  return (
    <div className={css.overlay}>
      <div className={css.panel}>
        <div className={css.header}>
          <span className={css.title}>Face Embedding Space — PCA 3D</span>
          <span className={css.hint}>
            {focusedPoint
              ? "selected person centered with 10 nearest neighbors"
              : "1000+ faces show crops · 100-999 show dots · click a point to focus"}
          </span>
          {focusedPoint ? (
            <div className={css.headerActions}>
              <button type="button" className={css.headerBtn} onClick={onResetOverview}>
                Overview
              </button>
              <button
                type="button"
                className={css.headerBtn}
                onClick={() => onOpenCluster(focusedPoint.id)}
              >
                Open Person
              </button>
            </div>
          ) : null}
          <button type="button" className={css.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <canvas
          ref={canvasRef}
          width={900}
          height={620}
          className={css.canvas}
          style={{ cursor: hoveredIdx !== null ? "pointer" : dragRef.current ? "grabbing" : "grab" }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
        />
        <div className={css.legend}>
          {points.slice(0, 12).map((p, i) => (
            <button
              key={p.id}
              type="button"
              className={css.legendItem}
              onClick={() => onFocusCluster(p.id)}
            >
              <span
                className={css.legendDot}
                style={{
                  background: `hsl(${hueForIndex(i)}, 70%, 55%)`,
                  boxShadow: p.focused ? "0 0 0 2px #fff" : undefined,
                }}
              />
              <span>{p.name ?? `${p.count} faces`}</span>
            </button>
          ))}
          {points.length > 12 && (
            <span className={css.legendMore}>+{points.length - 12} more</span>
          )}
        </div>
      </div>
    </div>
  );
};
