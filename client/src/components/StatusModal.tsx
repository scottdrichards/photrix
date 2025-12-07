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
import { subscribeStatusStream, type ProgressEntry, type RecentMaintenance, type ServerStatus } from "../api";
import { ProgressItem } from "./ProgressItem";
import { RecentActivity } from "./RecentActivity";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  statsRow: {
    display: "flex",
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalM,
    flexWrap: "wrap",
  },
  progressGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: tokens.spacingHorizontalM,
  },
  recentRow: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: tokens.spacingHorizontalM,
  },
  label: {
    fontWeight: tokens.fontWeightSemibold,
  },
  value: {
    marginLeft: tokens.spacingHorizontalS,
  },
  badgeRow: {
    display: "flex",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
  },
});

interface StatusModalProps {
  isOpen: boolean;
  onDismiss: () => void;
}

export const StatusModal = ({ isOpen, onDismiss }: StatusModalProps) => {
  const styles = useStyles();
  const [statusHistory, setStatusHistory] = useState<Array<{ timestamp: number; status: ServerStatus }> | undefined>(undefined);

  const status = statusHistory?.at(-1)?.status;

  const calculateETA = (progress: ProgressEntry, completedKey: 'thumbnails' | 'exif'): string | null => {
    if (!statusHistory || statusHistory.length < 2 || progress.percent >= 1) {
      return null;
    }

    const oldestSample = statusHistory.at(0)!;
    const latestSample = statusHistory.at(-1)!;
    
    const completedDelta = latestSample.status.progress[completedKey].completed - oldestSample.status.progress[completedKey].completed;
    const timeDeltaSecs = (latestSample.timestamp - oldestSample.timestamp) / 1000;

    if (completedDelta <= 0 || timeDeltaSecs <= 0) return null;

    const rate = completedDelta / timeDeltaSecs;
    const remaining = progress.total - progress.completed;
    const etaSeconds = remaining / rate;

    if (etaSeconds < 60) return `~${Math.round(etaSeconds)}s`;
    if (etaSeconds < 3600) return `~${Math.round(etaSeconds / 60)}m`;
    return `~${Math.round(etaSeconds / 3600)}h`;
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const unsubscribe = subscribeStatusStream((data) => {
      setStatusHistory(prev => {
        const newEntry = {
          timestamp: Date.now(),
          status: data,
        };
        const updated = [...(prev ?? []), newEntry];
        return updated.slice(-5);
      });
    }, (error) => {
      console.error("Failed to receive status", error);
    });

    return () => {
      unsubscribe();
      setStatusHistory(undefined);
    };
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={(_, data) => !data.open && onDismiss()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Server Status</DialogTitle>
          <DialogContent>
            {/* Indeterminate progress bar while loading initial status */}
            {!statusHistory && <ProgressBar />}
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
                  <Text>
                    <span className={styles.label}>Thumbnail worker:</span>
                    <span className={styles.value}>{status.maintenance.thumbnailActive ? "active" : "idle"}</span>
                  </Text>
                  <Text>
                    <span className={styles.label}>EXIF worker:</span>
                    <span className={styles.value}>{status.maintenance.exifActive ? "active" : "idle"}</span>
                  </Text>
                </div>
                <ProgressItem
                  label="Overall progress"
                  progress={status.progress.overall}
                  detail="Includes file info, EXIF, and thumbnails"
                />

                <div className={styles.progressGrid}>
                  <ProgressItem
                    label="Discovery"
                    progress={status.progress.scanned}
                    detail={`${status.scannedFilesCount.toLocaleString()} files scanned`}
                  />
                  <ProgressItem
                    label="File info"
                    progress={status.progress.info}
                    detail={`${status.pending.info.toLocaleString()} remaining`}
                  />
                  <ProgressItem
                    label="EXIF metadata"
                    progress={status.progress.exif}
                    detail={`${status.pending.exif.toLocaleString()} remaining`}
                    eta={calculateETA(status.progress.exif, 'exif')}
                  />
                  <ProgressItem
                    label="Thumbnails"
                    progress={status.progress.thumbnails}
                    detail={`${status.pending.thumbnails.toLocaleString()} remaining`}
                    eta={calculateETA(status.progress.thumbnails, 'thumbnails')}
                  />
                </div>

                <Text size={400} weight="semibold">Recent activity</Text>
                <div className={styles.recentRow}>
                  <RecentActivity label="Last thumbnail" entry={status.recent.thumbnail} />
                  <RecentActivity label="Last EXIF" entry={status.recent.exif} />
                </div>
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
