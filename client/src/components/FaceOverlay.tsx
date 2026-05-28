import { type SVGProps, useMemo } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import css from "./FullscreenViewer.module.css";

type FaceRegion = {
  area: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type FaceOverlayProps = {
  regionsRaw: unknown;
  aspectRatio: number;
};

export const parseFaceRegions = (raw: unknown): FaceRegion[] => {
  const unwrapJsonString = (value: unknown): unknown => {
    let current = value;
    while (typeof current === "string") {
      try {
        current = JSON.parse(current);
      } catch {
        return current;
      }
    }
    return current;
  };

  const unwrapped = unwrapJsonString(raw);
  if (!Array.isArray(unwrapped)) {
    return [];
  }

  const clampToUnit = (value: number) => Math.min(Math.max(value, 0), 1);

  return unwrapped
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => {
      const area = entry.area;
      if (!area || typeof area !== "object") {
        return null;
      }

      const areaRecord = area as Record<string, unknown>;
      const x = areaRecord.x;
      const y = areaRecord.y;
      const width = areaRecord.width ?? areaRecord.w;
      const height = areaRecord.height ?? areaRecord.h;

      if (
        typeof x !== "number" ||
        typeof y !== "number" ||
        typeof width !== "number" ||
        typeof height !== "number"
      ) {
        return null;
      }

      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
        return null;
      }

      if (width <= 0 || height <= 0) {
        return null;
      }

      return {
        area: {
          x: clampToUnit(x),
          y: clampToUnit(y),
          width: clampToUnit(width),
          height: clampToUnit(height),
        },
      };
    })
    .filter((entry): entry is FaceRegion => entry !== null);
};

const faceRegionToSVGProps = ({ area }: FaceRegion, aspectRatio = 1): SVGProps<SVGRectElement> => {
  const FACE_MASK_PADDING_RATIO = 0.16;
  const width = area.width;
  const height = area.height;
  const padding = Math.max(width, height) * FACE_MASK_PADDING_RATIO;
  const left = area.x - width / 2 - padding;
  const top = area.y - height / 2 - padding;

  const FACE_MASK_CORNER_RATIO = 0.42;
  const rectWidth = width + padding * 2;
  const rectHeight = height + padding * 2;
  const radius = Math.min(rectWidth, rectHeight) * FACE_MASK_CORNER_RATIO;

  return {
    x: left,
    y: top,
    width: rectWidth,
    height: rectHeight,
    rx: radius,
    ry: radius * aspectRatio,
  };
};

const FaceRects = ({
  regions,
  aspectRatio = 1,
  ...svgProps
}: {
  regions: FaceRegion[];
  aspectRatio?: number;
} & SVGProps<SVGRectElement>) =>
  regions.map((region, index) => (
    <rect {...{ ...faceRegionToSVGProps(region, aspectRatio), ...svgProps }} key={index} />
  ));

const toFaceMaskImage = (faceRects: React.ReactNode): string | null => {
  if (!faceRects) {
    return null;
  }

  const featherStdDev = 0.003;
  const svg = renderToStaticMarkup(
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" preserveAspectRatio="none">
      <defs>
        <filter id="face-feather" x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur stdDeviation={featherStdDev} />
        </filter>
      </defs>
      <rect x="0" y="0" width="1" height="1" fill="white" />
      <g filter="url(#face-feather)">{faceRects}</g>
    </svg>,
  );

  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
};

export function FaceOverlay({
  regionsRaw,
  aspectRatio,
}: FaceOverlayProps) {
  const faceRegions = useMemo(() => parseFaceRegions(regionsRaw), [regionsRaw]);
  const faceMaskImage = useMemo(
    () => toFaceMaskImage(<FaceRects regions={faceRegions} aspectRatio={aspectRatio} fill="black" />),
    [aspectRatio, faceRegions],
  );

  if (!faceMaskImage) {
    return null;
  }

  return (
    <>
      <div
        className={`${css.faceBackdropLayer} ${css.faceOverlayVisible}`}
        style={{
          maskImage: faceMaskImage,
          WebkitMaskImage: faceMaskImage,
        } as React.CSSProperties}
        aria-hidden="true"
      />
      <svg
        className={`${css.faceFrameLayer} ${css.faceOverlayVisible}`}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        aria-hidden="true"
      >
        <FaceRects regions={faceRegions} aspectRatio={aspectRatio} className={css.faceFrameRect} />
      </svg>
    </>
  );
}
