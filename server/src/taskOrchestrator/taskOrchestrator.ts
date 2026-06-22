import type { BackgroundTaskStatus } from "../../../shared/filter-contract/src/index.ts";
import { getLogger } from "../observability/logger.ts";
import { isSystemOverloaded } from "./systemLoad.ts";

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
type Resources = "gpu" | "cpu" | "disk" | "network";

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
    imageAnalysis: { cpu: 0.75 },
    audioTranscription: { gpu: 0.5, cpu: 0.5 },
    audioEmbedding: { gpu: 0.5, cpu: 0.5 },
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
};

const canRunTask = (
  state: Record<Resources, number>,
  requirements: Partial<Record<Resources, number>>,
) =>
  Object.entries(requirements).every(
    ([resource, amount]) => state[resource as Resources] + (amount ?? 0) <= 1,
  );

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

const describeStatusError = (error: unknown) => {
  if (error instanceof Error && error.message) {
    return `Status unavailable: ${error.message}`;
  }
  return "Status unavailable";
};

// A task's getStatus() may query the DB or a worker; cap how long the status
// endpoint will wait so one slow/stuck task can't freeze every poller.
const STATUS_TIMEOUT_MS = 2_000;
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Status timed out")),
      ms,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export type TaskOrchestratorOptions = {
  // Injectable for tests/determinism. Default to real wall-clock and load.
  isOverloaded?: () => boolean;
  now?: () => number;
  dutyOnMs?: number;
  dutyOffMs?: number;
};

export const createTaskOrchestrator = (
  options: TaskOrchestratorOptions = {},
): TaskOrchestrator => {
  const isOverloaded = options.isOverloaded ?? isSystemOverloaded;
  const now = options.now ?? Date.now;
  const dutyOnMs = options.dutyOnMs ?? DUTY_ON_MS;
  const dutyOffMs = options.dutyOffMs ?? DUTY_OFF_MS;

  const queues: Record<QueueType, Task[]> = {
    blocking: [],
    implied: [],
    background: [],
  };

  const runningTasks = new Set<RunningTask>();

  let sleeping: Promise<void> | null = null;
  let wakeUp: (() => void) | null = null;
  const sleep = () => {
    sleeping = new Promise((resolve) => {
      wakeUp = resolve;
    });
  };

  let processBackgroundTasks = true;

  let onQueueExhausted: (() => void) | null = null;

  // Backoff is a *duty cycle*, never a hard stop: background work always keeps
  // making progress, it just pauses for part of each cycle when the system is
  // under pressure so requests stay responsive and the box isn't pegged.
  //
  // Two pressure sources, applied per task priority:
  //   - userActive(): a recent user request. ALL background/implied tasks yield
  //     (including high-priority ones) so the request is served promptly.
  //   - isOverloaded(): high system load. Only normal-priority tasks back off;
  //     high-priority tasks (e.g. the filesystem scan) keep running full speed.
  let userActiveUntil = 0;
  const userActive = () => now() < userActiveUntil;

  const taskUnderPressure = (priority: TaskPriority) =>
    userActive() || (priority !== "high" && isOverloaded());

  const anyPressure = () =>
    [...runningTasks].some(
      ({ queue, priority }) => queue !== "blocking" && taskUnderPressure(priority),
    );

  // During the OFF phase, pause each pressured background/implied runner; resume
  // it otherwise. Pause/resume on the controllers are idempotent and only take
  // effect at the runner's next chunk boundary.
  let dutyOff = false;
  const applyDutyCycle = () => {
    for (const { queue, priority, runner } of runningTasks) {
      if (queue !== "background" && queue !== "implied") continue;
      if (dutyOff && taskUnderPressure(priority)) runner.pause?.();
      else void runner.resume?.();
    }
  };

  let dutyTimer: ReturnType<typeof setTimeout> | null = null;
  const stopDutyCycle = () => {
    if (dutyTimer) {
      clearTimeout(dutyTimer);
      dutyTimer = null;
    }
    dutyOff = false;
    applyDutyCycle(); // resume everything
  };
  const scheduleDutyFlip = () => {
    dutyTimer = setTimeout(() => {
      dutyTimer = null;
      if (!processBackgroundTasks) return; // explicit pause owns the runners
      if (!anyPressure()) {
        stopDutyCycle();
        wakeUp?.();
        return;
      }
      dutyOff = !dutyOff;
      applyDutyCycle();
      if (!dutyOff) wakeUp?.(); // entering ON: nudge the loop to admit/resume
      scheduleDutyFlip();
    }, dutyOff ? dutyOffMs : dutyOnMs);
    dutyTimer.unref?.();
  };

  // Reconcile the duty cycle with the current pressure/enabled state. Safe to
  // call after any change: a request arrives, a task starts/ends, or the
  // background toggle flips.
  const reconcileBackoff = () => {
    if (!processBackgroundTasks) {
      // Explicit pause: stop cycling and hard-pause all background/implied work.
      if (dutyTimer) {
        clearTimeout(dutyTimer);
        dutyTimer = null;
      }
      dutyOff = false;
      for (const { queue, runner } of runningTasks) {
        if (queue === "background" || queue === "implied") runner.pause?.();
      }
      return;
    }
    if (anyPressure()) {
      if (!dutyTimer) {
        // Begin with an OFF rest so an incoming request is served immediately.
        dutyOff = true;
        applyDutyCycle();
        scheduleDutyFlip();
      } else {
        applyDutyCycle(); // catch tasks that started mid-cycle
      }
    } else {
      stopDutyCycle();
    }
  };

  const resourcesInUse: Record<Resources, number> = {
    gpu: 0,
    cpu: 0,
    disk: 0,
    network: 0,
  };

  const getBackgroundTaskStatus = async (): Promise<BackgroundTaskStatus[]> => {
    const activeTasks = [...runningTasks].filter(
      ({ queue }) => queue === "background" || queue === "implied",
    );

    const activeStatuses = await Promise.allSettled(
      activeTasks.map(async ({ name, queue, runner }) => {
        const status = runner.getStatus
          ? await withTimeout(runner.getStatus(), STATUS_TIMEOUT_MS)
          : {};
        const portionComplete = normalizeProgressValue(status.portionComplete);

        return {
          id: `${queue}:${name}`,
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
      }),
    );

    const normalizedActiveStatuses = activeStatuses.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      }

      const task = activeTasks[index];
      return {
        id: `${task?.queue}:${task?.name}`,
        name: task?.name ?? "Unknown task",
        queue: (task?.queue ?? "background") as Extract<
          QueueType,
          "background" | "implied"
        >,
        state: "running" as const,
        description: describeStatusError(result.reason),
      } satisfies BackgroundTaskStatus;
    });

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
                  canRunTask(resourcesInUse, getResourceRequirements(task.type)),
                );
          if (taskIndex !== -1) {
            const task = tasks.splice(taskIndex, 1)[0];
            const requirements = getResourceRequirements(task.type);
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
  };
};
