const priorityList = ["userBlocked", "userImplicit", "background"] as const;
export type QueuePriority = (typeof priorityList)[number];

const mediaTypeList = ["image", "video"] as const;
export type MediaType = (typeof mediaTypeList)[number];

type QueueTask = {
  fn: () => Promise<void>;
  priority: QueuePriority;
  mediaType: MediaType;
  conversionUnits: {
    imageCount: number;
    videoSeconds: number;
  };
};

type ConversionUnitsInput = {
  imageCount?: number;
  videoSeconds?: number;
};

type ConversionUnits = {
  imageCount: number;
  videoSeconds: number;
};

const emptyConversionUnits = (): ConversionUnits => ({
  imageCount: 0,
  videoSeconds: 0,
});

const addConversionUnits = (
  left: ConversionUnits,
  right: ConversionUnits,
): ConversionUnits => ({
  imageCount: left.imageCount + right.imageCount,
  videoSeconds: left.videoSeconds + right.videoSeconds,
});

const subtractConversionUnits = (
  left: ConversionUnits,
  right: ConversionUnits,
): ConversionUnits => ({
  imageCount: Math.max(0, left.imageCount - right.imageCount),
  videoSeconds: Math.max(0, left.videoSeconds - right.videoSeconds),
});

const normalizeConversionUnits = (
  mediaType: MediaType,
  units?: ConversionUnitsInput,
): ConversionUnits => ({
  imageCount: Math.max(
    0,
    units?.imageCount ?? (mediaType === "image" ? 1 : 0),
  ),
  videoSeconds: Math.max(
    0,
    Number.isFinite(units?.videoSeconds) ? (units?.videoSeconds ?? 0) : 0,
  ),
});

const sumConversionUnits = (tasks: Array<QueueTask>): ConversionUnits =>
  tasks.reduce(
    (acc, task) => addConversionUnits(acc, task.conversionUnits),
    emptyConversionUnits(),
  );

/**
 * A queue that processes tasks sequentially with optional concurrency limit.
 * Each task is a function that returns a Promise.
 */
export class ProcessingQueue {
  private queue: Array<QueueTask> = [];
  private activeTasks: Array<QueueTask> = [];
  private processing = 0;
  private readonly concurrency: number;
  private paused = false;
  private pauseUntil = 0;
  private pauseTimer: NodeJS.Timeout | null = null;
  private enqueuedTotals: ConversionUnits = emptyConversionUnits();
  private completedTotals: ConversionUnits = emptyConversionUnits();

  constructor(concurrency = 2) {
    this.concurrency = concurrency;
  }

  /**
   * Pause the queue for the specified duration in milliseconds.
   * High priority tasks will still process during pause.
   */
  pause(durationMs: number): void {
    this.paused = true;
    this.pauseUntil = Date.now() + durationMs;
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    console.log(`[ProcessingQueue] Paused for ${durationMs}ms`);
  }

  private isPausedForPriority(priority: QueuePriority): boolean {
    if (!this.paused) {
      return false;
    }

    if (Date.now() >= this.pauseUntil) {
      this.paused = false;
      if (this.pauseTimer) {
        clearTimeout(this.pauseTimer);
        this.pauseTimer = null;
      }
      console.log(`[ProcessingQueue] Resumed`);
      return false;
    }

    // During pause, allow higher priority work to keep the UI responsive.
    return priority === "background";
  }

  private schedulePauseWake(): void {
    if (this.pauseTimer) {
      return;
    }
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      void this.processNext();
    }, 100);
  }

  async enqueue<T>(
    task: () => Promise<T>,
    priority: QueuePriority = "background",
    mediaType: MediaType = "image",
    conversionUnits?: ConversionUnitsInput,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const priorityIndex = priorityList.indexOf(priority);
      const mediaTypeIndex = mediaTypeList.indexOf(mediaType);
      const normalizedConversionUnits = normalizeConversionUnits(
        mediaType,
        conversionUnits,
      );

      // LIFO within a given priority/mediaType bucket: insert just after the last
      // task of the same priority/mediaType (or at the front of that bucket) so the
      // most recently enqueued at that level is processed next.
      const insertIndex = (() => {
        for (let i = this.queue.length - 1; i >= 0; i--) {
          const t = this.queue[i];
          const tPriorityIndex = priorityList.indexOf(t.priority);
          const tMediaTypeIndex = mediaTypeList.indexOf(t.mediaType);
          if (tPriorityIndex === priorityIndex && tMediaTypeIndex === mediaTypeIndex) {
            return i + 1;
          }
          if (
            tPriorityIndex > priorityIndex ||
            (tPriorityIndex === priorityIndex && tMediaTypeIndex > mediaTypeIndex)
          ) {
            // Keep scanning upward until we find the bucket boundary
            continue;
          }
          // We crossed into higher-priority bucket; insert here to keep ordering
          return i + 1;
        }
        return 0;
      })();

      const fn = async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };

      this.queue.splice(insertIndex === -1 ? this.queue.length : insertIndex, 0, {
        priority,
        mediaType,
        fn,
        conversionUnits: normalizedConversionUnits,
      });
      this.enqueuedTotals = addConversionUnits(
        this.enqueuedTotals,
        normalizedConversionUnits,
      );
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const nextTask = this.queue[0];
    if (nextTask && this.isPausedForPriority(nextTask.priority)) {
      this.schedulePauseWake();
      return;
    }

    this.processing++;
    const task = this.queue.shift();

    const queueStatus = this.queue.reduce(
      (acc, task) => {
        acc[task.priority] = (acc[task.priority] || 0) + 1;
        return acc;
      },
      {} as Record<QueuePriority, number>,
    );

    console.log(
      `[ProcessingQueue] Processing next task. Queue status: ${JSON.stringify(queueStatus)}, Currently processing: ${this.processing}`,
    );

    if (task) {
      this.activeTasks.push(task);
      try {
        await task.fn();
      } catch (error) {
        console.error("[ProcessingQueue] Task failed:", error);
      } finally {
        this.activeTasks = this.activeTasks.filter((entry) => entry !== task);
        this.completedTotals = addConversionUnits(
          this.completedTotals,
          task.conversionUnits,
        );
        this.processing--;
        this.processNext(); // Process next task
      }
    }
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getProcessing(): number {
    return this.processing;
  }

  getConversionStatus(): {
    overall: {
      images: { remaining: number; total: number };
      videoSeconds: { remaining: number; total: number };
    };
    queued: {
      images: { remaining: number; total: number };
      videoSeconds: { remaining: number; total: number };
    };
  } {
    const queuedTotals = sumConversionUnits(this.queue);
    const processingTotals = sumConversionUnits(this.activeTasks);
    const remainingOverall = subtractConversionUnits(
      this.enqueuedTotals,
      this.completedTotals,
    );

    return {
      overall: {
        images: {
          remaining: remainingOverall.imageCount,
          total: this.enqueuedTotals.imageCount,
        },
        videoSeconds: {
          remaining: remainingOverall.videoSeconds,
          total: this.enqueuedTotals.videoSeconds,
        },
      },
      queued: {
        images: {
          remaining: queuedTotals.imageCount,
          total: queuedTotals.imageCount + processingTotals.imageCount,
        },
        videoSeconds: {
          remaining: queuedTotals.videoSeconds,
          total: queuedTotals.videoSeconds + processingTotals.videoSeconds,
        },
      },
    };
  }
}

// Global queue for image/video processing
export const mediaProcessingQueue = new ProcessingQueue(4);
