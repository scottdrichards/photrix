import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { buildFaceCropUrl } from "../../api";
import type { ClusterFace } from "../../api/types";
import { useNearViewport } from "../../hooks/useNearViewport";
import { makeFaceCropPlaceholder, peekFaceCropPlaceholder } from "./faceCropPlaceholder";
import { logFailure } from "../../logFailure";

type FaceCropImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  face: ClusterFace;
  alt: string;
  /** Crop height in px; see buildFaceCropUrl. */
  size?: number;
};

/** Stands in for a crop that isn't wanted yet: no request, no broken-image icon. */
const BLANK_PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * A face crop that shows a soft preview cut from the photo's cached grid tile
 * until the real crop loads (feedback #154; see faceCropPlaceholder.ts). A
 * plain `<img>` for layout purposes: the preview is its background, so every
 * caller's own sizing and `object-fit` apply unchanged.
 *
 * Feedback #171: a lazy crop only asks for the real crop while it is close to
 * the viewport, and gives the request up if it scrolls away first. The server
 * cuts crops a couple at a time, oldest request first, and native lazy loading
 * never cancels: a fast scroll down a person's faces queued a crop for every
 * face it passed (2,147 in one measured flick), so the faces on screen waited
 * minutes behind them and showed only their previews.
 */
export const FaceCropImage = ({
  face,
  size,
  alt,
  style,
  onLoad,
  ...imgProps
}: FaceCropImageProps) => {
  const [isNear, ref, isClose] = useNearViewport<HTMLImageElement>();
  const [placeholder, setPlaceholder] = useState(() => peekFaceCropPlaceholder(face));
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const src = buildFaceCropUrl(face, size);
  const lazy = imgProps.loading === "lazy";
  const loaded = loadedSrc === src;
  const wantsCrop = !lazy || isClose || loaded;
  const wantsPlaceholder = !lazy || isNear;

  useEffect(() => {
    setPlaceholder(peekFaceCropPlaceholder(face));
    // `src` captures everything about the face that changes the crop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    // An already-loaded crop needs no preview, and a far-off one not yet.
    if (!wantsPlaceholder || loaded) return;
    const img = ref.current;
    if (wantsCrop && img?.complete && img.naturalWidth > 1) return;
    let cancelled = false;
    makeFaceCropPlaceholder(face)
      .then((url) => {
        if (!cancelled && url) setPlaceholder(url);
      })
      .catch(logFailure("faceCrop.placeholder.failed", "Could not build a face-crop preview"));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, wantsPlaceholder]);

  return (
    <img
      ref={ref}
      src={wantsCrop ? src : BLANK_PIXEL}
      alt={alt}
      onLoad={(event) => {
        if (event.currentTarget.getAttribute("src") === src) setLoadedSrc(src);
        onLoad?.(event);
      }}
      style={
        placeholder
          ? {
              ...style,
              backgroundImage: `url(${placeholder})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
            }
          : style
      }
      {...imgProps}
    />
  );
};
