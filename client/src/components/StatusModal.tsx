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

const capitalize = (value: string) => value[0]?.toUpperCase() + value.slice(1);

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
        setStatus(data);
      },
      (_error) => {
      },
    );

    return () => {
      unsubscribe();
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

                  if (progress) {
                    return (
                      <ProgressItem
                        key={task.id}
                        label={task.name}
                        progress={progress}
                        detail={detail}
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

