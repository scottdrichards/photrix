import type { BackgroundTaskStatus } from "../../../shared/filter-contract/src/index.ts";

export type QueueType = "blocking" | "implied" | "background";
type Resources = "gpu" | "cpu" | "disk" | "network";

type TaskType =
  | "imageConversion"
  | "videoConversion"
  | "mediaMedatadata"
  | "diskInfo"
  | "faceDetection";

const getResourceRequirements = (type?: TaskType): Partial<Record<Resources, number>> => {
  const mappings = {
    imageConversion: { gpu: 0, cpu: 0.25 },
    videoConversion: { gpu: 0.5, cpu: 0.1 },
    mediaMedatadata: { disk: 0.1 },
    diskInfo: { disk: 0.1 },
    faceDetection: { cpu: 1 },
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

export type Task = {
  name: string;
  start: () => TaskRunner;
  type?: TaskType;
};

type RunningTask = {
  name: string;
  type?: TaskType;
  queue: QueueType;
  runner: TaskRunner;
};

export type TaskOrchestrator = {
  // Also implicates implied tasks
  setPerformBackgroundTasks: (enabled: boolean) => void;
  getPerformBackgroundTasks: () => boolean;
  getBackgroundTaskStatus: () => Promise<BackgroundTaskStatus[]>;
  addTask: (task: Task, queue: QueueType) => void;
  onQueueExhausted: (callback: () => void) => void;
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
  console.log(`[TaskOrchestrator] ${event} (${queue}): ${name}`);
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

export const createTaskOrchestrator = (): TaskOrchestrator => {
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
        const status = (await runner.getStatus?.()) ?? {};
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
          if (
            !processBackgroundTasks &&
            (queueType === "background" || queueType === "implied")
          ) {
            continue;
          }
          const taskIndex = tasks.findIndex((task) => {
            const requirements = getResourceRequirements(task.type);
            if (canRunTask(resourcesInUse, requirements)) {
              return true;
            }
          });
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
        runner,
      };
      runningTasks.add(runningTask);
      logTaskEvent("Started", queue, nextTask.name);

      // We don't block because we want to support parallelism
      checkoutResources(resourcesInUse, requirements);
      runner
        .onComplete()
        .catch((err) => {
          console.error(
            "Error processing task. Tasks should handle their own errors.",
            err,
          );
        })
        .finally(() => {
          checkInResources(resourcesInUse, requirements);
          runningTasks.delete(runningTask);
          logTaskEvent("Completed", queue, nextTask.name);
        });
    }
  };
  void loop();

  return {
    setPerformBackgroundTasks: (enabled: boolean) => {
      processBackgroundTasks = enabled;
      console.log(
        `[TaskOrchestrator] Background tasks ${enabled ? "enabled" : "paused"}`,
      );
      if (enabled) {
        wakeUp?.();
      }
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
  };
};
