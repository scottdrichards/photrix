import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Button,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Dismiss24Regular } from "@fluentui/react-icons";
import type { PhotoItem } from "../api";

const useStyles = makeStyles({
  media: {
    width: "100%",
    maxHeight: "75vh",
    objectFit: "contain",
    backgroundColor: tokens.colorNeutralBackground4,
    borderRadius: tokens.borderRadiusLarge,
    display: "block",
  },
  video: {
    width: "100%",
    maxHeight: "75vh",
    backgroundColor: tokens.colorNeutralBackground4,
    borderRadius: tokens.borderRadiusLarge,
    objectFit: "contain",
    display: "block",
  },
  dialogBody: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalM,
  },
});

export interface FullscreenViewerProps {
  photo: PhotoItem | null;
  onDismiss: () => void;
}

export function FullscreenViewer({ photo, onDismiss }: FullscreenViewerProps) {
  const styles = useStyles();
  const open = Boolean(photo);

  return (
    <Dialog
      open={open}
      modalType="alert"
      onOpenChange={(_, data) => !data.open && onDismiss()}
    >
      <DialogSurface aria-describedby={undefined}>
        <DialogBody className={styles.dialogBody}>
          <DialogTitle
            action={
              <Button
                appearance="subtle"
                icon={<Dismiss24Regular />}
                onClick={onDismiss}
                aria-label="Close"
              />
            }
          >
            {photo?.name ?? ""}
          </DialogTitle>
          <DialogContent>
            {photo && photo.mediaType === "video" ? (
              <video
                key={photo.path}
                controls
                className={styles.video}
                poster={photo.previewUrl}
                preload="metadata"
              >
                <track
                  kind="captions"
                  src="data:,"
                  label="Captions not provided"
                />
                <source
                  src={photo.fullUrl}
                  type={photo.metadata?.mimeType ?? "video/mp4"}
                />
                Your browser does not support HTML video playback.
              </video>
            ) : null}
            {photo && photo.mediaType !== "video" ? (
              <img src={photo.fullUrl} alt={photo.name} className={styles.media} />
            ) : null}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onDismiss}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
