import { useEffect, useRef, useState } from "react";
import {
  type BackgroundTaskStatus,
  setBackgroundTasksEnabled,
  subscribeStatusStream,
  type ServerStatus,
} from "../api";
import { ProgressItem } from "./ProgressItem";
import css from "./StatusModal.module.css";

type StatusModalProps = {
  isOpen: boolean;
  onDismiss: () => void;
};

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

type ProgressSample = { timestamp: number; itemsProcessed: number };

const formatEta = (remainingMs: number): string => {
  if (remainingMs < 60_000) return "< 1 minute remaining";
  const totalMinutes = Math.round(remainingMs / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes !== 1 ? "s" : ""} remaining`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours < 48) {
    const hPart = `${hours} hour${hours !== 1 ? "s" : ""}`;
    if (mins === 0) return `${hPart} remaining`;
    return `${hPart} ${mins} minute${mins !== 1 ? "s" : ""} remaining`;
  }
  const days = Math.floor(hours / 24);
  const hrs = hours % 24;
  const dPart = `${days} day${days !== 1 ? "s" : ""}`;
  if (hrs === 0) return `${dPart} remaining`;
  return `${dPart} ${hrs} hour${hrs !== 1 ? "s" : ""} remaining`;
};

const computeEta = (
  history: ProgressSample[],
  total: number,
  currentItemsProcessed: number,
): string | null => {
  if (history.length < 2) return null;
  const oldest = history[0];
  const newest = history[history.length - 1];
  const elapsedMs = newest.timestamp - oldest.timestamp;
  if (elapsedMs <= 0) return null;
  const itemsDone = newest.itemsProcessed - oldest.itemsProcessed;
  if (itemsDone <= 0) return null;
  const ratePerMs = itemsDone / elapsedMs;
  const remaining = total - currentItemsProcessed;
  if (remaining <= 0) return null;
  return formatEta(remaining / ratePerMs);
};

const capitalize = (value: string) => value[0]?.toUpperCase() + value.slice(1);

const formatBytes = (bytes: number) => {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
};

const formatMB = (mb: number) => {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
};

type UtilizationBarProps = {
  label: string;
  percent: number;
  detail?: string;
};

const UtilizationBar = ({ label, percent, detail }: UtilizationBarProps) => {
  const pct = Math.max(0, Math.min(100, percent));
  const severity = pct >= 90 ? "high" : pct >= 70 ? "med" : "low";
  return (
    <div className={css.metricRow}>
      <div className={css.metricHeader}>
        <span className={css.metricLabel}>{label}</span>
        <span className={css.metricValue}>{pct}%</span>
      </div>
      <div className={css.metricBar}>
        <div
          className={`${css.metricBarFill} ${css[`severity-${severity}`]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {detail ? <small className={css.metricDetail}>{detail}</small> : null}
    </div>
  );
};

const toProgress = (task: BackgroundTaskStatus) => {
  if (task.total == null || task.itemsProcessed == null || task.total <= 0) {
    return null;
  }

  const percent =
    task.portionComplete != null
      ? clampUnit(task.portionComplete)
      : clampUnit(task.itemsProcessed / task.total);

  return {
    completed: task.itemsProcessed,
    total: task.total,
    percent,
  };
};

const buildTaskDetail = (task: BackgroundTaskStatus) => {
  const detailParts = [
    `Queue: ${capitalize(task.queue)}`,
    task.state !== "running" ? `State: ${capitalize(task.state)}` : null,
    task.description ?? null,
  ].filter(Boolean);

  return detailParts.length > 0 ? detailParts.join(" • ") : undefined;
};

export const StatusModal = ({ isOpen, onDismiss }: StatusModalProps) => {
  const [status, setStatus] = useState<ServerStatus | undefined>(undefined);
  const [isTogglingBackgroundTasks, setIsTogglingBackgroundTasks] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const progressHistoryRef = useRef<Map<string, ProgressSample[]>>(new Map());

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
        const now = Date.now();
        for (const task of data.backgroundTasks) {
          if (task.itemsProcessed == null) continue;
          const history = progressHistoryRef.current.get(task.id) ?? [];
          const lastSample = history[history.length - 1];
          if (lastSample?.itemsProcessed === task.itemsProcessed) continue;
          const updated = [...history, { timestamp: now, itemsProcessed: task.itemsProcessed }];
          progressHistoryRef.current.set(task.id, updated.slice(-20));
        }
        setStatus(data);
      },
      (_error) => {
      },
    );

    return () => {
      unsubscribe();
      progressHistoryRef.current.clear();
      setStatus(undefined);
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
            {status.system && (
              <div className={css.metricsList}>
                <span className={css.label}>System utilization</span>
                <UtilizationBar
                  label={`CPU (${status.system.cpu.cores} cores)`}
                  percent={status.system.cpu.usage}
                />
                <UtilizationBar
                  label="Memory"
                  percent={status.system.memory.usage}
                  detail={`${formatBytes(status.system.memory.used)} / ${formatBytes(status.system.memory.total)}`}
                />
                {status.system.disk && (
                  <UtilizationBar
                    label="Disk"
                    percent={status.system.disk.utilization ?? 0}
                    detail={[
                      status.system.disk.iopsRead != null
                        ? `${status.system.disk.iopsRead} r/s`
                        : null,
                      status.system.disk.iopsWrite != null
                        ? `${status.system.disk.iopsWrite} w/s`
                        : null,
                      status.system.disk.readLatencyMs != null
                        ? `read ${status.system.disk.readLatencyMs}ms`
                        : null,
                      status.system.disk.writeLatencyMs != null
                        ? `write ${status.system.disk.writeLatencyMs}ms`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" • ") || undefined}
                  />
                )}
                {status.system.gpu && (
                  <UtilizationBar
                    label="GPU"
                    percent={status.system.gpu.usage}
                    detail={
                      status.system.gpu.memory
                        ? `${formatMB(status.system.gpu.memory.used)} / ${formatMB(status.system.gpu.memory.total)}`
                        : undefined
                    }
                  />
                )}
              </div>
            )}

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

            <div className={css.taskList}>
              <span className={css.label}>Background tasks</span>
              {status.backgroundTasks.length === 0 ? (
                <span className={css.emptyText}>No background tasks running or queued.</span>
              ) : (
                status.backgroundTasks.map((task) => {
                  const progress = toProgress(task);
                  const detail = buildTaskDetail(task);
                  const eta =
                    progress && task.total != null && task.itemsProcessed != null
                      ? computeEta(
                          progressHistoryRef.current.get(task.id) ?? [],
                          task.total,
                          task.itemsProcessed,
                        )
                      : null;

                  if (progress) {
                    return (
                      <ProgressItem
                        key={task.id}
                        label={task.name}
                        progress={progress}
                        detail={detail}
                        eta={eta}
                        summaryLabel="items"
                      />
                    );
                  }

                  return (
                    <div className={css.taskRow} key={task.id}>
                      <span className={css.value}>{task.name}</span>
                      {detail ? <small>{detail}</small> : null}
                    </div>
                  );
                })
              )}
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

