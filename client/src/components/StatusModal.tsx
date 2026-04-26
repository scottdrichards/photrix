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
      (error) => {
        console.error("Failed to receive status", error);
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

