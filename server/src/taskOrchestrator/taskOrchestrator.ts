type QueueType = "blocking" | "implied" | "background";
type Resources = "gpu" | "cpu" | "disk" | "network";

type TaskType = "imageConversion" | "videoConversion" | "mediaMedatadata" | "diskInfo";

const getResourceRequirements = (type?: TaskType): Partial<Record<Resources, number>> => {
  const mappings = {
    imageConversion: { gpu: 0, cpu: 0.25 },
    videoConversion: { gpu: 1, cpu: 0.1 },
    mediaMedatadata: { disk: 0.1 },
    diskInfo: { disk: 0.1 },
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

const fitLineToTerminalWidth = (line: string) => {
  if (!process.stdout.isTTY) {
    return line;
  }

  const maxWidth = Math.max(1, process.stdout.columns - 1);
  return line.length > maxWidth
    ? line.slice(0, maxWidth - 3) + "..."
    : line + " ".repeat(maxWidth - line.length);
};

const abbreviateCount = (value: number) => {
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}m`;
  }

  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10}k`;
  }

  return String(value);
};

const titleCase = (value: string) => value[0]?.toUpperCase() + value.slice(1);

const compactTaskName = (queue: QueueType, name: string) => {
  const compactQueue = titleCase(queue);
  const compactName = name
    .replace(/ metadata processing/gi, "")
    .replace(/ file system /gi, " ")
    .replace(/\s+/g, "-")
    .replace(/^-|-$/g, "");
  return `${compactQueue}-${compactName}`;
};

const renderProgressBar = (portionComplete: number, width = 10) => {
  const clamped = Math.max(0, Math.min(1, portionComplete));
  const markerIndex = Math.min(width - 1, Math.round(clamped * (width - 1)));

  return Array.from({ length: width }, (_unused, index) => {
    if (index < markerIndex) {
      return "-";
    }
    if (index === markerIndex) {
      return "|";
    }
    return " ";
  }).join("");
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

  let previousStatusLineCount = 0;

  const renderStatusLines = (lines: string[]) => {
    if (!process.stdout.isTTY) {
      console.log(lines.join("\n"));
      return;
    }

    const nextLineCount = lines.length;
    const linesToRender = Math.max(previousStatusLineCount, nextLineCount);
    const extraClearedLines = Math.max(0, previousStatusLineCount - nextLineCount);
    const prefix =
      previousStatusLineCount > 0 ? `\u001b[${previousStatusLineCount}F` : "";
    const body = Array.from({ length: linesToRender }, (_unused, index) => {
      const line = lines[index] ?? "";
      return `\u001b[2K${fitLineToTerminalWidth(line)}\n`;
    }).join("");
    const shrinkCursor = extraClearedLines > 0 ? `\u001b[${extraClearedLines}F` : "";
    process.stdout.write(prefix + body + shrinkCursor);
    previousStatusLineCount = nextLineCount;
  };

  const clearStatusLines = () => {
    if (previousStatusLineCount === 0) {
      return;
    }

    if (!process.stdout.isTTY) {
      previousStatusLineCount = 0;
      return;
    }

    const blank = fitLineToTerminalWidth("") + "\n";
    const clearBody = Array.from({ length: previousStatusLineCount }, () => blank).join(
      "",
    );
    process.stdout.write(
      `\u001b[${previousStatusLineCount}F${clearBody}\u001b[${previousStatusLineCount}F`,
    );
    previousStatusLineCount = 0;
  };

  const statusReportIntervalMs = 200;
  let renderingStatus = false;

  const renderTaskStatuses = async () => {
    if (renderingStatus) {
      return;
    }

    renderingStatus = true;

    const tasks = [...runningTasks];
    try {
      if (!tasks.length) {
        clearStatusLines();
        return;
      }

      const header = `Task status report (${tasks.length} active)`;
      const lines = await Promise.all(
        tasks.map(async ({ name, type: _type, queue, runner }, index) => {
          const status = (await runner.getStatus?.()) ?? {};
          const label = `${index + 1}. ${compactTaskName(queue, name)}`;
          const portionText =
            status.portionComplete != null
              ? `${Math.round(Math.max(0, Math.min(1, status.portionComplete)) * 100)}%`
              : null;
          const bar =
            status.portionComplete != null
              ? `[${renderProgressBar(status.portionComplete)}]`
              : null;
          const counts =
            status.itemsProcessed != null && status.total != null
              ? `${abbreviateCount(status.itemsProcessed)}/${abbreviateCount(status.total)}`
              : status.itemsProcessed != null
                ? abbreviateCount(status.itemsProcessed)
                : status.total != null
                  ? `?/${abbreviateCount(status.total)}`
                  : null;
          const state =
            status.state && status.state !== "running" ? `[${status.state}]` : null;
          const description = status.description ?? null;

          return [label + ":", portionText, bar, counts, state, description]
            .filter(Boolean)
            .join(" ");
        }),
      );

      renderStatusLines([header, ...lines]);
    } finally {
      renderingStatus = false;
    }
  };

  const statusReporter = setInterval(() => {
    void renderTaskStatuses();
  }, statusReportIntervalMs);
  statusReporter.unref?.();

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
