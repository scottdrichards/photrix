import type { BackgroundTaskStatus } from "../../../shared/filter-contract/src/index.ts";
import { getLogger } from "../observability/logger.ts";
import { isSystemOverloaded, getAvailableMemoryMB } from "./systemLoad.ts";

const log = getLogger("TaskOrchestrator");

// After a user request, background/implied work treats the user as "active" for
// this long and yields via the duty cycle so the request is served promptly.
const ACTIVITY_COOLDOWN_MS = 2_000;
// Under pressure, background work runs on a duty cycle rather than stopping: an
// OFF rest where pressured runners pause, then an ON burst where they run. This
// keeps the backlog always making progress while freeing disk/CPU in between.
const DUTY_ON_MS = Number(process.env.PHOTRIX_BG_DUTY_ON_MS) || 2_000;
const DUTY_OFF_MS = Number(process.env.PHOTRIX_BG_DUTY_OFF_MS) || 2_000;

export type QueueType = "blocking" | "implied" | "background";
// cpu/gpu/disk/network are notional fractions (0–1) tracked as reservations.
// memoryMB is checked against actual OS available memory (MemAvailable on Linux)
// minus already-reserved MB, so the system never over-commits RAM.
type Resources = "gpu" | "cpu" | "disk" | "network" | "memoryMB";

type TaskType =
  | "imageConversion"
  | "videoConversion"
  | "mediaMedatadata"
  | "diskInfo"
  | "imageAnalysis"
  | "audioTranscription"
  | "audioEmbedding";

// Notional fractions of each resource's capacity (cap 1.0). They exist to bound
// how much heavy work runs at once; they are deliberately conservative so the
// box is not oversubscribed. The real-load gate below is the dynamic backstop.
const getResourceRequirements = (type?: TaskType): Partial<Record<Resources, number>> => {
  const mappings = {
    imageConversion: { cpu: 0.25 },
    videoConversion: { gpu: 0.5, cpu: 0.5 },
    mediaMedatadata: { disk: 0.5 },
    diskInfo: { disk: 0.5 },
    // Heavy combined pass (decode + face detection + CLIP). The dominant
    // background CPU consumer; leaves only a sliver so a single user-triggered
    // image conversion can still slip alongside it.
    imageAnalysis: { cpu: 0.75, memoryMB: 2500 },
    audioTranscription: { gpu: 0.5, cpu: 0.5, memoryMB: 3500 },
    audioEmbedding: { gpu: 0.5, cpu: 0.5, memoryMB: 2000 },
  };
  return type ? mappings[type] : {};
};

export type TaskRunner = {
  onComplete: () => Promise<void>;
  pause?: () => void;
  resume?: () => Promise<void>;
  cancel?: () => void;
  getStatus?: () => Promise<
    Partial<{
      state: "running" | "paused" | "cancelled" | "complete";
      itemsProcessed: number;
      total: number;
      portionComplete: number;
      description: string;
    }>
  >;
};

// "high" priority background tasks (e.g. the filesystem scan) keep running
// under system load and only yield to in-flight user requests, never to the
// load-based backoff. Defaults to "normal".
export type TaskPriority = "high" | "normal";

export type Task = {
  name: string;
  start: () => TaskRunner;
  type?: TaskType;
  resources?: Partial<Record<Resources, number>>;
  priority?: TaskPriority;
};

type RunningTask = {
  name: string;
  type?: TaskType;
  queue: QueueType;
  priority: TaskPriority;
  runner: TaskRunner;
};

export type TaskOrchestrator = {
  // Also implicates implied tasks
  setPerformBackgroundTasks: (enabled: boolean) => void;
  getPerformBackgroundTasks: () => boolean;
  getBackgroundTaskStatus: () => Promise<BackgroundTaskStatus[]>;
  addTask: (task: Task, queue: QueueType) => void;
  onQueueExhausted: (callback: () => void) => void;
  // Signal that a user request is being served, so background/implied work backs
  // off for a short cooldown and frees disk/CPU for the request.
  noteUserActivity: () => void;
  // Bracket a user request so background/implied work stays fully backed off for
  // the request's *entire* duration, not just a fixed cooldown. A single search
  // can run 10–15s on a busy box (cold model load, a starved vector scan); the
  // cooldown alone lets background workers resume mid-request and re-starve it.
  // Every beginUserRequest must be paired with exactly one endUserRequest.
  beginUserRequest: () => void;
  endUserRequest: () => void;
};

