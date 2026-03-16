import { isBackgroundTasksEnabled } from "./backgroundTasksControl.ts";

const priorityList = ["userBlocked", "userImplicit", "background"] as const;
export type QueuePriority = (typeof priorityList)[number];

const mediaTypeList = ["image", "video"] as const;
export type MediaType = (typeof mediaTypeList)[number];

const concurrency = 4;

export type QueueTask<TResult = void> = {
  fn: () => Promise<TResult>;
  priority: QueuePriority;
  mediaType: MediaType;
  sizeBytes: number;
} & ({ mediaType: "image" } | { mediaType: "video"; durationMilliseconds: number });

/**
 * A queue that processes tasks sequentially with optional concurrency limit.
 * Each task is a function that returns a Promise.
 */
export class ProcessingQueue {
  private queue: Array<QueueTask<unknown>> = [];
  private activeTasks: Array<QueueTask<unknown>> = [];

  private readonly concurrency: number;

  constructor(concurrency = 2) {
    this.concurrency = concurrency;
  }

  /**
   * Note: does not yet deduplicate the tasks. Might be useful in the future, but will require an observer/subscriber pattern to avoid duplicate work but allow
   * multiple callers to await the same task result.
   */
  async enqueue<TResult = void>(task: QueueTask<TResult>): Promise<TResult> {
    const priorityIndex = priorityList.indexOf(task.priority);
    const mediaTypeIndex = mediaTypeList.indexOf(task.mediaType);

    // Keep queue ordered by priority/mediaType. Within a matching bucket,
    // userBlocked tasks are true LIFO, others remain FIFO.
    let insertIndex = 0;
    for (; insertIndex < this.queue.length; insertIndex++) {
      const currentTask = this.queue[insertIndex];
      const currentPriorityIndex = priorityList.indexOf(currentTask.priority);
      const currentMediaTypeIndex = mediaTypeList.indexOf(currentTask.mediaType);

      if (currentPriorityIndex < priorityIndex) {
        continue;
      }
      if (currentPriorityIndex > priorityIndex) {
        break;
      }
      if (task.priority === "userBlocked") {
        // Always do LIFO for userBlocked, ignore media type
        break;
      }
      // Otherwise let's look at media type
      if (currentMediaTypeIndex < mediaTypeIndex) {
        continue;
      }
      if (currentMediaTypeIndex > mediaTypeIndex) {
        break;
      }
    }

    const result = new Promise<TResult>((resolve, reject) => {
      const wrappedTask: QueueTask<unknown> = {
        ...task,
        fn: async () => {
          try {
            const result = await task.fn();
            resolve(result);
          } catch (error) {
            reject(error);
          }
        },
      };

      // Insert the task at the computed insertIndex
      this.queue.splice(insertIndex, 0, wrappedTask);
    });

    this.processNext();
    // Might want to return the result promise as well as some queue estimation in the future
    return result;
  }

  private async processNext(): Promise<void> {
    // Might want to exit a low-priority task in favor of a highpriority one someday. For example, if a
    // video conversion is taking a long time, cancel it to free up resources for a userBlocked image task that just came in.

    if (this.activeTasks.length >= this.concurrency) {
      return;
    }

    if (!isBackgroundTasksEnabled()) {
      this.queue = this.queue.filter((task) => task.priority !== "background");
    }

    const task = this.queue.shift();
    if (!task) {
      return;
    }

    this.activeTasks.push(task);
    try {
      await task.fn();
    } catch (error) {
      console.error("[ProcessingQueue] Task failed:", error);
    } finally {
      const taskIndex = this.activeTasks.indexOf(task);
      this.activeTasks.splice(taskIndex, 1);
      this.processNext(); // Process next task
    }
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getProcessing(): number {
    return this.activeTasks.length;
  }
}

// Global queue for image/video processing
export const mediaProcessingQueue = new ProcessingQueue(concurrency);
