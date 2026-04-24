import path from "node:path";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { standardHeights, type StandardHeight } from "../common/standardHeights.ts";
import { convertImage } from "../imageProcessing/convertImage.ts";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { processExifMetadata } from "../indexDatabase/processExifMetadata.ts";
import { generateMultibitrateHLS } from "../videoProcessing/generateMultibitrateHLS.ts";
import { generateVideoThumbnail } from "../videoProcessing/videoUtils.ts";

type QueueSummaryByMedia = {
  image: {
    count: number;
    sizeBytes: number;
  };
  video: {
    count: number;
    sizeBytes: number;
    durationMilliseconds: number;
  };
};

export type TaskQueueSummary = {
  completed: QueueSummaryByMedia;
  active: QueueSummaryByMedia;
  userBlocked: QueueSummaryByMedia;
  userImplicit: QueueSummaryByMedia;
  background: QueueSummaryByMedia;
};

const queueSummaryGroups = [
  "completed",
  "active",
  "userBlocked",
  "userImplicit",
  "background",
] as const;

type QueueSummaryGroup = (typeof queueSummaryGroups)[number];
type QueueSummaryGroupWithoutCompleted = Exclude<QueueSummaryGroup, "completed">;

type MediaType = "image" | "video";
type QueueType = "blocking" | "implied" | "background";

export type HLSTask = {
  type: "hls";
  relativePath: string;
  mediaType?: MediaType;
};

export type ImageConversionTask = {
  type: "image";
  relativePath: string;
  height: StandardHeight[] | StandardHeight;
  mediaType?: MediaType;
};

type Task = {
  type: "hls" | "image";
  onComplete?: () => void;
} & (HLSTask | ImageConversionTask);

export type TaskOrchestrator = {
  setProcessBackgroundTasks: (enabled: boolean) => void;
  getProcessBackgroundTasks: () => boolean;
  getQueueSummary: () => TaskQueueSummary;
  addTask: (task: HLSTask | ImageConversionTask, queue?: "blocking" | "implied") => void;
};

const emptyQueueSummaryByMedia: QueueSummaryByMedia = {
  image: { count: 0, sizeBytes: 0 },
  video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
};

const emptyTaskQueueSummary = Object.fromEntries(
  queueSummaryGroups.map((group) => [group, emptyQueueSummaryByMedia]),
) as TaskQueueSummary;

const orchestratorLogPrefix = "[orchestrator]";

const describeTask = (task: Task) =>
  `${task.type}:${task.relativePath}${
    task.type === "image"
      ? `:${Array.isArray(task.height) ? task.height.join(",") : task.height}`
      : ""
  }`;

const summarizeQueueCounts = (
  blockingTasks: Task[],
  impliedTasks: Task[],
  backgroundTasks: Task[],
  activeTask: Task | null,
) =>
  `blocking=${blockingTasks.length}, implied=${impliedTasks.length}, background=${backgroundTasks.length}, active=${activeTask ? 1 : 0}`;

const getTaskMediaType = (task: Task): MediaType =>
  task.mediaType ?? (task.type === "hls" ? "video" : "image");

const incrementSummary = (
  summary: QueueSummaryByMedia,
  mediaType: MediaType,
  countDelta: number,
) => {
  if (mediaType === "image") {
    summary.image = {
      ...summary.image,
      count: summary.image.count + countDelta,
    };
    return;
  }

  summary.video = {
    ...summary.video,
    count: summary.video.count + countDelta,
  };
};

const countTasksByMedia = (tasks: Task[]): QueueSummaryByMedia =>
  tasks.reduce(
    (summary, task) => {
      incrementSummary(summary, getTaskMediaType(task), 1);
      return summary;
    },
    {
      ...emptyQueueSummaryByMedia,
      image: { ...emptyQueueSummaryByMedia.image },
      video: { ...emptyQueueSummaryByMedia.video },
    },
  );

