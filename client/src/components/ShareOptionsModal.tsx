import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PhotoItem } from "../api";
import css from "./ShareOptionsModal.module.css";

type ShareQuality = "original" | "websafe-full" | "websafe-small";
type ShareAction = "share" | "download";
type DownloadItem = { url: string; filename: string };
type PreparedShare = { files: File[]; videoDownloads: DownloadItem[] };

type QualityDef = {
  id: ShareQuality;
  label: string;
  imageDesc: string;
  videoDesc: string;
};

const QUALITIES: QualityDef[] = [
  {
    id: "original",
    label: "Original",
    imageDesc: "Exact file as stored — any format, full fidelity",
    videoDesc: "Exact video file as stored",
  },
  {
    id: "websafe-full",
    label: "Web-safe, original size",
    imageDesc: "JPEG at the original dimensions — easier to share",
    videoDesc: "Original video (no server-side transcoding available)",
  },
  {
    id: "websafe-small",
    label: "Smaller size",
    imageDesc: "JPEG up to 1440p — ideal for messaging and social",
    videoDesc: "Original video (no server-side transcoding available)",
  },
];

const getImageShareUrl = (photo: PhotoItem, quality: ShareQuality): string => {
  if (quality === "original") return photo.originalUrl;
  const url = new URL(photo.originalUrl);
  url.searchParams.set("representation", "webSafe");
  if (quality === "websafe-small") url.searchParams.set("height", "1440");
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
  mode?: ShareAction;
  onClose: () => void;
  portalRoot?: Element | DocumentFragment | null;
};

export const ShareOptionsModal: React.FC<Props> = ({
  photos,
  mode = "share",
  onClose,
  portalRoot,
}) => {
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparedShare, setPreparedShare] = useState<PreparedShare | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const portalTarget = portalRoot ?? document.body;

  const images = photos.filter((p) => p.mediaType !== "video");
  const videos = photos.filter((p) => p.mediaType === "video");
  const hasVideos = videos.length > 0;
  const hasImages = images.length > 0;
  const actionLabel = mode === "download" ? "Download" : "Share";

  const triggerDownloads = (items: DownloadItem[]) => {
    for (const item of items) {
      triggerDownload(item.url, item.filename);
    }
  };

  const handlePreparedShare = async () => {
    if (!preparedShare || typeof navigator.share !== "function") return;

    setError(null);
    setProgress("Opening share sheet…");

    try {
      await navigator.share({ files: preparedShare.files });

      if (preparedShare.videoDownloads.length > 0) {
        triggerDownloads(preparedShare.videoDownloads);
      }

      onClose();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setProgress(null);
        return;
      }
      setError("Something went wrong. Please try again.");
      setProgress(null);
    }
  };

  const handleAction = async (quality: ShareQuality) => {
    setError(null);
    setPreparedShare(null);
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      if (mode === "download") {
        const itemsToDownload = [
          ...images.map((photo) => ({
            url: getImageShareUrl(photo, quality),
            filename: getImageFilename(photo, quality),
          })),
          ...videos.map((video) => ({
            url: video.originalUrl,
            filename: video.name,
          })),
        ];

        if (itemsToDownload.length > 0) {
          setProgress(
            itemsToDownload.length === 1
              ? "Starting download…"
              : `Starting ${itemsToDownload.length} downloads…`,
          );
        }

        for (const item of itemsToDownload) {
          if (abort.signal.aborted) return;
          triggerDownload(item.url, item.filename);
        }

        onClose();
        return;
      }

      setProgress("Preparing…");

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
        imageFiles.push(
          new File([blob], getImageFilename(photo, quality), { type: blob.type }),
        );
      }

      if (abort.signal.aborted) return;

      const videoDownloads = videos.map((video) => ({
        url: video.originalUrl,
        filename: video.name,
      }));
      const canUseNativeFileShare =
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: imageFiles });

      // Share or download images
      if (imageFiles.length > 0) {
        if (canUseNativeFileShare) {
          setPreparedShare({ files: imageFiles, videoDownloads });
          setProgress(null);
          return;
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
        triggerDownloads(videoDownloads);
      }

      onClose();
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || abort.signal.aborted))
        return;
      setError("Something went wrong. Please try again.");
      setProgress(null);
    }
  };

  const handleClose = () => {
    abortRef.current?.abort();
    setPreparedShare(null);
    onClose();
  };

  // Close on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const count = photos.length;
  const noun = count === 1 ? "item" : "items";

  const getDesc = (q: QualityDef) => {
    if (hasImages && hasVideos) return `${q.imageDesc} · ${q.videoDesc}`;
    if (hasVideos) return q.videoDesc;
    return q.imageDesc;
  };

  return createPortal(
    <div
      className={css.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
      role="presentation"
    >
      <div
        className={css.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={`${actionLabel} ${count} ${noun}`}
      >
        <div className={css.handle} />
        <h3 className={css.title}>
          {actionLabel} {count} {noun}
        </h3>

        {hasVideos && (
          <p className={css.videoNote}>
            {mode === "share"
              ? hasImages
                ? "Images will be shared via the system share sheet. Videos will be downloaded directly."
                : `Video${videos.length > 1 ? "s" : ""} will be downloaded directly — no server-side transcoding is available.`
              : hasImages
                ? "Image size changes apply to photos. Videos always download as the original file."
                : `Video${videos.length > 1 ? "s" : ""} will be downloaded as the original file — no server-side transcoding is available.`}
          </p>
        )}

        {progress ? (
          <div className={css.progress}>
            <div className={css.spinner} />
            {progress}
          </div>
        ) : preparedShare ? (
          <div className={css.readyState}>
            <p className={css.readyMessage}>
              Files are ready. Tap Share to open the system share sheet.
            </p>
            {preparedShare.videoDownloads.length > 0 && (
              <p className={css.readyNote}>
                Videos will still download as original files after sharing.
              </p>
            )}
            <div className={css.readyActions}>
              <button
                type="button"
                className="btn btn-subtle"
                onClick={() => {
                  setPreparedShare(null);
                  setError(null);
                }}
              >
                Back
              </button>
              <button type="button" className="btn" onClick={() => void handlePreparedShare()}>
                Share
              </button>
            </div>
          </div>
        ) : (
          <div className={css.options}>
            {QUALITIES.map((q) => (
              <button
                key={q.id}
                className={css.option}
                onClick={() => void handleAction(q.id)}
              >
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
    </div>,
    portalTarget,
  );
};
