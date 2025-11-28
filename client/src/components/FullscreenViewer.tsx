import { useEffect, useRef } from "react";
import {
  Button,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Dismiss24Regular } from "@fluentui/react-icons";
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
    zIndex: 10,
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

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (photo) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      if (dialog.open) {
        dialog.close();
      }
    }
  }, [photo]);

  useEffect(() => {
    if (!photo) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowRight":
          onNext?.();
          break;
        case "ArrowLeft":
          onPrevious?.();
          break;
        case "Escape":
          onDismiss();
          break;
      }
    };

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

  const handleDialogCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    onDismiss();
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      onClose={handleClose}
      onClick={handleBackdropClick}
      onCancel={handleDialogCancel}
      aria-modal="true"
      aria-labelledby="fullscreen-viewer-title"
    >
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div className={styles.container} onClick={handleContainerClick}>
          <Button
            appearance="subtle"
            icon={<Dismiss24Regular />}
            onClick={onDismiss}
            className={styles.closeButton}
            aria-label="Close"
            size="large"
          />

          {photo.mediaType === "video" ? (
            <video
              key={photo.path}
              controls
              className={styles.media}
              poster={photo.previewUrl}
              preload="metadata"
              autoPlay
            >
              <track kind="captions" src="data:," label="Captions not provided" />
              <source
                src={photo.fullUrl}
                type={photo.metadata?.mimeType ?? "video/mp4"}
              />
              Your browser does not support HTML video playback.
            </video>
          ) : (
            <img src={photo.fullUrl} alt={photo.name} className={styles.media} />
          )}
        </div>
      )}
    </dialog>
  );
}
