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

    // Check if HLS.js is supported
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
      });

      hls.loadSource(photo.hlsUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch((err) => {
          console.log("[HLS] Autoplay prevented:", err);
        });
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.error("[HLS] Fatal error:", data.type, data.details);
          // Fall back to direct source
          if (photo.fullUrl) {
            video.src = photo.fullUrl;
            video.play().catch(() => {});
          }
        }
      });

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
