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
  image: {
    width: "100%",
    height: "100%",
    maxHeight: "75vh",
    objectFit: "contain",
    backgroundColor: tokens.colorNeutralBackground4,
    borderRadius: tokens.borderRadiusLarge,
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
    <Dialog open={open} modalType="alert" onOpenChange={(_, data) => !data.open && onDismiss()}>
      <DialogSurface aria-describedby={undefined}>
        <DialogBody className={styles.dialogBody}>
          <DialogTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} onClick={onDismiss} aria-label="Close" />}> 
            {photo?.name ?? ""}
          </DialogTitle>
          <DialogContent>
            {photo && (
              <img
                src={photo.fullUrl}
                alt={photo.name}
                className={styles.image}
              />
            )}
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
