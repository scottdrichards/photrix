import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PhotoItem } from "../../api";
import css from "./ShareOptionsModal.module.css";
import { logFailure } from "../../logFailure";
import { attempt } from "../../result";
import { mintShareLink } from "../../api/share";
import { ShareLinkModal } from "./ShareLinkModal";
import { fitsOneShare, WEB_SHARE_MAX_FILES } from "./webShareLimits";

type ShareQuality = "original" | "websafe-full" | "websafe-small";
type ShareAction = "share" | "download";
type DownloadItem = { url: string; filename: string };
type PreparedAction =
  | { kind: "share"; files: File[]; quality: ShareQuality }
  // Too many files or bytes for one share sheet: offer a link or a download.
  | { kind: "overLimit"; quality: ShareQuality }
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
    videoDesc: "MP4 up to 1080p — plays on any phone or computer",
  },
  {
    id: "websafe-small",
    label: "Smaller size",
    imageDesc: "JPEG up to 1440p — ideal for messaging and social",
    videoDesc: "MP4 at 720p — small enough for messaging",
  },
];

// Mirrors filesRequestHandler.ts's `needsFormatChange` check server-side —
// these are the only source formats that `representation=webSafe` actually
// re-encodes. Anything else (JPEG/PNG/WebP/GIF/...) is already web-safe, so
// offering a "web-safe" copy of it would just be a no-op download.
const NON_WEB_SAFE_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/x-canon-cr3",
]);

// Below this, "smaller size" wouldn't meaningfully help sharing/messaging,
// so there's no point offering it. Unknown size errs toward still offering
// it rather than silently hiding a potentially-useful option.
const SMALL_ENOUGH_BYTES = 20 * 1024 * 1024;

const isAlreadyWebSafe = (photo: PhotoItem): boolean => {
  const mime = photo.metadata?.mimeType;
  if (!mime) return false;
  return !NON_WEB_SAFE_MIME_TYPES.has(mime);
};

const isSmallEnough = (photo: PhotoItem): boolean => {
  const size = photo.metadata?.sizeInBytes;
  if (size == null) return false;
  return size < SMALL_ENOUGH_BYTES;
};

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

// Videos: "original" is the stored file; the web-safe tiers are an H.264 MP4
// the server encodes on request (representation=shareMp4) at a 1080p or 720p
// short side, so a 4K HEVC clip becomes something any phone or chat app takes.
const VIDEO_SHARE_SIZE: Record<Exclude<ShareQuality, "original">, string> = {
  "websafe-full": "1080",
  "websafe-small": "720",
};

const getVideoShareUrl = (video: PhotoItem, quality: ShareQuality): string => {
  if (quality === "original") return video.originalUrl;
  const url = new URL(video.originalUrl);
  url.searchParams.set("representation", "shareMp4");
  url.searchParams.set("size", VIDEO_SHARE_SIZE[quality]);
  return url.toString();
};

const getVideoShareFilename = (video: PhotoItem, quality: ShareQuality): string =>
  quality === "original" ? video.name : `${video.name.replace(/\.[^.]+$/, "")}.mp4`;

const getVideoShareMimeType = (video: PhotoItem, quality: ShareQuality): string =>
  quality === "original" ? getVideoMimeType(video) : "video/mp4";

