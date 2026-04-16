import { useEffect, useRef, useState } from "react";
import {
  setBackgroundTasksEnabled,
  subscribeStatusStream,
  type ServerStatus,
} from "../api";
import { RecentActivity } from "./RecentActivity";
import css from "./StatusModal.module.css";

type StatusModalProps = {
  isOpen: boolean;
  onDismiss: () => void;
};

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
  const [statusHistory, setStatusHistory] = useState<
    Array<{ timestamp: number; status: ServerStatus }> | undefined
  >(undefined);
  const [isTogglingBackgroundTasks, setIsTogglingBackgroundTasks] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const status = statusHistory?.at(-1)?.status;
  const backgroundTasksEnabled = status?.maintenance.backgroundTasksEnabled ?? true;

  const queueVisualization = status
    ? buildQueueVisualization(status.queueSummary)
    : undefined;

  useEffect(() => {
    if (isOpen) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [isOpen]);

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
        error instanceof Error
          ? error.message
          : "Failed to update background task setting",
      );
    } finally {
      setIsTogglingBackgroundTasks(false);
    }
  };

  return (
    <dialog ref={dialogRef} onClose={onDismiss}>
      <div className={css.dialogBody}>
        <h2>Server Status</h2>
        {!statusHistory && <progress />}
        {status && (
          <div className={css.container}>
            <div className={css.toggleRow}>
              <label className="switch-label">
                <input
                  type="checkbox"
                  role="switch"
                  className="switch-track"
                  aria-label="Enable background tasks"
                  checked={backgroundTasksEnabled}
                  disabled={isTogglingBackgroundTasks}
                  onChange={(e) => onToggleBackgroundTasks(e.target.checked)}
                />
                <span>Enable background tasks</span>
              </label>
              <small>When disabled, the server only runs user-blocking work.</small>
              {toggleError ? <span className={css.errorText}>{toggleError}</span> : null}
            </div>

            <div className={css.statsRow}>
              <span>
                <span className={css.label}>Database Size:</span>
                <span className={css.value}>
                  {status.databaseSize.toLocaleString()} files
                </span>
              </span>
              <span>
                <span className={css.label}>Scanned:</span>
                <span className={css.value}>
                  {status.scannedFilesCount.toLocaleString()} files
                </span>
              </span>
              <span>
                <span className={css.label}>EXIF worker:</span>
                <span className={css.value}>
                  {status.maintenance.exifActive ? "active" : "idle"}
                </span>
              </span>
              <span>
                <span className={css.label}>Queue:</span>
                <span className={css.value}>
                  {status.queues.pending.toLocaleString()} waiting /{" "}
                  {status.queues.processing.toLocaleString()} processing
                </span>
              </span>
            </div>

            {queueVisualization ? (
              <div className={css.queueBarSection}>
                <div className={css.queueBarHeader}>
                  <span style={{ fontWeight: "var(--fw-semi)" }}>Queue by disk size</span>
                  <span>{formatBytes(queueVisualization.totalBytes)} total</span>
                </div>
                <div className={css.queueBarTrack}>
                  {queueVisualization.segments.map((segment) => (
                    <div
                      key={segment.key}
                      className={css.queueSegment}
                      style={{
                        width: `${segment.widthPercent}%`,
                        backgroundColor: segment.color,
                      }}
                    />
                  ))}
                  {queueVisualization.separatorsPercent.map((separator, index) => (
                    <div
                      key={`separator-${index}`}
                      className={css.queueSeparator}
                      style={{ left: `${separator}%` }}
                    />
                  ))}
                </div>
                <div className={css.queueAxis}>
                  <span>0</span>
                  <span>{formatBytes(queueVisualization.totalBytes)}</span>
                </div>
                <div className={css.queueLegend}>
                  {queueVisualization.groupBreakdown.map((item) => (
                    <span key={item.group} className={css.queueLegendItem}>
                      <span
                        className={css.queueLegendSwatch}
                        style={{
                          background: `linear-gradient(90deg, ${getMediaColor(item.group, "image")} 50%, ${getMediaColor(item.group, "video")} 50%)`,
                        }}
                      />
                      <span>
                        {getGroupLabel(item.group)}: {formatBytes(item.sizeBytes)}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <span style={{ fontSize: "16px", fontWeight: "var(--fw-semi)" }}>
              Recent activity
            </span>
            <div className={css.recentRow}>
              <RecentActivity label="Last EXIF" entry={status.recent.exif} />
            </div>
          </div>
        )}
        <div className={css.dialogActions}>
          <button className="btn btn-primary" onClick={onDismiss}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
};