const canRunTask = (
  state: Record<Resources, number>,
  requirements: Partial<Record<Resources, number>>,
  availableMemoryMB: () => number,
): boolean => {
  for (const [resource, amount] of Object.entries(requirements)) {
    if (amount == null) continue;
    if (resource === "memoryMB") {
      // Compare against live OS memory minus what's already reserved, so the
      // system never over-commits RAM across concurrent ML workers.
      if (availableMemoryMB() - state.memoryMB < amount) return false;
    } else {
      if (state[resource as Resources] + amount > 1) return false;
    }
  }
  return true;
};

const checkoutResources = (
  state: Record<Resources, number>,
  requirements: Partial<Record<Resources, number>>,
) => {
  Object.entries(requirements).forEach(([resource, amount]) => {
    state[resource as Resources] += amount ?? 0;
  });
};

const checkInResources = (
  state: Record<Resources, number>,
  requirements: Partial<Record<Resources, number>>,
) => {
  Object.entries(requirements).forEach(([resource, amount]) => {
    state[resource as Resources] = Math.max(
      state[resource as Resources] - (amount ?? 0),
      0,
    );
  });
};

const logTaskEvent = (event: string, queue: QueueType, name: string) => {
  log.info({ queue, task: name }, event);
};

const normalizeProgressValue = (value: number | undefined) => {
  if (value == null || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, value));
};

// A task's getStatus() may query the DB or a worker; cap how long a single
// status poll will wait on it so one slow/stuck task can't freeze every poller.
// On timeout the orchestrator reuses the task's last known status instead of
// surfacing an error (see readActiveTaskStatus).
const STATUS_TIMEOUT_MS = 2_000;

// Sentinel: this poll's read didn't finish in time (or failed); fall back to the
// last known status rather than blocking or showing an error.
const STATUS_NOT_READY = Symbol("status-not-ready");

export type TaskOrchestratorOptions = {
  // Injectable for tests/determinism. Default to real wall-clock and load.
  isOverloaded?: () => boolean;
  availableMemoryMB?: () => number;
  now?: () => number;
  dutyOnMs?: number;
  dutyOffMs?: number;
  // OS-level freeze/thaw of the heavy ML worker processes. The orchestrator
  // calls suspend() when background work must fully stop (a user request is in
  // flight, or background is explicitly disabled) so their in-flight native
  // passes yield the CPU at once, and resume() when the pressure clears.
  // Defaults to a no-op (e.g. in tests, or before workers exist).
  computeThrottle?: { suspend: () => void; resume: () => void };
};

