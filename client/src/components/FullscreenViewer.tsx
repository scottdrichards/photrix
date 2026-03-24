import { useEffect, useRef, useState } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { Dismiss24Regular } from "@fluentui/react-icons";
import Hls from "hls.js";
import { probeVideoPlaybackProfile } from "../videoPlaybackProfile";
import { useSelectionContext } from "./selection/SelectionContext";

const SWIPE_THRESHOLD_PX = 60;

type DefaultLoader = InstanceType<typeof Hls.DefaultConfig.loader>;
type DefaultLoadArgs = Parameters<DefaultLoader["load"]>;

type HlsNetworkDetails = {
  xhr?: XMLHttpRequest;
};

type HlsMediaWithSource = HTMLMediaElement & {
  mediaSource?: MediaSource & { updating?: boolean };
};

const PRELIMINARY_RAW_TEST_BYTES = 12_000_000;

const isHevcCodec = (codec: unknown): boolean => {
  if (typeof codec !== "string") {
    return false;
  }

  const normalizedCodec = codec.toLowerCase();
  return normalizedCodec === "hevc" || normalizedCodec === "h265" || normalizedCodec === "x265";
};

const estimateBitrateMbps = (sizeInBytes: unknown, durationSeconds: unknown): number | null => {
  if (
    typeof sizeInBytes !== "number" ||
    !Number.isFinite(sizeInBytes) ||
    sizeInBytes <= 0 ||
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return null;
  }

  return (sizeInBytes * 8) / durationSeconds / 1_000_000;
};

const measureRawFileBandwidthMbps = async (
  rawVideoUrl: string,
): Promise<number | null> => {
  if (typeof fetch !== "function") {
    return null;
  }

  const startTime = performance.now();
  const response = await fetch(rawVideoUrl, {
    credentials: "include",
    cache: "no-store",
    headers: {
      Range: `bytes=0-${PRELIMINARY_RAW_TEST_BYTES - 1}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Raw bandwidth test failed (status ${response.status})`);
  }

  const payload = await response.blob();
  const elapsedMilliseconds = performance.now() - startTime;
  if (payload.size <= 0 || elapsedMilliseconds <= 0) {
    return null;
  }

  const bandwidthMbps = (payload.size * 8) / (elapsedMilliseconds / 1000) / 1_000_000;
  console.info("[Video] Preliminary raw-file bandwidth test", {
    rawVideoUrl,
    bandwidthMbps,
    bytesTransferred: payload.size,
    elapsedMilliseconds,
  });

  return bandwidthMbps;
};

const safePlay = (video: HTMLVideoElement, logPrefix: string) => {
  const playResult = video.play();
  if (playResult && typeof playResult.catch === "function") {
    playResult.catch((err) => {
      console.log(logPrefix, err);
    });
  }
};

const useStyles = makeStyles({
  dialog: {
    border: "none",
    padding: 0,
    backgroundColor: "transparent",
    maxWidth: "100vw",
    maxHeight: "100vh",
    width: "100%",
    height: "100%",
    "::backdrop": {
      backgroundColor: "rgba(0, 0, 0, 0.85)",
    },
    // Reset user agent styles
    margin: 0,
    overflow: "hidden",
  },
  container: {
    display: "flex",
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    zIndex: 1,
  },
  media: {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    display: "block",
  },
  closeButton: {
    position: "absolute",
    top: tokens.spacingVerticalM,
    right: tokens.spacingHorizontalM,
    color: tokens.colorNeutralForegroundInverted,
    zIndex: 100,
    ":hover": {
      color: tokens.colorNeutralForegroundInvertedHover,
      backgroundColor: "rgba(255, 255, 255, 0.1)",
    },
  },
});

export function FullscreenViewer() {
  const styles = useStyles();
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

    const loadSelectedPlayback = async () => {
      try {
        const playbackProfile = await probeVideoPlaybackProfile();
        if (cancelled) {
          return;
        }

        const estimatedBitrateMbps = estimateBitrateMbps(
          photo.metadata?.sizeInBytes,
          photo.metadata?.duration,
        );
        const codec = photo.metadata?.videoCodec;
        const isDirectPlaybackCandidate =
          playbackProfile.hevcSupported &&
          isHevcCodec(codec) &&
          typeof estimatedBitrateMbps === "number" &&
          Number.isFinite(estimatedBitrateMbps) &&
          photo.originalUrl.length > 0;

        let measuredRawBandwidthMbps: number | null = null;
        if (isDirectPlaybackCandidate) {
          measuredRawBandwidthMbps = await measureRawFileBandwidthMbps(photo.originalUrl);
          if (cancelled) {
            return;
          }
        }

        const shouldUseDirectPlayback =
          isDirectPlaybackCandidate &&
          typeof measuredRawBandwidthMbps === "number" &&
          Number.isFinite(measuredRawBandwidthMbps) &&
          typeof estimatedBitrateMbps === "number" &&
          estimatedBitrateMbps <= measuredRawBandwidthMbps * 0.75;

        console.info("[Video] Client playback decision", {
          path: photo.path,
          playbackProfile,
          estimatedBitrateMbps,
          codec,
          measuredRawBandwidthMbps,
          isDirectPlaybackCandidate,
          shouldUseDirectPlayback,
        });

        if (shouldUseDirectPlayback) {
          video.src = photo.originalUrl;
          safePlay(video, "[Video] Autoplay prevented (direct):");
          return;
        }

        if (!photo.hlsUrl) {
          video.src = photo.fullUrl;
          return;
        }

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
                  console.log("[HLS] Got server duration:", serverDuration);
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

          hls.loadSource(photo.hlsUrl);
          hls.attachMedia(video);

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
              console.error("[HLS] Fatal error:", data.type, data.details);
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
          video.src = photo.hlsUrl;
          safePlay(video, "[HLS] Autoplay prevented (native):");
          return;
        }

        video.src = photo.fullUrl;
      } catch (error) {
        console.error("[Video] Failed to resolve playback plan", {
          path: photo.path,
          error,
        });
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

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      onClose={handleClose}
      onCancel={handleClose}
      onClick={handleBackdropClick}
    >
      {photo && (
        <>
          <Button
            appearance="subtle"
            icon={<Dismiss24Regular />}
            onClick={() => setSelected(null)}
            className={styles.closeButton}
            aria-label="Close"
            size="large"
          />
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
          <div
            className={styles.container}
            onClick={handleContainerClick}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            {photo.mediaType === "video" ? (
              <video
                ref={videoRef}
                key={photo.path}
                controls
                className={styles.media}
                poster={photo.previewUrl}
                preload="metadata"
              >
                <track kind="captions" src="data:," label="Captions not provided" />
                Your browser does not support HTML video playback.
              </video>
            ) : (
              <img src={photo.fullUrl} alt={photo.name} className={styles.media} />
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
