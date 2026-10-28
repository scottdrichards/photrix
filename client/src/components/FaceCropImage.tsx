import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { buildFaceCropUrl } from "../api";
import type { ClusterFace } from "../api/types";
import { makeFaceCropPlaceholder, peekFaceCropPlaceholder } from "./faceCropPlaceholder";
import { logFailure } from "../logFailure";

type FaceCropImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  face: ClusterFace;
  alt: string;
  /** Crop height in px; see buildFaceCropUrl. */
  size?: number;
};

/**
 * A face crop that shows a soft preview cut from the photo's cached grid tile
 * until the real crop loads (feedback #154; see faceCropPlaceholder.ts). A
 * plain `<img>` for layout purposes: the preview is its background, so every
 * caller's own sizing and `object-fit` apply unchanged.
 */
export const FaceCropImage = ({
  face,
  size,
  alt,
  style,
  ...imgProps
}: FaceCropImageProps) => {
  const ref = useRef<HTMLImageElement>(null);
  const [placeholder, setPlaceholder] = useState(() => peekFaceCropPlaceholder(face));
  const src = buildFaceCropUrl(face, size);
  const lazy = imgProps.loading === "lazy";

  useEffect(() => {
    setPlaceholder(peekFaceCropPlaceholder(face));
    const img = ref.current;
    if (!img) return;
    let cancelled = false;
    const start = () => {
      // An already-cached crop arrives in a few ms; don't fetch a tile for it.
      if (img.complete && img.naturalWidth > 0) return;
      makeFaceCropPlaceholder(face)
        .then((url) => {
          if (!cancelled && url) setPlaceholder(url);
        })
        .catch(logFailure("faceCrop.placeholder.failed", "Could not build a face-crop preview"));
    };
    // Follow the image's own laziness: a lazy crop only starts its preview
    // once it is about to scroll into view.
    if (!lazy || typeof IntersectionObserver === "undefined") {
      start();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        start();
      },
      { rootMargin: "400px" },
    );
    observer.observe(img);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
    // `src` captures everything about the face that changes the crop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, lazy]);

  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
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
