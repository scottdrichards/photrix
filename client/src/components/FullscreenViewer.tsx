import { useEffect, useRef, useState } from "react";
import { Film, X } from "lucide-react";
import Hls from "hls.js";
import { probeVideoPlaybackProfile } from "../videoPlaybackProfile";
import { negotiateVideoPlayback } from "../api";
import { useSelectionContext } from "./selection/SelectionContext";
import css from "./FullscreenViewer.module.css";

const SWIPE_THRESHOLD_PX = 60;
const PHOTO_ZOOM_DEFAULT_SCALE = 2.5;
const PHOTO_ZOOM_MIN_SCALE = 1;
const PHOTO_ZOOM_MAX_SCALE = 6;
const PHOTO_ZOOM_STEP = 0.25;

type DefaultLoader = InstanceType<typeof Hls.DefaultConfig.loader>;
type DefaultLoadArgs = Parameters<DefaultLoader["load"]>;

type HlsNetworkDetails = {
  xhr?: XMLHttpRequest;
};

type HlsMediaWithSource = HTMLMediaElement & {
  mediaSource?: MediaSource & { updating?: boolean };
};

const safePlay = (video: HTMLVideoElement, logPrefix: string) => {
  const playResult = video.play();
  if (playResult && typeof playResult.catch === "function") {
    playResult.catch((err) => {
    });
  }
};

type VideoStatus = "hls" | "direct" | "incompatible" | null;

const videoStatusLabel: Record<NonNullable<VideoStatus>, string> = {
  hls: "HLS",
  direct: "Raw Video",
  incompatible: "No Compatible Stream",
};

