import { useEffect, useRef, useState } from "react";
import { Film, Image } from "lucide-react";
import {
  setBackgroundTasksEnabled,
  subscribeStatusStream,
  type ServerStatus,
} from "../api";
import css from "./StatusModal.module.css";

type StatusModalProps = {
  isOpen: boolean;
  onDismiss: () => void;
};

type PendingSample = {
  totalPending: number;
  capturedAtMs: number;
};

type EstimateTracker = {
  lastSample: PendingSample | null;
  smoothedRatePerSecond: number | null;
  lastProgressAtMs: number | null;
};

const INITIAL_ESTIMATE_TRACKER: EstimateTracker = {
  lastSample: null,
  smoothedRatePerSecond: null,
  lastProgressAtMs: null,
};

const ETA_RATE_SMOOTHING = 0.35;
const ETA_MAX_STALE_MS = 30_000;

const getTotalPending = (status: ServerStatus) =>
  status.pending.fileMetadata + status.pending.mediaMetadata + status.pending.thumbnails;

const updateEstimateTracker = (
  tracker: EstimateTracker,
  status: ServerStatus,
  capturedAtMs: number,
): EstimateTracker => {
  const totalPending = getTotalPending(status);
  const nextSample: PendingSample = { totalPending, capturedAtMs };

  if (!tracker.lastSample) {
    return {
      ...tracker,
      lastSample: nextSample,
    };
  }

  const elapsedSeconds = (capturedAtMs - tracker.lastSample.capturedAtMs) / 1000;
  if (elapsedSeconds <= 0) {
    return {
      ...tracker,
      lastSample: nextSample,
    };
  }

  const completedCount = tracker.lastSample.totalPending - totalPending;
  if (completedCount <= 0) {
    return {
      ...tracker,
      lastSample: nextSample,
    };
  }

  const measuredRate = completedCount / elapsedSeconds;
  const smoothedRatePerSecond = tracker.smoothedRatePerSecond
    ? tracker.smoothedRatePerSecond +
      (measuredRate - tracker.smoothedRatePerSecond) * ETA_RATE_SMOOTHING
    : measuredRate;

  return {
    lastSample: nextSample,
    smoothedRatePerSecond,
    lastProgressAtMs: capturedAtMs,
  };
};

const formatDuration = (seconds: number) => {
  const roundedSeconds = Math.max(1, Math.round(seconds));

  if (roundedSeconds < 60) {
    return `${roundedSeconds}s`;
  }

  if (roundedSeconds < 3600) {
    const minutes = Math.floor(roundedSeconds / 60);
    const remainingSeconds = roundedSeconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(roundedSeconds / 3600);
  const remainingMinutes = Math.floor((roundedSeconds % 3600) / 60);
  return `${hours}h ${remainingMinutes}m`;
};

const getEstimatedTimeText = (
  status: ServerStatus,
  tracker: EstimateTracker,
  nowMs: number,
) => {
  const totalPending = getTotalPending(status);
  if (totalPending === 0) {
    return "Complete";
  }

  if (!tracker.smoothedRatePerSecond || tracker.smoothedRatePerSecond <= 0) {
    return "Calculating...";
  }

  const lastProgressAge =
    tracker.lastProgressAtMs === null ? Number.POSITIVE_INFINITY : nowMs - tracker.lastProgressAtMs;
  if (lastProgressAge > ETA_MAX_STALE_MS) {
    return "Calculating...";
  }

  return formatDuration(totalPending / tracker.smoothedRatePerSecond);
};

export const StatusModal = ({ isOpen, onDismiss }: StatusModalProps) => {
  const [status, setStatus] = useState<ServerStatus | undefined>(undefined);
  const [isTogglingBackgroundTasks, setIsTogglingBackgroundTasks] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [estimatedTimeText, setEstimatedTimeText] = useState("Calculating...");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const estimateTrackerRef = useRef<EstimateTracker>(INITIAL_ESTIMATE_TRACKER);

  const backgroundTasksEnabled = status?.maintenance.backgroundTasksEnabled ?? true;

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
        const nowMs = Date.now();
        const nextEstimateTracker = updateEstimateTracker(
          estimateTrackerRef.current,
          data,
          nowMs,
        );
        estimateTrackerRef.current = nextEstimateTracker;
        setStatus(data);
        setEstimatedTimeText(getEstimatedTimeText(data, nextEstimateTracker, nowMs));
      },
      (_error) => {
      },
    );

    return () => {
      unsubscribe();
      setStatus(undefined);
      setEstimatedTimeText("Calculating...");
      estimateTrackerRef.current = INITIAL_ESTIMATE_TRACKER;
      setIsTogglingBackgroundTasks(false);
      setToggleError(null);
    };
  }, [isOpen]);

  const onToggleBackgroundTasks = async (enabled: boolean) => {
    setIsTogglingBackgroundTasks(true);
    setToggleError(null);

    try {
      const response = await setBackgroundTasksEnabled(enabled);
      setStatus((prev) =>
        prev
          ? { ...prev, maintenance: { backgroundTasksEnabled: response.enabled } }
          : prev,
      );
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
        {!status && <progress />}
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
                <span className={css.label}>Files:</span>
                <span className={css.value}>{status.files.total.toLocaleString()}</span>
                <span className={css.mediaCount}>
                  <Image size={14} aria-label="Photos" />
                  {status.files.images.toLocaleString()}
                </span>
                <span className={css.mediaCount}>
                  <Film size={14} aria-label="Videos" />
                  {status.files.videos.toLocaleString()}
                </span>
              </span>
              <span>
                <span className={css.label}>File metadata to scan:</span>
                <span className={css.value}>
                  {status.pending.fileMetadata.toLocaleString()}
                </span>
              </span>
              <span>
                <span className={css.label}>Media metadata to scan:</span>
                <span className={css.value}>
                  {status.pending.mediaMetadata.toLocaleString()}
                </span>
              </span>
              <span>
                <span className={css.label}>Thumbnails to process:</span>
                <span className={css.value}>
                  {status.pending.thumbnails.toLocaleString()}
                </span>
              </span>
              <span>
                <span className={css.label}>Estimated total time:</span>
                <span className={css.value}>{estimatedTimeText}</span>
              </span>
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

