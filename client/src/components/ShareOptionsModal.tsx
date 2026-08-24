import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PhotoItem } from "../api";
import css from "./ShareOptionsModal.module.css";

type ShareQuality = "original" | "websafe-full" | "websafe-small";
type ShareAction = "share" | "download";
type DownloadItem = { url: string; filename: string };
type PreparedAction =
  | { kind: "share"; files: File[] }
  | { kind: "download"; imageFiles: File[]; videoDownloads: DownloadItem[] };

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
};

const getVideoMimeType = (photo: PhotoItem): string => {
  const ext = photo.name.split(".").pop()?.toLowerCase() ?? "";
  return photo.metadata?.mimeType ?? VIDEO_MIME_BY_EXT[ext] ?? "video/mp4";
};

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
      onClose();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setProgress(null);
        return;
      }
      // Sharing failed after files were already prepared — fall back to
      // download using the same already-fetched image bytes; videos go via
      // their original URL rather than re-using the fetched share blobs, to
      // keep the download path independent of what sharing happened to fetch.
      const imageFiles = preparedAction.files.filter((f) => !f.type.startsWith("video/"));
      const videoDownloads = videos.map((video) => ({
        url: video.originalUrl,
        filename: video.name,
      }));
      setPreparedAction({ kind: "download", imageFiles, videoDownloads });
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

      const hasNativeShare = typeof navigator.share === "function";
      const shouldTryOriginalHeicShare =
        hasNativeShare && images.some((photo) => isHeicLikeOriginal(photo, quality));

      // Check whether the OS can share these file types at all *before*
      // fetching potentially gigabyte-sized video bytes into memory for
      // nothing — probe with zero-byte placeholder files of the right type.
      const dummyVideoFiles = videos.map(
        (video) => new File([""], video.name, { type: getVideoMimeType(video) }),
      );
      const probeFiles = [...imageFiles, ...dummyVideoFiles];
      const canShareFiles =
        hasNativeShare &&
        (shouldTryOriginalHeicShare ||
          typeof navigator.canShare !== "function" ||
          navigator.canShare({ files: probeFiles }));

      if (canShareFiles) {
        // Videos: fetch the real file too, same as images, so the share
        // sheet gets the actual video — only reached once canShareFiles
        // confirms the OS can use it, so an unsupported device never pays
        // for the full download.
        const videoFiles: File[] = [];
        for (let i = 0; i < videos.length; i++) {
          if (abort.signal.aborted) return;
          const video = videos[i];
          setProgress(
            videos.length > 1
              ? `Preparing video ${i + 1} of ${videos.length}…`
              : "Preparing video…",
          );
          const response = await fetch(video.originalUrl, { signal: abort.signal });
          if (!response.ok) throw new Error(`Failed to fetch ${video.name}`);
          const blob = await response.blob();
          videoFiles.push(
            new File([blob], video.name, { type: blob.type || getVideoMimeType(video) }),
          );
        }

        if (abort.signal.aborted) return;

        const allFiles = [...imageFiles, ...videoFiles];
        if (allFiles.length > 0) {
          // Native file share is gesture-sensitive, so after any async
          // prepare step we defer the real browser action to a second
          // explicit tap.
          setPreparedAction({ kind: "share", files: allFiles });
          setProgress(null);
          return;
        }
      }

      // Can't (or don't need to) share files — fall back to the download
      // flow, still gated behind an explicit second tap so a long prepare
      // step can't sever the eventual save action from user intent. Videos
      // never blob-load here (they can be gigabytes); the browser downloads
      // them directly from their original URL.
      if (imageFiles.length > 0 || videos.length > 0) {
        setPreparedAction({
          kind: "download",
          imageFiles,
          videoDownloads: videos.map((video) => ({
            url: video.originalUrl,
            filename: video.name,
          })),
        });
        setProgress(null);
        return;
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
              ? "Everything is shared via the system share sheet as the real file (falls back to downloading if your device can't share it directly)."
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