export function FullscreenViewer() {
  const {
    selected: selectedPhoto,
    selectionMode,
    setSelected,
    selectNext,
    selectPrevious,
  } = useSelectionContext();
  const photo = selectionMode ? null : selectedPhoto;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const durationIntervalRef = useRef<number | null>(null);
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
  const [videoStatus, setVideoStatus] = useState<VideoStatus>(null);
  const [videoAspectRatio, setVideoAspectRatio] = useState<number | null>(null);
  const [showLiveVideo, setShowLiveVideo] = useState(false);
  const [photoZoom, setPhotoZoom] = useState({
    isZoomed: false,
    originXPercent: 50,
    originYPercent: 50,
    scale: PHOTO_ZOOM_DEFAULT_SCALE,
  });

  useEffect(() => {
    setShowLiveVideo(false);
    setPhotoZoom({
      isZoomed: false,
      originXPercent: 50,
      originYPercent: 50,
      scale: PHOTO_ZOOM_DEFAULT_SCALE,
    });
  }, [photo?.path]);

  // HLS setup effect
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !photo || photo.mediaType !== "video") return;

    let cancelled = false;

    const destroyHls = () => {
      if (durationIntervalRef.current !== null) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };

    // Clean up previous HLS instance
    destroyHls();
    setVideoStatus(null);
    setVideoAspectRatio(null);

    const loadSelectedPlayback = async () => {
      try {
        const playbackProfile = await probeVideoPlaybackProfile();
        if (cancelled) return;

        const negotiation = await negotiateVideoPlayback({
          path: photo.path,
          bandwidthMbps: playbackProfile.bandwidthMbps,
          hevcSupported: playbackProfile.hevcSupported,
        });
        if (cancelled) return;

        if (negotiation.mode === "error") {
          if (!cancelled) setVideoStatus("incompatible");
          // Fall back to full-res web-safe MP4 as last resort
          video.src = photo.fullUrl;
          return;
        }

        if (negotiation.mode === "direct") {
          if (!cancelled) setVideoStatus("direct");
          video.src = negotiation.url;
          safePlay(video, "[Video] Autoplay prevented (direct):");
          return;
        }

        // mode === "hls"
        const hlsUrl = negotiation.url;

        const nativeHlsSupport = video.canPlayType("application/vnd.apple.mpegurl");
        const hlsJsSupported = Hls.isSupported();

        // Get the known duration from metadata (for progressive HLS)
        const rawDuration = photo.metadata?.duration;
        const knownDuration =
          typeof rawDuration === "number" && Number.isFinite(rawDuration)
            ? rawDuration
            : undefined;

        // Custom loader to capture duration header
        let serverDuration: number | undefined;

        class DurationCapturingLoader extends Hls.DefaultConfig.loader {
          load(...args: DefaultLoadArgs) {
            const [context, config, callbacks] = args;
            const originalOnSuccess = callbacks.onSuccess;
            callbacks.onSuccess = (...onSuccessArgs) => {
              const [, , callbackContext, networkDetails] = onSuccessArgs;
              const details =
                typeof networkDetails === "object" && networkDetails !== null
                  ? (networkDetails as HlsNetworkDetails)
                  : undefined;
              const requestType =
                typeof callbackContext === "object" && callbackContext !== null
                  ? (callbackContext as { type?: string }).type
                  : undefined;

              if (requestType === "manifest" && details?.xhr) {
                const durationHeader = details.xhr.getResponseHeader("X-Content-Duration");
                if (durationHeader) {
                  serverDuration = parseFloat(durationHeader);
                }
              }
              originalOnSuccess(...onSuccessArgs);
            };
            super.load(context, config, callbacks);
          }
        }

        if (hlsJsSupported) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            loader: DurationCapturingLoader,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferSize: 60 * 1000 * 1000,
            maxBufferHole: 0.5,
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: Infinity,
            levelLoadingTimeOut: 20000,
            manifestLoadingTimeOut: 20000,
            levelLoadingRetryDelay: 1000,
          });

          hls.loadSource(hlsUrl);
          hls.attachMedia(video);
          if (!cancelled) setVideoStatus("hls");

          const getDuration = () => serverDuration ?? knownDuration ?? video.duration;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            safePlay(video, "[HLS] Autoplay prevented:");
          });

          const durationInterval = setInterval(() => {
            const dur = getDuration();
            if (dur && Number.isFinite(dur) && dur > 0 && hls.media && hls.media.duration !== dur) {
              try {
                const media = hls.media as HlsMediaWithSource | null;
                const mediaSource = media?.mediaSource;
                if (
                  mediaSource &&
                  mediaSource.readyState === "open" &&
                  !mediaSource.updating
                ) {
                  mediaSource.duration = dur;
                }
              } catch {
                // Ignore - duration setting may not be allowed
              }
            }
          }, 1000);

          hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
              clearInterval(durationInterval);
              if (photo.fullUrl) {
                video.src = photo.fullUrl;
                safePlay(video, "[HLS] Autoplay prevented (fallback):");
              }
            }
          });

          durationIntervalRef.current = durationInterval;
          hlsRef.current = hls;
          return;
        }

        if (nativeHlsSupport) {
          if (!cancelled) setVideoStatus("hls");
          video.src = hlsUrl;
          safePlay(video, "[HLS] Autoplay prevented (native):");
          return;
        }

        video.src = photo.fullUrl;
      } catch (error) {
        video.src = photo.fullUrl;
        safePlay(video, "[Video] Autoplay prevented (fallback):");
      }
    };

    void loadSelectedPlayback();

    return () => {
      cancelled = true;
      destroyHls();
    };
  }, [photo]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (photo && !dialog.open) {
      dialog.showModal();
    } else if (!photo && dialog.open) {
      dialog.close();
    }
  }, [photo]);

  useEffect(() => {
    if (!photo) return;
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.scrollbarGutter = "unset";
    return () => {
      document.documentElement.style.overflow = "";
      document.documentElement.style.scrollbarGutter = "";
    };
  }, [photo]);

  useEffect(() => {
    if (!photo) return;

    const operations = {
      ArrowRight: selectNext,
      ArrowLeft: selectPrevious,
      Escape: () => setSelected(null),
    } as const satisfies Record<KeyboardEvent["key"], (() => void) | undefined>;

    const handleKeyDown = (e: KeyboardEvent) => {
      const operation = operations[e.key as keyof typeof operations];
      if (!operation) return;

      e.preventDefault();
      operation();
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [photo, selectNext, selectPrevious, setSelected]);

  const handleClose = () => {
    setSelected(null);
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) {
      setSelected(null);
    }
  };

  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      setSelected(null);
    }
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.changedTouches[0];
    setTouchStart({ x: touch.clientX, y: touch.clientY });
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!touchStart) {
      return;
    }

    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = touch.clientY - touchStart.y;
    setTouchStart(null);

    const isHorizontalSwipe = Math.abs(deltaX) > Math.abs(deltaY);
    if (!isHorizontalSwipe || Math.abs(deltaX) < SWIPE_THRESHOLD_PX) {
      return;
    }

    if (deltaX < 0) {
      selectNext();
      return;
    }

    selectPrevious();
  };

  const handlePhotoClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (photoZoom.isZoomed) {
      setPhotoZoom((current) => ({ ...current, isZoomed: false }));
      return;
    }

    const bounds = e.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) {
      return;
    }

    const originXPercent = ((e.clientX - bounds.left) / bounds.width) * 100;
    const originYPercent = ((e.clientY - bounds.top) / bounds.height) * 100;

    setPhotoZoom({
      isZoomed: true,
      originXPercent: Math.min(Math.max(originXPercent, 0), 100),
      originYPercent: Math.min(Math.max(originYPercent, 0), 100),
      scale: PHOTO_ZOOM_DEFAULT_SCALE,
    });
  };

  const handlePhotoWheel = (e: React.WheelEvent<HTMLImageElement>) => {
    if (!photoZoom.isZoomed) {
      return;
    }

    setPhotoZoom((current) => {
      const direction = e.deltaY < 0 ? 1 : -1;
      const nextScale = Math.min(
        PHOTO_ZOOM_MAX_SCALE,
        Math.max(PHOTO_ZOOM_MIN_SCALE, current.scale + direction * PHOTO_ZOOM_STEP),
      );
      return {
        ...current,
        scale: nextScale,
        isZoomed: nextScale > PHOTO_ZOOM_MIN_SCALE,
      };
    });
  };

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialogRef}
      className={css.dialog}
      onClose={handleClose}
      onCancel={handleClose}
      onClick={handleBackdropClick}
    >
      {photo && (
        <>
          <button
            onClick={() => setSelected(null)}
            className={css.closeButton}
            aria-label="Close"
          >
            <X size={24} />
          </button>
                    {photo.mediaType !== "video" && photo.livePhotoUrl && (
                      <button
                        type="button"
                        onClick={() => setShowLiveVideo((v) => !v)}
                        className={css.livePhotoButton}
                        aria-label={showLiveVideo ? "Show photo" : "Play live photo"}
                        title={showLiveVideo ? "Show photo" : "Play live photo"}
                      >
                        <Film size={20} />
                      </button>
                    )}
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
          <div
            className={css.container}
            onClick={handleContainerClick}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            {photo.mediaType === "video" ? (
              <>
                <div
                  className={css.videoWrapper}
                  style={videoAspectRatio ? { aspectRatio: videoAspectRatio } : undefined}
                >
                  <video
                    ref={videoRef}
                    key={photo.path}
                    controls
                    className={css.videoMedia}
                    poster={photo.previewUrl}
                    preload="metadata"
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget;
                      if (v.videoWidth && v.videoHeight) {
                        setVideoAspectRatio(v.videoWidth / v.videoHeight);
                      }
                    }}
                  >
                    <track kind="captions" src="data:," label="Captions not provided" />
                    Your browser does not support HTML video playback.
                  </video>
                </div>
                {videoStatus && (
                  <span className={css.videoBadge} data-testid="video-status">
                    {videoStatusLabel[videoStatus]}
                  </span>
                )}
              </>
            ) : showLiveVideo && photo.livePhotoUrl ? (
               
              <video
                key={photo.livePhotoUrl}
                src={photo.livePhotoUrl}
                autoPlay
                loop
                playsInline
                muted
                className={css.media}
              />
            ) : (
              <img
                src={photo.fullUrl}
                alt={photo.name}
                className={`${css.media} ${css.zoomableMedia} ${photoZoom.isZoomed ? css.zoomedMedia : ""}`}
                onClick={handlePhotoClick}
                onWheel={handlePhotoWheel}
                style={
                  {
                    "--zoom-origin-x": `${photoZoom.originXPercent}%`,
                    "--zoom-origin-y": `${photoZoom.originYPercent}%`,
                    "--zoom-scale": photoZoom.scale.toString(),
                  } as React.CSSProperties
                }
              />
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
