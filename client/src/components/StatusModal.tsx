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
  type ServerStatus,
} from "../api";
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
  queueBarSection: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
  },
  queueBarHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
  },
  queueBarTrack: {
    position: "relative",
    display: "flex",
    width: "100%",
    height: "18px",
    borderRadius: tokens.borderRadiusLarge,
    overflow: "hidden",
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  queueSegment: {
    height: "100%",
  },
  queueSeparator: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: "2px",
    backgroundColor: tokens.colorNeutralStrokeAccessible,
    transform: "translateX(-1px)",
    pointerEvents: "none",
  },
  queueAxis: {
    display: "flex",
    justifyContent: "space-between",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  queueLegend: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
  },
  queueLegendItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground2,
  },
  queueLegendSwatch: {
    width: "12px",
    height: "12px",
    borderRadius: tokens.borderRadiusSmall,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

interface StatusModalProps {
  isOpen: boolean;
  onDismiss: () => void;
}

const summaryGroups = [
  "completed",
  "active",
  "userBlocked",
  "userImplicit",
  "background",
] as const;

type QueueGroup = (typeof summaryGroups)[number];
type QueueSummaryByMedia = ServerStatus["queueSummary"][QueueGroup];

type QueueSegment = {
  key: string;
  widthPercent: number;
  color: string;
};

const formatBytes = (sizeBytes: number) => {
  if (sizeBytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(sizeBytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = sizeBytes / 1024 ** unitIndex;
  const decimals = value < 10 && unitIndex > 0 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
};

const getGroupLabel = (group: QueueGroup) => {
  if (group === "userBlocked") {
    return "userBlocked";
  }
  if (group === "userImplicit") {
    return "userImplicit";
  }
  return group;
};

const getMediaColor = (group: QueueGroup, mediaType: "image" | "video") => {
  const completedColors = {
    image: "#2c7be5",
    video: "#2e9d62",
  };
  const queuedColors = {
    image: "#7fa6d8",
    video: "#79b596",
  };

  if (group === "completed") {
    return completedColors[mediaType];
  }

  return queuedColors[mediaType];
};

const getQueueSize = (summary: QueueSummaryByMedia) => {
  return summary.image.sizeBytes + summary.video.sizeBytes;
};

const buildQueueVisualization = (summary: ServerStatus["queueSummary"]) => {
  const totalBytes = summaryGroups.reduce(
    (accumulator, group) => accumulator + getQueueSize(summary[group]),
    0,
  );

  const separators = summaryGroups.slice(0, -1).reduce<number[]>((accumulator, group) => {
    const nextValue = (accumulator.at(-1) ?? 0) + getQueueSize(summary[group]);
    return [...accumulator, nextValue];
  }, []);

  if (totalBytes <= 0) {
    return {
      totalBytes,
      segments: [] as QueueSegment[],
      separatorsPercent: [] as number[],
      groupBreakdown: summaryGroups.map((group) => ({
        group,
        sizeBytes: 0,
      })),
    };
  }

  const segments = summaryGroups.flatMap((group) => {
    const imageBytes = summary[group].image.sizeBytes;
    const videoBytes = summary[group].video.sizeBytes;

    return [
      {
        key: `${group}-image`,
        widthPercent: (imageBytes / totalBytes) * 100,
        color: getMediaColor(group, "image"),
      },
      {
        key: `${group}-video`,
        widthPercent: (videoBytes / totalBytes) * 100,
        color: getMediaColor(group, "video"),
      },
    ].filter((segment) => segment.widthPercent > 0);
  });

  return {
    totalBytes,
    segments,
    separatorsPercent: separators
      .map((boundaryBytes) => (boundaryBytes / totalBytes) * 100)
      .filter((value) => value > 0 && value < 100),
    groupBreakdown: summaryGroups.map((group) => ({
      group,
      sizeBytes: getQueueSize(summary[group]),
    })),
  };
};

export const StatusModal = ({ isOpen, onDismiss }: StatusModalProps) => {
  const styles = useStyles();
  const [statusHistory, setStatusHistory] = useState<
    Array<{ timestamp: number; status: ServerStatus }> | undefined
  >(undefined);
  const [isTogglingBackgroundTasks, setIsTogglingBackgroundTasks] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const status = statusHistory?.at(-1)?.status;
  const backgroundTasksEnabled = status?.maintenance.backgroundTasksEnabled ?? true;

  const queueVisualization = status ? buildQueueVisualization(status.queueSummary) : undefined;

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
                {queueVisualization ? (
                  <div className={styles.queueBarSection}>
                    <div className={styles.queueBarHeader}>
                      <Text weight="semibold">Queue by disk size</Text>
                      <Text>{formatBytes(queueVisualization.totalBytes)} total</Text>
                    </div>
                    <div className={styles.queueBarTrack}>
                      {queueVisualization.segments.map((segment) => (
                        <div
                          key={segment.key}
                          className={styles.queueSegment}
                          style={{
                            width: `${segment.widthPercent}%`,
                            backgroundColor: segment.color,
                          }}
                        />
                      ))}
                      {queueVisualization.separatorsPercent.map((separator, index) => (
                        <div
                          key={`separator-${index}`}
                          className={styles.queueSeparator}
                          style={{ left: `${separator}%` }}
                        />
                      ))}
                    </div>
                    <div className={styles.queueAxis}>
                      <span>0</span>
                      <span>{formatBytes(queueVisualization.totalBytes)}</span>
                    </div>
                    <div className={styles.queueLegend}>
                      {queueVisualization.groupBreakdown.map((item) => (
                        <span key={item.group} className={styles.queueLegendItem}>
                          <span
                            className={styles.queueLegendSwatch}
                            style={{
                              background: `linear-gradient(90deg, ${getMediaColor(item.group, "image")} 50%, ${getMediaColor(item.group, "video")} 50%)`,
                            }}
                          />
                          <span>{getGroupLabel(item.group)}: {formatBytes(item.sizeBytes)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

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
