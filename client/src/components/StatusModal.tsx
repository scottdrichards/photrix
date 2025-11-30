import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogContent,
  DialogActions,
  Button,
  ProgressBar,
  makeStyles,
  tokens,
  Text,
} from "@fluentui/react-components";
import { useEffect, useState } from "react";
import { fetchStatus, ServerStatus } from "../api";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  row: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  statsRow: {
    display: "flex",
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalM,
  },
  label: {
    fontWeight: tokens.fontWeightSemibold,
  },
  value: {
    marginLeft: tokens.spacingHorizontalS,
  },
  queueLabel: {
    display: "flex",
    justifyContent: "space-between",
  }
});

interface StatusModalProps {
  isOpen: boolean;
  onDismiss: () => void;
}

export const StatusModal = ({ isOpen, onDismiss }: StatusModalProps) => {
  const styles = useStyles();
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const loadStatus = async () => {
        // Only set loading on first load
        if (!status) setLoading(true);
        try {
          const data = await fetchStatus();
          setStatus(data);
        } catch (error) {
          console.error("Failed to load status", error);
        } finally {
          setLoading(false);
        }
      };
      loadStatus();
      
      // Poll every 1 second while open
      const interval = setInterval(loadStatus, 1000);
      return () => clearInterval(interval);
    }
  }, [isOpen]);

  const renderQueue = (label: string, queue: { length: number; total: number }) => {
    const progress = queue.total > 0 ? Math.max(0, (queue.total - queue.length) / queue.total) : 1;
    const done = Math.max(0, queue.total - queue.length);
    return (
      <div className={styles.row}>
        <div className={styles.queueLabel}>
          <Text>{label}</Text>
          <Text>{done} / {queue.total}</Text>
        </div>
        <ProgressBar value={progress} />
      </div>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={(_, data) => !data.open && onDismiss()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Server Status</DialogTitle>
          <DialogContent>
            {loading && !status && <ProgressBar />}
            {status && (
              <div className={styles.container}>
                <div className={styles.statsRow}>
                  <Text>
                    <span className={styles.label}>Database Size:</span>
                    <span className={styles.value}>{status.databaseSize.toLocaleString()} files</span>
                  </Text>
                  <Text>
                    <span className={styles.label}>Scanned:</span>
                    <span className={styles.value}>{status.scannedFilesCount.toLocaleString()} files</span>
                  </Text>
                </div>

                <Text size={400} weight="semibold">Processing Queues</Text>
                
                {renderQueue("Info Queue", status.queues.info)}
                {renderQueue("EXIF Queue", status.queues.exifMetadata)}
                {renderQueue("Thumbnail Queue", status.queues.thumbnail)}
                {renderQueue("AI Queue", status.queues.aiMetadata)}
                {renderQueue("Face Queue", status.queues.faceMetadata)}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onDismiss}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
