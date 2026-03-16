import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogContent,
  DialogActions,
  Button,
  ProgressBar,
  Switch,
  makeStyles,
  tokens,
  Text,
} from "@fluentui/react-components";
import { useEffect, useState } from "react";
import {
  setBackgroundTasksEnabled,
  subscribeStatusStream,
  type ProgressEntry,
  type ServerStatus,
} from "../api";
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
  toggleRow: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
  },
});

interface StatusModalProps {
  isOpen: boolean;
  onDismiss: () => void;
}

export const StatusModal = ({ isOpen, onDismiss }: StatusModalProps) => {
  const styles = useStyles();
  const [statusHistory, setStatusHistory] = useState<
    Array<{ timestamp: number; status: ServerStatus }> | undefined
  >(undefined);
  const [isTogglingBackgroundTasks, setIsTogglingBackgroundTasks] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const status = statusHistory?.at(-1)?.status;
  const backgroundTasksEnabled = status?.maintenance.backgroundTasksEnabled ?? true;

  const calculateETA = (progress: ProgressEntry, completedKey: "exif"): string | null => {
    if (!statusHistory || statusHistory.length < 2 || progress.percent >= 1) {
      return null;
    }

    const oldestSample = statusHistory.at(0)!;
    const latestSample = statusHistory.at(-1)!;

    const completedDelta =
      latestSample.status.progress[completedKey].completed -
      oldestSample.status.progress[completedKey].completed;
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
    const unsubscribe = subscribeStatusStream(
      (data) => {
        setStatusHistory((prev) => {
          const newEntry = {
            timestamp: Date.now(),
            status: data,
          };
          const updated = [...(prev ?? []), newEntry];
          return updated.slice(-5);
        });
      },
      (error) => {
        console.error("Failed to receive status", error);
      },
    );

    return () => {
      unsubscribe();
      setStatusHistory(undefined);
      setIsTogglingBackgroundTasks(false);
      setToggleError(null);
    };
  }, [isOpen]);

  const onToggleBackgroundTasks = async (enabled: boolean) => {
    setIsTogglingBackgroundTasks(true);
    setToggleError(null);

    try {
      const response = await setBackgroundTasksEnabled(enabled);
      setStatusHistory((prev) => {
        if (!prev || prev.length === 0) {
          return prev;
        }

        const next = [...prev];
        const latestEntry = next[next.length - 1];

        if (!latestEntry) {
          return prev;
        }

        next[next.length - 1] = {
          ...latestEntry,
          status: {
            ...latestEntry.status,
            maintenance: {
              ...latestEntry.status.maintenance,
              backgroundTasksEnabled: response.enabled,
            },
          },
        };

        return next;
      });
    } catch (error) {
      setToggleError(
        error instanceof Error ? error.message : "Failed to update background task setting",
      );
    } finally {
      setIsTogglingBackgroundTasks(false);
    }
  };

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
                <div className={styles.toggleRow}>
                  <Switch
                    checked={backgroundTasksEnabled}
                    disabled={isTogglingBackgroundTasks}
                    label="Enable background tasks"
                    onChange={(_, data) => onToggleBackgroundTasks(data.checked)}
                  />
                  <Text size={200}>
                    When disabled, the server only runs user-blocking work.
                  </Text>
                  {toggleError ? <Text className={styles.errorText}>{toggleError}</Text> : null}
                </div>

                <div className={styles.statsRow}>
                  <Text>
                    <span className={styles.label}>Database Size:</span>
                    <span className={styles.value}>
                      {status.databaseSize.toLocaleString()} files
                    </span>
                  </Text>
                  <Text>
                    <span className={styles.label}>Scanned:</span>
                    <span className={styles.value}>
                      {status.scannedFilesCount.toLocaleString()} files
                    </span>
                  </Text>
                  <Text>
                    <span className={styles.label}>EXIF worker:</span>
                    <span className={styles.value}>
                      {status.maintenance.exifActive ? "active" : "idle"}
                    </span>
                  </Text>
                  <Text>
                    <span className={styles.label}>Face worker:</span>
                    <span className={styles.value}>
                      {status.maintenance.faceActive ? "active" : "idle"}
                    </span>
                  </Text>
                  <Text>
                    <span className={styles.label}>Queue:</span>
                    <span className={styles.value}>
                      {status.queues.pending.toLocaleString()} waiting / {" "}
                      {status.queues.processing.toLocaleString()} processing
                    </span>
                  </Text>
                </div>

                <div className={styles.statsRow}>
                  <Text>
                    <span className={styles.label}>Face processed:</span>
                    <span className={styles.value}>
                      {(status.faceProcessing?.processed ?? 0).toLocaleString()}
                    </span>
                  </Text>
                  <Text>
                    <span className={styles.label}>Worker success:</span>
                    <span className={styles.value}>
                      {(status.faceProcessing?.workerSuccess ?? 0).toLocaleString()}
                    </span>
                  </Text>
                  <Text>
                    <span className={styles.label}>Fallback used:</span>
                    <span className={styles.value}>
                      {(status.faceProcessing?.fallbackCount ?? 0).toLocaleString()}
                    </span>
                  </Text>
                  <Text>
                    <span className={styles.label}>Worker failures:</span>
                    <span className={styles.value}>
                      {(status.faceProcessing?.workerFailures ?? 0).toLocaleString()}
                    </span>
                  </Text>
                </div>
                <ProgressItem
                  label="Overall progress"
                  progress={status.progress.overall}
                  detail="Includes file info and EXIF"
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
                    eta={calculateETA(status.progress.exif, "exif")}
                  />
                </div>

                <Text size={400} weight="semibold">
                  Recent activity
                </Text>
                <div className={styles.recentRow}>
                  <RecentActivity label="Last EXIF" entry={status.recent.exif} />
                </div>
              </div>
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
};
