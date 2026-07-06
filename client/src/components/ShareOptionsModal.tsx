import { useRef, useState } from "react";
import type { PhotoItem } from "../api";
import css from "./ShareOptionsModal.module.css";

type ShareQuality = "original" | "compatible-full" | "compatible-share";

type QualityDef = {
  id: ShareQuality;
  label: string;
  imageDesc: string;
  videoDesc: string;
};

const QUALITIES: QualityDef[] = [
  {
    id: "original",
    label: "Original file",
    imageDesc: "Exact file as stored — any format, full fidelity",
    videoDesc: "Exact video file as stored",
  },
  {
    id: "compatible-full",
    label: "Most compatible, original quality",
    imageDesc: "JPEG at full resolution — works in any app",
    videoDesc: "Original video (no server-side transcoding available)",
  },
  {
    id: "compatible-share",
    label: "Most compatible, high quality",
    imageDesc: "JPEG up to 1440p — ideal size for messaging and social",
    videoDesc: "Original video (no server-side transcoding available)",
  },
];

const getImageShareUrl = (photo: PhotoItem, quality: ShareQuality): string => {
  if (quality === "original") return photo.originalUrl;
  const url = new URL(photo.originalUrl);
  url.searchParams.set("representation", "webSafe");
  if (quality === "compatible-share") url.searchParams.set("height", "1440");
  return url.toString();
};

const getImageFilename = (photo: PhotoItem, quality: ShareQuality): string => {
  const base = photo.name.replace(/\.[^.]+$/, "");
  return quality === "original" ? photo.name : `${base}.jpg`;
};

const triggerDownload = (url: string, filename: string) => {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

type Props = {
  photos: PhotoItem[];
  onClose: () => void;
};

export const ShareOptionsModal: React.FC<Props> = ({ photos, onClose }) => {
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const images = photos.filter((p) => p.mediaType !== "video");
  const videos = photos.filter((p) => p.mediaType === "video");
  const hasVideos = videos.length > 0;
  const hasImages = images.length > 0;

  const handleShare = async (quality: ShareQuality) => {
    setError(null);
    setProgress("Preparing…");
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      // Images: fetch as blobs so the OS share sheet can pass them to other apps
      const imageFiles: File[] = [];
      for (let i = 0; i < images.length; i++) {
        if (abort.signal.aborted) return;
        const photo = images[i];
        setProgress(
          images.length > 1
            ? `Preparing image ${i + 1} of ${images.length}…`
            : "Preparing image…",
        );
        const url = getImageShareUrl(photo, quality);
        const response = await fetch(url, { signal: abort.signal });
        if (!response.ok) throw new Error(`Failed to fetch ${photo.name}`);
        const blob = await response.blob();
        imageFiles.push(new File([blob], getImageFilename(photo, quality), { type: blob.type }));
      }

      if (abort.signal.aborted) return;

      // Share or download images
      if (imageFiles.length > 0) {
        if (navigator.canShare?.({ files: imageFiles }) && navigator.share) {
          await navigator.share({ files: imageFiles });
        } else {
          for (const file of imageFiles) {
            const objectUrl = URL.createObjectURL(file);
            triggerDownload(objectUrl, file.name);
            URL.revokeObjectURL(objectUrl);
          }
        }
      }

      // Videos: never blob-load — trigger browser downloads directly via URL
      // (videos can be gigabytes; all quality options serve the original anyway)
      if (videos.length > 0) {
        setProgress(
          videos.length === 1
            ? "Starting video download…"
            : `Starting ${videos.length} video downloads…`,
        );
        for (const video of videos) {
          triggerDownload(video.originalUrl, video.name);
        }
      }

      onClose();
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || abort.signal.aborted)) return;
      setError("Something went wrong. Please try again.");
      setProgress(null);
    }
  };

  const handleClose = () => {
    abortRef.current?.abort();
    onClose();
  };

  const count = photos.length;
  const noun = count === 1 ? "item" : "items";

  const getDesc = (q: QualityDef) => {
    if (hasImages && hasVideos) return `${q.imageDesc} · ${q.videoDesc}`;
    if (hasVideos) return q.videoDesc;
    return q.imageDesc;
  };

  return (
    <div className={css.backdrop} onClick={handleClose}>
      <div className={css.sheet} onClick={(e) => e.stopPropagation()}>
        <div className={css.handle} />
        <h3 className={css.title}>
          Share {count} {noun}
        </h3>

        {hasVideos && (
          <p className={css.videoNote}>
            {hasImages
              ? "Images will be shared via the system share sheet. Videos will be downloaded directly."
              : `Video${videos.length > 1 ? "s" : ""} will be downloaded directly — no server-side transcoding is available.`}
          </p>
        )}

        {progress ? (
          <div className={css.progress}>
            <div className={css.spinner} />
            {progress}
          </div>
        ) : (
          <div className={css.options}>
            {QUALITIES.map((q) => (
              <button key={q.id} className={css.option} onClick={() => void handleShare(q.id)}>
                <span className={css.optionLabel}>{q.label}</span>
                <span className={css.optionDesc}>{getDesc(q)}</span>
              </button>
            ))}
          </div>
        )}

        {error && <p className={css.error}>{error}</p>}

        <button className={`btn btn-subtle ${css.cancel}`} onClick={handleClose}>
          Cancel
        </button>
      </div>
    </div>
  );
};