const getVideoDownloads = (videos: PhotoItem[], quality: ShareQuality): DownloadItem[] =>
  videos.map((video) => ({
    url: getVideoShareUrl(video, quality),
    filename: getVideoShareFilename(video, quality),
  }));

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
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const portalTarget = portalRoot ?? document.body;

  const images = photos.filter((p) => p.mediaType !== "video");
  const videos = photos.filter((p) => p.mediaType === "video");
  const hasVideos = videos.length > 0;
  const hasImages = images.length > 0;
  const actionLabel = mode === "download" ? "Download" : "Share";

  // Only offer a quality tier if it would change at least one selected
  // image's output — e.g. don't offer "web-safe" for an already-JPEG photo,
  // and don't offer "smaller size" when every image is already small.
  // Any video keeps both tiers available: each is a real converted MP4.
  const showWebSafeFull =
    !hasImages || hasVideos || images.some((p) => !isAlreadyWebSafe(p));
  const showWebSafeSmall =
    !hasImages || hasVideos || images.some((p) => !isSmallEnough(p));
  const visibleQualities = QUALITIES.filter((q) => {
    if (q.id === "websafe-full") return showWebSafeFull;
    if (q.id === "websafe-small") return showWebSafeSmall;
    return true;
  });

  const triggerDownloads = (items: DownloadItem[]) => {
    for (const item of items) {
      triggerDownload(item.url, item.filename);
    }
  };

  // Offer `files` as a download instead: images from the bytes already fetched,
  // videos from their URL, so the download never depends on the share blobs.
  const downloadInstead = (files: File[], quality: ShareQuality, message: string) => {
    const names = new Set(files.map((file) => file.name));
    setPreparedAction({
      kind: "download",
      imageFiles: files.filter((file) => !file.type.startsWith("video/")),
      videoDownloads: getVideoDownloads(
        videos.filter((video) => names.has(getVideoShareFilename(video, quality))),
        quality,
      ),
    });
    setError(message);
    setProgress(null);
  };

  // Download straight from each file's URL: nothing is fetched into memory.
  const downloadFromUrls = (quality: ShareQuality, signal?: AbortSignal) => {
    const itemsToDownload = [
      ...images.map((photo) => ({
        url: getImageShareUrl(photo, quality),
        filename: getImageFilename(photo, quality),
      })),
      ...getVideoDownloads(videos, quality),
    ];
    for (const item of itemsToDownload) {
      if (signal?.aborted) return;
      triggerDownload(item.url, item.filename);
    }
  };

  // A link to exactly these files, for a selection too big to share as files.
  const shareAsLink = async () => {
    setError(null);
    setProgress("Creating link…");
    const result = await attempt(
      mintShareLink({ filter: { relativePath: photos.map((photo) => photo.path) } }),
    );
    setProgress(null);
    if (!result.ok) {
      logFailure("share.selectionLink.failed", "Could not create a link to the selection")(
        result.error,
      );
      setError("Couldn't create a link. Try Download instead.");
      return;
    }
    setLinkUrl(result.value);
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

    if (preparedAction.kind === "overLimit") {
      downloadFromUrls(preparedAction.quality);
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
      downloadInstead(
        preparedAction.files,
        preparedAction.quality,
        "Sharing failed on this browser. The files are ready to download instead.",
      );
    }
  };

  const handleAction = async (quality: ShareQuality) => {
    setError(null);
    setPreparedAction(null);
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      if (mode === "download") {
        if (photos.length > 0) {
          setProgress(
            photos.length === 1 ? "Starting download…" : `Starting ${photos.length} downloads…`,
          );
        }
        downloadFromUrls(quality, abort.signal);
        onClose();
        return;
      }

      // Over the browser's share limit before anything is fetched: by count, or
      // for originals by their stored size. Offer a link or a download instead
      // of fetching everything only for the share to be refused.
      const knownSizes = photos.map((photo) =>
        quality === "original" ? photo.metadata?.sizeInBytes : undefined,
      );
      if (!fitsOneShare(knownSizes)) {
        setPreparedAction({ kind: "overLimit", quality });
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
        (video) =>
          new File([""], getVideoShareFilename(video, quality), {
            type: getVideoShareMimeType(video, quality),
          }),
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
          // A converted video is encoded on request, which takes a while
          // for a long clip — say so rather than look stuck.
          const verb = quality === "original" ? "Preparing" : "Converting";
          setProgress(
            videos.length > 1
              ? `${verb} video ${i + 1} of ${videos.length}…`
              : `${verb} video…`,
          );
          const response = await fetch(getVideoShareUrl(video, quality), {
            signal: abort.signal,
          });
          if (!response.ok) throw new Error(`Failed to fetch ${video.name}`);
          const blob = await response.blob();
          videoFiles.push(
            new File([blob], getVideoShareFilename(video, quality), {
              type: blob.type || getVideoShareMimeType(video, quality),
            }),
          );
        }

        if (abort.signal.aborted) return;

        const allFiles = [...imageFiles, ...videoFiles];
        if (allFiles.length > 0) {
          // Native file share is gesture-sensitive, so after any async
          // prepare step we defer the real browser action to a second
          // explicit tap.
          // Converted sizes are only known now.
          if (!fitsOneShare(allFiles.map((file) => file.size))) {
            setPreparedAction({ kind: "overLimit", quality });
            setProgress(null);
            return;
          }
          setPreparedAction({ kind: "share", files: allFiles, quality });
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
          videoDownloads: getVideoDownloads(videos, quality),
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

  if (linkUrl) {
    return <ShareLinkModal url={linkUrl} copied={false} onClose={onClose} portalRoot={portalRoot} />;
  }

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
              : "Web-safe and smaller videos are converted to MP4 first, which can take a minute for a long clip."}
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
                : preparedAction.kind === "overLimit"
                  ? `Too much to share as files: the share sheet takes at most ${WEB_SHARE_MAX_FILES} files or 50 MB. Share a link to ${count === 1 ? "it" : `these ${count}`} instead, or download ${count === 1 ? "it" : "them"}.`
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
              {preparedAction.kind === "overLimit" ? (
                <>
                  <button type="button" className="btn btn-subtle" onClick={() => void handlePreparedAction()}>
                    Download
                  </button>
                  <button type="button" className="btn" onClick={() => void shareAsLink()}>
                    Share link
                  </button>
                </>
              ) : (
                <button type="button" className="btn" onClick={() => void handlePreparedAction()}>
                  {preparedAction.kind === "share" ? "Share" : "Download"}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className={css.options}>
            {visibleQualities.map((q) => (
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
