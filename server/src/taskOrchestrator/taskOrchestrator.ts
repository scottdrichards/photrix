type QueueType = "blocking" | "implied" | "background";
type Resources = "gpu" | "cpu" | "disk" | "network";

type TaskType = "imageConversion" | "videoConversion" | "mediaMedatadata" | "diskInfo";

const getResourceRequirements = (task: Task): Partial<Record<Resources, number>> => {
  const mappings = {
    imageConversion: { gpu: 0, cpu: 0.25 },
    videoConversion: { gpu: 1, cpu: 0.1 },
    mediaMedatadata: { disk: 0.1 },
    diskInfo: { disk: 0.1 },
  };
  return mappings[task.type] || {};
};

type Task = {
  fn: () => Promise<void>;
  type: TaskType;
};

export type TaskOrchestrator = {
  // Also implicates implied tasks
  setPerformBackgroundTasks: (enabled: boolean) => void;
  getPerformBackgroundTasks: () => boolean;
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

export const createTaskOrchestrator = (): TaskOrchestrator => {
  const queues: Record<QueueType, Task[]> = {
    blocking: [],
    implied: [],
    background: [],
  };

  let sleeping: Promise<void> | null = null;
  let wakeUp: (() => void) | null = null;
  const sleep = () => {
    sleeping = new Promise((resolve) => {
      wakeUp = resolve;
    });
  };

  let processBackgroundTasks = false;

  let onQueueExhausted: (() => void) | null = null;

  const resourcesInUse: Record<Resources, number> = {
    gpu: 0,
    cpu: 0,
    disk: 0,
    network: 0,
  };

  const loop = async () => {
    while (true) {
      await sleeping;

      const [nextTask, requirements] = (() => {
        for (const [queueType, tasks] of Object.entries(queues)) {
          if (
            !processBackgroundTasks &&
            (queueType === "background" || queueType === "implied")
          ) {
            continue;
          }
          const taskIndex = tasks.findIndex((task) => {
            const requirements = getResourceRequirements(task);
            if (canRunTask(resourcesInUse, requirements)) {
              return true;
            }
          });
          if (taskIndex !== -1) {
            const task = tasks.splice(taskIndex, 1)[0];
            const requirements = getResourceRequirements(task);
            return [task, requirements] as const;
          }
        }
        return [null, {}] as const;
      })();

      if (!nextTask) {
        sleep();
        onQueueExhausted?.();
        continue;
      }

      // We don't block because we want to support parallelism
      checkoutResources(resourcesInUse, requirements);
      nextTask
        .fn()
        .catch((err) => {
          console.error(
            "Error processing task. Tasks should handle their own errors.",
            err,
          );
        })
        .finally(() => {
          checkInResources(resourcesInUse, requirements);
        });
    }
  };
  void loop();

  return {
    setPerformBackgroundTasks: (enabled: boolean) => {
      processBackgroundTasks = enabled;
      if (enabled) {
        wakeUp?.();
      }
    },
    getPerformBackgroundTasks: () => processBackgroundTasks,
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