export const createTaskOrchestrator = (
  options: TaskOrchestratorOptions = {},
): TaskOrchestrator => {
  const isOverloaded = options.isOverloaded ?? isSystemOverloaded;
  const availableMemoryMB = options.availableMemoryMB ?? getAvailableMemoryMB;
  const now = options.now ?? Date.now;
  const dutyOnMs = options.dutyOnMs ?? DUTY_ON_MS;
  const dutyOffMs = options.dutyOffMs ?? DUTY_OFF_MS;
  const computeThrottle = options.computeThrottle ?? {
    suspend: () => {},
    resume: () => {},
  };

  const queues: Record<QueueType, Task[]> = {
    blocking: [],
    implied: [],
    background: [],
  };

  const runningTasks = new Set<RunningTask>();

  // Last status we successfully read for each active task, keyed by status id.
  // A task's getStatus() can momentarily be slow (the DB is busy indexing), and
  // we'd rather show its most recent real progress than a transient error, so a
  // slow/failed read falls back to this instead of surfacing a timeout.
  const lastKnownStatus = new Map<string, BackgroundTaskStatus>();
  // getStatus() calls still in flight, keyed by status id. A slow read is reused
  // across polls instead of launching another (so they can't pile up), and when
  // it eventually resolves it refreshes lastKnownStatus for the next poll.
  const statusInflight = new Map<string, Promise<BackgroundTaskStatus>>();

  let sleeping: Promise<void> | null = null;
  let wakeUp: (() => void) | null = null;
  const sleep = () => {
    sleeping = new Promise((resolve) => {
      wakeUp = resolve;
    });
  };

  let processBackgroundTasks = true;

  let onQueueExhausted: (() => void) | null = null;

  // Backoff has two regimes, chosen by *why* there's pressure:
  //
  //   1. Full stop — a user request is in flight (userActive), or background
  //      work is explicitly disabled. ALL background/implied runners are paused
  //      (including high-priority ones), and the heavy ML worker processes are
  //      SIGSTOP'd via computeThrottle so their in-flight native passes yield
  //      the CPU at once rather than at the next chunk boundary. The request
  //      gets the whole box; the workers thaw the moment the user goes idle.
  //
  //   2. Overload duty cycle — high system load but no in-flight request. Normal
  //      priority work runs on an ON/OFF duty cycle so it keeps trickling while
  //      freeing CPU between bursts; high-priority work (the filesystem scan)
  //      keeps running full speed. Workers are NOT frozen here — the goal is to
  //      keep making progress, just more gently.
  let userActiveUntil = 0;
  // Requests currently being served. While any are in flight the box belongs to
  // the user, so background work stays fully stopped regardless of the cooldown
  // clock; the cooldown only adds a trailing grace period after the last one.
  let activeRequests = 0;
  const userActive = () => activeRequests > 0 || now() < userActiveUntil;

  // Regime 1: background/implied work must be fully stopped.
  const fullStop = () => !processBackgroundTasks || userActive();

  // Regime 2: the overload duty cycle should run — we're loaded, not fully
  // stopped, and at least one normal-priority runner is active to back off.
  const overloadActive = () =>
    !fullStop() &&
    isOverloaded() &&
    [...runningTasks].some(
      ({ queue, priority }) => queue !== "blocking" && priority !== "high",
    );

  // Mirror the compute-worker freeze state so suspend()/resume() are only ever
  // called on a real transition (they're cheap, but this keeps logs/signals tidy).
  let workersSuspended = false;
  const suspendWorkers = () => {
    if (workersSuspended) return;
    workersSuspended = true;
    computeThrottle.suspend();
  };
  const resumeWorkers = () => {
    if (!workersSuspended) return;
    workersSuspended = false;
    computeThrottle.resume();
  };

  const pauseAllRunners = () => {
    for (const { queue, runner } of runningTasks) {
      if (queue === "background" || queue === "implied") runner.pause?.();
    }
  };

  // During OFF, pause each normal-priority background/implied runner; resume it
  // otherwise. Pause/resume are idempotent and only take effect at the runner's
  // next chunk boundary. High-priority work is never paused by the duty cycle.
  let dutyOff = false;
  const applyDutyCycle = () => {
    for (const { queue, priority, runner } of runningTasks) {
      if (queue !== "background" && queue !== "implied") continue;
      if (dutyOff && priority !== "high") runner.pause?.();
      else void runner.resume?.();
    }
  };

  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  const clearBackoffTimer = () => {
    if (backoffTimer) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
  };
  const scheduleBackoff = (ms: number) => {
    clearBackoffTimer();
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      advanceBackoff();
    }, ms);
    backoffTimer.unref?.();
  };

  // Timer-driven step. Re-derives the regime each tick: flips the duty phase
  // under overload, and re-checks whether a user-activity window has lapsed so
  // background work resumes promptly once the user stops interacting.
  const advanceBackoff = () => {
    if (!processBackgroundTasks) return; // explicit pause owns the runners
    if (fullStop()) {
      // Still in a user-activity window: keep everything frozen and re-check
      // soon. (Explicit pause is handled above and never schedules a timer.)
      pauseAllRunners();
      suspendWorkers();
      scheduleBackoff(dutyOffMs);
      return;
    }
    if (overloadActive()) {
      resumeWorkers();
      dutyOff = !dutyOff;
      applyDutyCycle();
      if (!dutyOff) wakeUp?.(); // entering ON: nudge the loop to admit/resume
      scheduleBackoff(dutyOff ? dutyOffMs : dutyOnMs);
      return;
    }
    // Pressure cleared: thaw, resume everything, stop ticking.
    resumeWorkers();
    dutyOff = false;
    applyDutyCycle();
    clearBackoffTimer();
    wakeUp?.();
  };

  // Reconcile backoff with the current state. Safe to call after any change: a
  // request arrives, a task starts/ends, or the background toggle flips.
  const reconcileBackoff = () => {
    if (fullStop()) {
      dutyOff = false;
      pauseAllRunners();
      suspendWorkers();
      // A user-activity window lapses on its own, so poll for it; an explicit
      // pause has no expiry and waits for the toggle to flip back on.
      if (processBackgroundTasks && userActive()) {
        if (!backoffTimer) scheduleBackoff(dutyOffMs);
      } else {
        clearBackoffTimer();
      }
      return;
    }
    resumeWorkers();
    if (overloadActive()) {
      if (!backoffTimer) {
        // Begin with an OFF rest so an incoming request is served immediately.
        dutyOff = true;
        applyDutyCycle();
        scheduleBackoff(dutyOffMs);
      } else {
        applyDutyCycle(); // catch tasks that started mid-cycle
      }
    } else {
      dutyOff = false;
      applyDutyCycle(); // resume everything
      clearBackoffTimer();
    }
  };

  const resourcesInUse: Record<Resources, number> = {
    gpu: 0,
    cpu: 0,
    disk: 0,
    network: 0,
    memoryMB: 0,
  };

  const bareRunningStatus = (task: RunningTask): BackgroundTaskStatus => ({
    id: `${task.queue}:${task.name}`,
    name: task.name,
    queue: task.queue as Extract<QueueType, "background" | "implied">,
    state: "running",
  });

  // Read one active task's status without ever blocking the whole payload or
  // surfacing a transient error. A getStatus() call still running from an
  // earlier poll is reused rather than duplicated; whenever one resolves it
  // refreshes lastKnownStatus. If the read is slower than STATUS_TIMEOUT_MS (or
  // fails), we return the last value we have instead of a timeout.
  const readActiveTaskStatus = async (
    task: RunningTask,
  ): Promise<BackgroundTaskStatus> => {
    const { name, queue, runner } = task;
    const id = `${queue}:${name}`;

    if (!runner.getStatus) {
      const bare = bareRunningStatus(task);
      lastKnownStatus.set(id, bare);
      return bare;
    }

    let inflight = statusInflight.get(id);
    if (!inflight) {
      const getStatus = runner.getStatus;
      inflight = (async () => {
        const status = (await getStatus()) ?? {};
        const portionComplete = normalizeProgressValue(status.portionComplete);
        const built = {
          id,
          name,
          queue,
          state: status.state ?? "running",
          ...(status.itemsProcessed != null
            ? { itemsProcessed: status.itemsProcessed }
            : {}),
          ...(status.total != null ? { total: status.total } : {}),
          ...(portionComplete != null ? { portionComplete } : {}),
          ...(status.description ? { description: status.description } : {}),
        } as BackgroundTaskStatus;
        lastKnownStatus.set(id, built);
        return built;
      })();
      const tracked = inflight;
      statusInflight.set(id, tracked);
      // Keep the entry until it settles so later polls reuse it; swallow errors
      // here so a failed read can never become an unhandled rejection.
      void tracked
        .catch(() => undefined)
        .finally(() => {
          if (statusInflight.get(id) === tracked) statusInflight.delete(id);
        });
    }

    const raced = await Promise.race([
      inflight.then(
        (value) => value,
        () => STATUS_NOT_READY,
      ),
      new Promise<typeof STATUS_NOT_READY>((resolve) => {
        const timer = setTimeout(() => resolve(STATUS_NOT_READY), STATUS_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);

    if (typeof raced !== "symbol") return raced;
    return lastKnownStatus.get(id) ?? bareRunningStatus(task);
  };

  const getBackgroundTaskStatus = async (): Promise<BackgroundTaskStatus[]> => {
    const activeTasks = [...runningTasks].filter(
      ({ queue }) => queue === "background" || queue === "implied",
    );

    const normalizedActiveStatuses = await Promise.all(
      activeTasks.map((task) => readActiveTaskStatus(task)),
    );

    // Drop bookkeeping for tasks that are no longer active so the maps can't
    // grow without bound across the process lifetime. (An entry still in flight
    // for an active task self-removes when it settles, so it's left alone here.)
    const activeIds = new Set(activeTasks.map(({ name, queue }) => `${queue}:${name}`));
    for (const id of lastKnownStatus.keys()) {
      if (!activeIds.has(id)) lastKnownStatus.delete(id);
    }
    for (const id of statusInflight.keys()) {
      if (!activeIds.has(id)) statusInflight.delete(id);
    }

    const queuedStatuses = (["background", "implied"] as const).flatMap((queue) =>
      queues[queue].map((task, index) => ({
        id: `${queue}:${task.name}:${index}`,
        name: task.name,
        queue,
        state: "queued" as const,
      })),
    );

    return [...normalizedActiveStatuses, ...queuedStatuses];
  };

  const loop = async () => {
    while (true) {
      await sleeping;

      const [nextTask, queue, requirements] = (() => {
        for (const [queueType, tasks] of Object.entries(queues)) {
          // Background/implied admission is gated only by the explicit toggle.
          // Load/request backoff is handled by the duty cycle once running, so
          // tasks always start and keep trickling rather than being starved.
          if (
            !processBackgroundTasks &&
            (queueType === "background" || queueType === "implied")
          ) {
            continue;
          }
          // Blocking tasks are user-initiated and must run promptly (e.g. an
          // on-the-fly HLS encode while the player waits). They bypass the
          // notional resource budget: that budget only exists to bound
          // background parallelism, and long-running background processors hold
          // their resources for their entire run, which would otherwise starve
          // a blocking task indefinitely (paused runners don't release them).
          // The duty cycle already frees real CPU/GPU by pausing background work
          // when a user request is in flight.
          const taskIndex =
            queueType === "blocking"
              ? tasks.length > 0
                ? 0
                : -1
              : tasks.findIndex((task) =>
                  canRunTask(
                    resourcesInUse,
                    task.resources ?? getResourceRequirements(task.type),
                    availableMemoryMB,
                  ),
                );
          if (taskIndex !== -1) {
            const task = tasks.splice(taskIndex, 1)[0];
            const requirements = task.resources ?? getResourceRequirements(task.type);
            return [task, queueType as QueueType, requirements] as const;
          }
        }
        return [null, null, {}] as const;
      })();

      if (!nextTask) {
        sleep();
        onQueueExhausted?.();
        continue;
      }

      // Start the task to get the runner
      const runner = nextTask.start();
      const runningTask: RunningTask = {
        name: nextTask.name,
        type: nextTask.type,
        queue,
        priority: nextTask.priority ?? "normal",
        runner,
      };
      runningTasks.add(runningTask);
      logTaskEvent("Started", queue, nextTask.name);
      // A task may start mid-cycle while pressure is on; pause it if we're OFF.
      reconcileBackoff();

      // We don't block because we want to support parallelism
      checkoutResources(resourcesInUse, requirements);
      runner
        .onComplete()
        .catch((err) => {
          log.error({ err, task: nextTask.name, queue }, "Task failed");
        })
        .finally(() => {
          checkInResources(resourcesInUse, requirements);
          runningTasks.delete(runningTask);
          logTaskEvent("Completed", queue, nextTask.name);
          reconcileBackoff(); // pressure may have cleared with this task gone
          wakeUp?.();
        });
    }
  };
  void loop();

  return {
    setPerformBackgroundTasks: (enabled: boolean) => {
      processBackgroundTasks = enabled;
      log.info(`Background tasks ${enabled ? "enabled" : "paused"}`);
      reconcileBackoff();
      if (enabled) wakeUp?.();
    },
    getPerformBackgroundTasks: () => processBackgroundTasks,
    getBackgroundTaskStatus,
    addTask: (task: Task, queue: QueueType) => {
      queues[queue].push(task);
      if (processBackgroundTasks || queues["blocking"].length) {
        wakeUp?.();
      }
    },
    onQueueExhausted: (callback: () => void) => {
      onQueueExhausted = callback;
    },
    noteUserActivity: () => {
      userActiveUntil = now() + ACTIVITY_COOLDOWN_MS;
      reconcileBackoff();
    },
    beginUserRequest: () => {
      activeRequests += 1;
      // Extend the cooldown immediately too, so even a request that ends before
      // the next reconcile still leaves a trailing grace window.
      userActiveUntil = now() + ACTIVITY_COOLDOWN_MS;
      reconcileBackoff();
    },
    endUserRequest: () => {
      activeRequests = Math.max(0, activeRequests - 1);
      userActiveUntil = now() + ACTIVITY_COOLDOWN_MS;
      reconcileBackoff();
    },
  };
};
