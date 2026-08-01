import { useEffect, useRef, useState } from "react";
import {
  type BackgroundTaskStatus,
  setBackgroundTasksEnabled,
  subscribeStatusStream,
  type ServerStatus,
  type FeedbackItem,
  fetchFeedbackItems,
} from "../api";
import { ProgressItem } from "./ProgressItem";
import css from "./StatusModal.module.css";

type ActiveTab = "tasks" | "devtracker";

type StatusModalProps = {
  isOpen: boolean;
  onDismiss: () => void;
};

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

type ProgressSample = { timestamp: number; itemsProcessed: number };

const formatEta = (remainingMs: number): string => {
  if (remainingMs < 60_000) return "< 1 minute remaining";
  const totalMinutes = Math.round(remainingMs / 60_000);
  if (totalMinutes < 60)
    return `${totalMinutes} minute${totalMinutes !== 1 ? "s" : ""} remaining`;
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

const syncDialogOpenState = (dialog: HTMLDialogElement, isOpen: boolean) => {
  try {
    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
      return;
    }

    if (dialog.open) {
      dialog.close();
    }
  } catch {
    // Ignore dialog state races so the status modal never crashes the app.
  }
};

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

type WorkerMetric = NonNullable<ServerStatus["system"]["workers"]>[number];
type GpuProc = NonNullable<
  NonNullable<ServerStatus["system"]["gpu"]>["processes"]
>[number];
type Arbitration = NonNullable<ServerStatus["arbitration"]>;

const ROLE_LABEL: Record<string, string> = {
  image: "Image analysis",
  clap: "Audio embedding (CLAP)",
  whisper: "Transcription (Whisper)",
  other: "Transcode / other",
};

// Driver/context overhead makes a small used-vs-processes gap normal; only
// call out external VRAM once it's big enough to matter for transcode headroom.
const EXTERNAL_VRAM_NOTEWORTHY_MB = 512;

const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;

// A stacked bar of total VRAM split per GPU process, so it's obvious at a glance
// who is holding the card. Answers "why can't a video transcode get the GPU?".
// VRAM held by pids we can't see (host / sibling containers sharing the GPU)
// gets its own segment — without it that usage would masquerade as free space.
const VramBar = ({
  processes,
  totalMB,
  unaccountedMB = 0,
}: {
  processes: GpuProc[];
  totalMB: number;
  unaccountedMB?: number;
}) => {
  const usedMB = processes.reduce((sum, p) => sum + p.vramMB, 0) + unaccountedMB;
  const freeMB = Math.max(0, totalMB - usedMB);
  return (
    <div className={css.vramBar}>
      {unaccountedMB > 0 && (
        <div
          className={`${css.vramSegment} ${css["role-external"]}`}
          style={{ width: `${(unaccountedMB / totalMB) * 100}%` }}
          title={`Outside this container (host / other containers): ${formatMB(unaccountedMB)}`}
        />
      )}
      {processes.map((p) => (
        <div
          key={p.pid}
          className={`${css.vramSegment} ${css[`role-${p.role}`] ?? ""}`}
          style={{ width: `${(p.vramMB / totalMB) * 100}%` }}
          title={`${roleLabel(p.role)} (pid ${p.pid}): ${formatMB(p.vramMB)}`}
        />
      ))}
      <div className={css.vramFree} style={{ width: `${(freeMB / totalMB) * 100}%` }} />
    </div>
  );
};

