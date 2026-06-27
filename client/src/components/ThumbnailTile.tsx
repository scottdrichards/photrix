import {
  ClosedCaption24Regular,
  Filmstrip24Regular,
  Image24Regular,
  MusicNote224Regular,
  PlayCircle24Regular,
} from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import type { PhotoItem, SearchSource } from "../api";
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
const RATIO_MISMATCH_LOG_THRESHOLD = 0.01;
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

export const ThumbnailTile: React.FC<Props> = (props) => {
  const { photo } = props;
  const searchSources = photo.searchSources;
  const tileRef = useRef<HTMLButtonElement | null>(null);
  const supportsIntersectionObserver = typeof IntersectionObserver !== "undefined";
  const [isNearViewport, setIsNearViewport] = useState(!supportsIntersectionObserver);
  const [canRequestThumbnail, setCanRequestThumbnail] = useState(!supportsIntersectionObserver);
  const [isHovered, setIsHovered] = useState(false);
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  const [loadedRatio, setLoadedRatio] = useState<number | null>(null);
  const { setSelected } = useSelectionContext();
  const metadataRatio = getAspectRatio(photo);
  const ratio = loadedRatio ?? metadataRatio;

  useEffect(() => {
    setIsImageLoaded(false);
  }, [photo.thumbnailUrl]);

  useEffect(() => {
    if (!supportsIntersectionObserver) {
      setIsNearViewport(true);
      setCanRequestThumbnail(true);
      return;
    }

    const tile = tileRef.current;
    if (!tile) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(({ isIntersecting }) => {
          setIsNearViewport(isIntersecting);
          if (isIntersecting) {
            setCanRequestThumbnail(true);
          }
        });
      },
      { rootMargin: "300px" },
    );

    observer.observe(tile);
    return () => {
      observer.disconnect();
    };
  }, [supportsIntersectionObserver]);

  const handleClick = () => {
    setSelected(photo);
  };

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    setIsImageLoaded(true);
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight) {
      const actualRatio = clampRatio(img.naturalWidth / img.naturalHeight);
      const ratioDeltaFromDisplayed = Math.abs(actualRatio - ratio);

      // Only update if significantly different from current ratio
      if (ratioDeltaFromDisplayed > RATIO_MISMATCH_LOG_THRESHOLD) {
        setLoadedRatio(actualRatio);
      }
    }
  };

  const loading = isNearViewport ? "eager" : "lazy";
  const fetchPriority = isNearViewport ? "high" : "low";
  const thumbnailUrl = canRequestThumbnail ? photo.thumbnailUrl : undefined;
  const isImage = isDisplayableImage(photo);

  return (
    <button
      type="button"
      ref={tileRef}
      className={css.tile}
      style={{ "--ratio": ratio.toString() } as React.CSSProperties}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      aria-label={photo.name}
    >
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
      {photo.mediaType === "video" ? (
        <>
          <span className={css.videoBadge} aria-hidden="true">
            <PlayCircle24Regular fontSize={24} />
          </span>
          <img
            src={thumbnailUrl}
            alt={photo.name}
            loading={loading}
            fetchPriority={fetchPriority}
            className={css.image}
            style={{ opacity: isImageLoaded ? 1 : 0, transition: "opacity 200ms ease-in" }}
            onLoad={handleImageLoad}
          />
          {isHovered && (
            <video
              src={photo.videoPreviewUrl}
              className={css.image}
              style={{ position: "absolute", top: 0, left: 0 }}
              muted
              loop
              playsInline
              autoPlay
            />
          )}
        </>
      ) : isImage ? (
        <img
          src={thumbnailUrl}
          alt={photo.name}
          loading={loading}
          fetchPriority={fetchPriority}
          className={css.image}
          style={{ opacity: isImageLoaded ? 1 : 0, transition: "opacity 200ms ease-in" }}
          onLoad={handleImageLoad}
        />
      ) : (
        <div className={css.unknownFile}>
          <span className={css.unknownFileName}>{photo.name}</span>
        </div>
      )}
    </button>
  );
};