const runConversionTask = async (database: IndexDatabase, task: Task) => {
  const { relativePath } = task;
  console.log(
    `${orchestratorLogPrefix} Running ${describeTask(task)}: loading file record`,
  );
  const record = await database.getFileRecord(relativePath);
  if (!record) {
    console.warn(`${orchestratorLogPrefix} No file record found for ${relativePath}`);
    return;
  }

  const fullPath = path.join(database.storagePath, stripLeadingSlash(relativePath));
  console.log(
    `${orchestratorLogPrefix} Loaded file record for ${relativePath} mimeType=${record.mimeType ?? "unknown"}`,
  );

  switch (task.type) {
    case "hls":
      await generateMultibitrateHLS(fullPath);
      return;
    case "image":
      for (const height of Array.isArray(task.height) ? task.height : [task.height]) {
        if (record.mimeType?.startsWith("video/")) {
          await generateVideoThumbnail(fullPath, height);
          return;
        }
        await convertImage(fullPath, height);
      }
      return;
  }
};

/** Gets the next set of image conversion tasks or HLS task from the database */
const getNextBackgroundTasks = async (db: IndexDatabase): Promise<Task | null> => {
  const backgroundTask = await db.getNextBackgroundTask();
  if (!backgroundTask) return null;
  if (backgroundTask.type === "imageVariants") {
    return {
      type: "image",
      relativePath: backgroundTask.relativePath,
      height: standardHeights.filter((h) => typeof h === "number"),
      mediaType: backgroundTask.mimeType.startsWith("video/") ? "video" : "image",
      onComplete: () => void db.markImageVariantsGenerated(backgroundTask.relativePath),
    };
  } else if (backgroundTask.type === "hls") {
    return {
      type: "hls",
      relativePath: backgroundTask.relativePath,
      mediaType: "video",
      onComplete: () => void db.markHLSGenerated(backgroundTask.relativePath),
    };
  }
  return null;
};

