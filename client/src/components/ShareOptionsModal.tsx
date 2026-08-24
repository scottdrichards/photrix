import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PhotoItem } from "../api";
import css from "./ShareOptionsModal.module.css";

type ShareQuality = "original" | "websafe-full" | "websafe-small";
type ShareAction = "share" | "download";
type DownloadItem = { url: string; filename: string };
type PreparedAction =
  | { kind: "share"; files: File[]; videoDownloads: DownloadItem[] }
  | { kind: "download"; imageFiles: File[]; videoDownloads: DownloadItem[] };

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

const isHeicLikeOriginal = (photo: PhotoItem, quality: ShareQuality): boolean =>
  quality === "original" && /\.(heic|heif)$/i.test(photo.name);

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
  const [preparedAction, setPreparedAction] = useState<PreparedAction | null>(null);
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

  const handlePreparedAction = async () => {
    if (!preparedAction) return;

    setError(null);

    if (preparedAction.kind === "download") {
      for (const file of preparedAction.imageFiles) {
        const objectUrl = URL.createObjectURL(file);
        triggerDownload(objectUrl, file.name);
        URL.revokeObjectURL(objectUrl);
      }

      if (preparedAction.videoDownloads.length > 0) {
        triggerDownloads(preparedAction.videoDownloads);
      }

      onClose();
      return;
    }

    if (typeof navigator.share !== "function") return;

    setProgress("Opening share sheet…");

    try {
      await navigator.share({ files: preparedAction.files });

      if (preparedAction.videoDownloads.length > 0) {
        triggerDownloads(preparedAction.videoDownloads);
      }

      onClose();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setProgress(null);
        return;
      }
      setPreparedAction({
        kind: "download",
        imageFiles: preparedAction.files,
        videoDownloads: preparedAction.videoDownloads,
      });
      setError("Sharing failed on this browser. The files are ready to download instead.");
      setProgress(null);
    }
  };

  const handleAction = async (quality: ShareQuality) => {
    setError(null);
    setPreparedAction(null);
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
      const hasNativeShare = typeof navigator.share === "function";
      const canUseNativeFileShare =
        hasNativeShare &&
        (typeof navigator.canShare !== "function" || navigator.canShare({ files: imageFiles }));
      const shouldTryOriginalHeicShare =
        hasNativeShare && images.some((photo) => isHeicLikeOriginal(photo, quality));

      // Native file share is gesture-sensitive, so after any async prepare
      // step we defer the real browser action to a second explicit tap. Use the
      // same flow for the download fallback so a long conversion cannot sever
      // the eventual save action from user intent.
      if (imageFiles.length > 0) {
        setPreparedAction(
          canUseNativeFileShare || shouldTryOriginalHeicShare
            ? { kind: "share", files: imageFiles, videoDownloads }
            : { kind: "download", imageFiles, videoDownloads },
        );
        setProgress(null);
        return;
      }

      // Videos: never blob-load (they can be gigabytes) — but in share mode,
      // still try navigator.share with just a URL so the OS share sheet opens
      // instead of silently downloading. Only fall back to a direct download
      // when the Web Share API isn't available at all.
      if (videos.length > 0) {
        if (mode === "share" && imageFiles.length === 0 && typeof navigator.share === "function") {
          setProgress("Opening share sheet…");
          try {
            if (videos.length === 1) {
              await navigator.share({ url: videos[0].originalUrl, title: videos[0].name });
            } else {
              await navigator.share({
                text: videos.map((v) => v.originalUrl).join("\n"),
              });
            }
            onClose();
            return;
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
              setProgress(null);
              return;
            }
            // Web Share failed for a reason other than user cancel — fall back to download.
          }
        }

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
    setPreparedAction(null);
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
                : `Video${videos.length > 1 ? "s" : ""} will open the system share sheet as a link (falls back to downloading if sharing isn't supported).`
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
        ) : preparedAction ? (
          <div className={css.readyState}>
            <p className={css.readyMessage}>
              {preparedAction.kind === "share"
                ? "Files are ready. Tap Share to open the system share sheet."
                : "Files are ready. Tap Download to save them."}
            </p>
            {preparedAction.videoDownloads.length > 0 && (
              <p className={css.readyNote}>
                {preparedAction.kind === "share"
                  ? "Videos will still download as original files after sharing."
                  : "Videos will download as original files."}
              </p>
            )}
            <div className={css.readyActions}>
              <button
                type="button"
                className="btn btn-subtle"
                onClick={() => {
                  setPreparedAction(null);
                  setError(null);
                }}
              >
                Back
              </button>
              <button type="button" className="btn" onClick={() => void handlePreparedAction()}>
                {preparedAction.kind === "share" ? "Share" : "Download"}
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