const ComputeSection = ({
  workers,
  processes,
  totalVramMB,
  unaccountedVramMB,
  arbitration,
}: {
  workers: WorkerMetric[];
  processes: GpuProc[];
  totalVramMB: number | undefined;
  unaccountedVramMB: number | undefined;
  arbitration: Arbitration | undefined;
}) => {
  // VRAM held outside this container (host / sibling containers) shows up as
  // unaccounted with no visible worker or process. Still render so that usage —
  // and the resulting transcode headroom loss — is visible instead of silently
  // vanishing the whole section.
  const hasUnaccounted = (unaccountedVramMB ?? 0) > 0;
  if (workers.length === 0 && processes.length === 0 && !hasUnaccounted) return null;

  // GPU processes with no registered worker (e.g. an ffmpeg NVENC transcode).
  const workerPids = new Set(workers.map((w) => w.pid));
  const otherProcs = processes.filter((p) => !workerPids.has(p.pid));

  return (
    <div className={css.metricsList}>
      <span className={css.label}>Compute workers / VRAM</span>

      {arbitration && (
        <div className={css.arbLine}>
          {arbitration.userActive && <span className={css.badge}>User active</span>}
          {arbitration.workersSuspended && (
            <span className={css.badge}>Background frozen</span>
          )}
          {arbitration.gpuReclaimed && (
            <span className={`${css.badge} ${css.badgeHot}`}>
              GPU reclaimed for playback
            </span>
          )}
          {!arbitration.userActive &&
            !arbitration.workersSuspended &&
            !arbitration.gpuReclaimed && (
              <span className={css.emptyText}>
                Idle — background work may use the GPU
              </span>
            )}
        </div>
      )}

      {totalVramMB && (processes.length > 0 || (unaccountedVramMB ?? 0) > 0) && (
        <VramBar
          processes={processes}
          totalMB={totalVramMB}
          unaccountedMB={unaccountedVramMB}
        />
      )}

      {workers.map((w) => (
        <div className={css.workerRow} key={w.pid}>
          <span className={`${css.roleDot} ${css[`role-${w.role}`] ?? ""}`} />
          <span className={css.workerLabel}>{roleLabel(w.role)}</span>
          <span className={css.workerStat}>
            {w.vramMB > 0 ? `${formatMB(w.vramMB)} VRAM` : "no VRAM"} •{" "}
            {formatMB(w.rssMB)} RAM
          </span>
          {w.suspended && <span className={css.badge}>frozen</span>}
          {w.leases > 0 && <span className={css.badge}>in use</span>}
        </div>
      ))}

      {otherProcs.map((p) => (
        <div className={css.workerRow} key={p.pid}>
          <span className={`${css.roleDot} ${css[`role-${p.role}`] ?? ""}`} />
          <span className={css.workerLabel}>{roleLabel(p.role)}</span>
          <span className={css.workerStat}>{formatMB(p.vramMB)} VRAM</span>
        </div>
      ))}

      {(unaccountedVramMB ?? 0) >= EXTERNAL_VRAM_NOTEWORTHY_MB && (
        <div className={css.workerRow}>
          <span className={`${css.roleDot} ${css["role-external"]}`} />
          <span className={css.workerLabel}>Outside this container</span>
          <span className={css.workerStat}>{formatMB(unaccountedVramMB!)} VRAM</span>
        </div>
      )}
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

const STATUS_COLORS: Record<string, string> = {
  open: "#6b7280",
  active: "#f97316",
  completed: "#22c55e",
};

const DevTracker = () => {
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    fetchFeedbackItems()
      .then((data) => {
        if (!cancelled) setItems(data);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load feedback items");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <span className={css.errorText}>{error}</span>;
  if (!items) return <progress />;
  if (items.length === 0)
    return <span className={css.emptyText}>No feedback items yet.</span>;

  const groups: { label: string; status: string; items: FeedbackItem[] }[] = [
    { label: "Active", status: "active", items: items.filter((i) => i.status === "active") },
    { label: "Open", status: "open", items: items.filter((i) => i.status === "open") },
    {
      label: "Completed",
      status: "completed",
      items: items.filter((i) => i.status === "completed"),
    },
  ];

  return (
    <div className={css.devTracker}>
      {groups.map((group) => {
        if (group.items.length === 0) return null;
        return (
          <div key={group.status} className={css.devTrackerGroup}>
            <span className={css.label}>
              <span
                className={css.statusDot}
                style={{ backgroundColor: STATUS_COLORS[group.status] ?? "#6b7280" }}
              />
              {group.label}
            </span>
            {group.items.map((item) => (
              <div key={item.id} className={css.feedbackRow}>
                <span className={css.feedbackId}>#{item.id}</span>
                <span className={css.feedbackText}>{item.text}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
};

export const StatusModal = ({ isOpen, onDismiss }: StatusModalProps) => {
  const [status, setStatus] = useState<ServerStatus | undefined>(undefined);
  const [isTogglingBackgroundTasks, setIsTogglingBackgroundTasks] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("tasks");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const progressHistoryRef = useRef<Map<string, ProgressSample[]>>(new Map());

  const backgroundTasksEnabled = status?.maintenance.backgroundTasksEnabled ?? true;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    syncDialogOpenState(dialog, isOpen);
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
          const updated = [
            ...history,
            { timestamp: now, itemsProcessed: task.itemsProcessed },
          ];
          progressHistoryRef.current.set(task.id, updated.slice(-20));
        }
        setStatus(data);
      },
      (_error) => {},
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
    <dialog ref={dialogRef} onClose={onDismiss} className={css.dialog}>
      <div className={css.dialogBody}>
        <div className={css.tabBar}>
          <h2>Server Status</h2>
          <div className={css.tabButtons}>
            <button
              className={`btn ${activeTab === "tasks" ? "btn-primary" : "btn-ghost"} ${css.tabBtn}`}
              onClick={() => setActiveTab("tasks")}
            >
              Background tasks
            </button>
            <button
              className={`btn ${activeTab === "devtracker" ? "btn-primary" : "btn-ghost"} ${css.tabBtn}`}
              onClick={() => setActiveTab("devtracker")}
            >
              Dev tracker
            </button>
          </div>
        </div>

        {activeTab === "devtracker" && <DevTracker />}

        {activeTab === "tasks" && !status && <progress />}
        {activeTab === "tasks" && status && (
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
                    detail={
                      [
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
                        .join(" • ") || undefined
                    }
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

            {status.system && (
              <ComputeSection
                workers={status.system.workers ?? []}
                processes={status.system.gpu?.processes ?? []}
                totalVramMB={status.system.gpu?.memory?.total}
                unaccountedVramMB={status.system.gpu?.unaccountedMB}
                arbitration={status.arbitration}
              />
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
                <span className={css.emptyText}>
                  No background tasks running or queued.
                </span>
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