export const createTaskOrchestrator = (db: IndexDatabase): TaskOrchestrator => {
  let processBackgroundTasks = true;
  // Active (user-requested) and implied request stacks — processed LIFO
  const blockingTasks: Task[] = [];
  const impliedTasks: Task[] = [];
  const backgroundTasks: Task[] = [];
  const completedTasks: QueueSummaryByMedia = {
    ...emptyQueueSummaryByMedia,
    image: { ...emptyQueueSummaryByMedia.image },
    video: { ...emptyQueueSummaryByMedia.video },
  };
  let activeTask: Task | null = null;

  const resolversSleeping: Array<() => void> = [];

  const wake = () => {
    if (resolversSleeping.length > 0) {
      console.log(
        `${orchestratorLogPrefix} Waking ${resolversSleeping.length} sleeping loop resolver(s)`,
      );
    }
    resolversSleeping.forEach((resolve) => resolve());
    resolversSleeping.length = 0;
  };

  const loop = async () => {
    console.log(`${orchestratorLogPrefix} Processing loop started`);
    while (true) {
      let task: Task | null = null;
      let queueType: QueueType | null = null;

      if (blockingTasks.length > 0) {
        task = blockingTasks.pop() ?? null;
        queueType = "blocking";
      } else if (processBackgroundTasks && impliedTasks.length > 0) {
        task = impliedTasks.pop() ?? null;
        queueType = "implied";
      } else if (processBackgroundTasks && backgroundTasks.length > 0) {
        task = backgroundTasks.pop() ?? null;
        queueType = "background";
      }

      if (!task) {
        if (!processBackgroundTasks) {
          console.log(
            `${orchestratorLogPrefix} Idle: background processing disabled; ${summarizeQueueCounts(
              blockingTasks,
              impliedTasks,
              backgroundTasks,
              activeTask,
            )}`,
          );
          // Don't poll the database while disabled; just sleep until woken
          // by an enqueued blocking/implied task or a flag change.
          await new Promise<void>((resolve) => {
            resolversSleeping.push(resolve);
          });
          continue;
        }

        const backgroundLoadStartTime = Date.now();
        const newBackgroundTasks = await getNextBackgroundTasks(db);
        const backgroundLoadDurationMs = Date.now() - backgroundLoadStartTime;

        if (!newBackgroundTasks) {
          if (backgroundLoadDurationMs > 50 || !processBackgroundTasks) {
            console.log(
              `${orchestratorLogPrefix} No background task fetched (${backgroundLoadDurationMs}ms); sleeping; ${summarizeQueueCounts(
                blockingTasks,
                impliedTasks,
                backgroundTasks,
                activeTask,
              )}`,
            );
          }

          await new Promise<void>((resolve) => {
            resolversSleeping.push(resolve);
          });
          continue;
        }

        console.log(
          `${orchestratorLogPrefix} Pulled background task ${describeTask(newBackgroundTasks)} (${backgroundLoadDurationMs}ms db fetch)`,
        );

        backgroundTasks.push(
          ...(Array.isArray(newBackgroundTasks)
            ? newBackgroundTasks
            : [newBackgroundTasks]),
        );

        console.log(
          `${orchestratorLogPrefix} Background queue updated: ${summarizeQueueCounts(
            blockingTasks,
            impliedTasks,
            backgroundTasks,
            activeTask,
          )}`,
        );
        continue;
      }

      try {
        activeTask = task;
        const taskStartTime = Date.now();
        console.log(
          `${orchestratorLogPrefix} Starting ${describeTask(task)} from ${queueType} queue; ${summarizeQueueCounts(
            blockingTasks,
            impliedTasks,
            backgroundTasks,
            activeTask,
          )}`,
        );

        await runConversionTask(db, task);

        task.onComplete?.();
        incrementSummary(completedTasks, getTaskMediaType(task), 1);
        console.log(
          `${orchestratorLogPrefix} Completed ${describeTask(task)} in ${Date.now() - taskStartTime}ms`,
        );
      } catch (error) {
        console.error(
          `${orchestratorLogPrefix} Task failed (${task.type}) for ${task.relativePath}`,
          error,
        );
      } finally {
        console.log(
          `${orchestratorLogPrefix} Clearing active task for ${describeTask(task)}; ${summarizeQueueCounts(
            blockingTasks,
            impliedTasks,
            backgroundTasks,
            activeTask,
          )}`,
        );
        activeTask = null;
      }
    }
  };

  void loop();

  void processExifMetadata(db, () =>
    processBackgroundTasks
      ? Promise.resolve()
      : new Promise<void>((resolve) => resolversSleeping.push(resolve)),
  );

  return {
    setProcessBackgroundTasks: (enabled: boolean) => {
      console.log(
        `${orchestratorLogPrefix} setProcessBackgroundTasks: ${processBackgroundTasks} -> ${enabled}`,
      );
      processBackgroundTasks = enabled;
      if (enabled) {
        wake();
      }
    },
    getProcessBackgroundTasks: () => processBackgroundTasks,
    getQueueSummary: () => {
      const tasksByGroup = {
        active: activeTask ? [activeTask] : [],
        userBlocked: blockingTasks,
        userImplicit: impliedTasks,
        background: backgroundTasks,
      } as const satisfies Record<QueueSummaryGroupWithoutCompleted, Task[]>;

      const groupedSummary = Object.fromEntries(
        Object.entries(tasksByGroup).map(([group, tasks]) => [
          group,
          countTasksByMedia(tasks),
        ]),
      ) as Pick<TaskQueueSummary, QueueSummaryGroupWithoutCompleted>;

      return {
        ...emptyTaskQueueSummary,
        completed: {
          ...completedTasks,
        },
        ...groupedSummary,
      };
    },
    addTask: (task: Task, queue: "blocking" | "implied" = "blocking") => {
      if (queue === "blocking") {
        blockingTasks.push(task);
      } else {
        impliedTasks.push(task);
      }

      console.log(
        `${orchestratorLogPrefix} Enqueued ${describeTask(task)} into ${queue}; ${summarizeQueueCounts(
          blockingTasks,
          impliedTasks,
          backgroundTasks,
          activeTask,
        )}`,
      );

      wake();
    },
  };
};
