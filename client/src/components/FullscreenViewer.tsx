import { useEffect, useRef } from "react";
import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { Dismiss24Regular } from "@fluentui/react-icons";
import Hls from "hls.js";
import type { PhotoItem } from "../api";

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

export interface FullscreenViewerProps {
  photo: PhotoItem | null;
  onDismiss: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
}

export function FullscreenViewer({
  photo,
  onDismiss,
  onNext,
  onPrevious,
}: FullscreenViewerProps) {
  const styles = useStyles();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  // HLS setup effect
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !photo || photo.mediaType !== "video" || !photo.hlsUrl) return;

    // Clean up previous HLS instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    // Get the known duration from metadata (for progressive HLS)
    const knownDuration = photo.metadata?.duration as number | undefined;

    // Custom loader to capture duration header
    let serverDuration: number | undefined;
    
    class DurationCapturingLoader extends Hls.DefaultConfig.loader {
      load(context: any, config: any, callbacks: any) {
        const originalOnSuccess = callbacks.onSuccess;
        callbacks.onSuccess = (response: any, stats: any, context: any, networkDetails: any) => {
          // Check for X-Content-Duration header on manifest requests
          if (context.type === "manifest" && networkDetails?.xhr) {
            const durationHeader = networkDetails.xhr.getResponseHeader("X-Content-Duration");
            if (durationHeader) {
              serverDuration = parseFloat(durationHeader);
              console.log("[HLS] Got server duration:", serverDuration);
            }
          }
          originalOnSuccess(response, stats, context, networkDetails);
        };
        super.load(context, config, callbacks);
      }
    }

    // Check if HLS.js is supported
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        loader: DurationCapturingLoader,
        // Buffering settings for smooth playback during live encoding
        maxBufferLength: 30, // Buffer up to 30 seconds
        maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1000 * 1000, // 60MB buffer
        maxBufferHole: 0.5,
        // Live/EVENT playlist settings
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: Infinity, // Don't limit for EVENT playlists
        levelLoadingTimeOut: 20000, // Longer timeout for slow encoding
        manifestLoadingTimeOut: 20000,
        levelLoadingRetryDelay: 1000,
      });

      hls.loadSource(photo.hlsUrl);
      hls.attachMedia(video);

      // Intercept duration to show correct total time
      const getDuration = () => serverDuration ?? knownDuration ?? video.duration;
      
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch((err) => {
          console.log("[HLS] Autoplay prevented:", err);
        });
      });

      // Poll and update duration display when we have server duration
      const durationInterval = setInterval(() => {
        const dur = getDuration();
        if (dur && Number.isFinite(dur) && dur > 0) {
          // Dispatch a custom event that updates the duration display
          // or we can try to set the duration on media source
          if (hls.media && hls.media.duration !== dur) {
            try {
              // MediaSource duration can be set if the source is open
              const mediaSource = (hls as any).media?.mediaSource;
              if (mediaSource && mediaSource.readyState === "open" && !mediaSource.updating) {
                mediaSource.duration = dur;
              }
            } catch {
              // Ignore - duration setting may not be allowed
            }
          }
        }
      }, 1000);

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.error("[HLS] Fatal error:", data.type, data.details);
          clearInterval(durationInterval);
          // Fall back to direct source
          if (photo.fullUrl) {
            video.src = photo.fullUrl;
            video.play().catch(() => {});
          }
        }
      });

      // Store interval for cleanup
      (hls as any)._durationInterval = durationInterval;

      hlsRef.current = hls;
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Native HLS support (Safari)
      video.src = photo.hlsUrl;
      video.play().catch((err) => {
        console.log("[HLS] Autoplay prevented (native):", err);
      });
    } else {
      // Fall back to direct MP4
      video.src = photo.fullUrl;
    }

    return () => {
      if (hlsRef.current) {
        // Clean up duration interval
        const interval = (hlsRef.current as any)._durationInterval;
        if (interval) clearInterval(interval);
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
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
      ArrowRight: onNext,
      ArrowLeft: onPrevious,
      Escape: onDismiss,
    } as const satisfies Record<KeyboardEvent["key"], (() => void) | undefined>;

    const handleKeyDown = (e: KeyboardEvent) => operations[e.key as keyof typeof operations]?.();

    window.addEventListener("keydown", handleKeyDown);
    
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [photo, onNext, onPrevious, onDismiss]);

  const handleClose = () => {
    onDismiss();
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) {
      onDismiss();
    }
  };

  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onDismiss();
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      onClose={handleClose}
      onClick={handleBackdropClick}
    >
      {photo && (
        <>
          <Button
            appearance="subtle"
            icon={<Dismiss24Regular />}
            onClick={onDismiss}
            className={styles.closeButton}
            aria-label="Close"
            size="large"
          />
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
          <div className={styles.container} onClick={handleContainerClick}>
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
