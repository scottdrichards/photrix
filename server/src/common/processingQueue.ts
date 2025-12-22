const priorityList = ['userBlocked', 'userImplicit', 'background'] as const;
export type QueuePriority = typeof priorityList[number];

type QueueTask = {
  fn: () => Promise<void>;
  priority: QueuePriority;
};

/**
 * A queue that processes tasks sequentially with optional concurrency limit.
 * Each task is a function that returns a Promise.
 */
export class ProcessingQueue {
  private queue: Array<QueueTask> = [];
  private processing = 0;
  private readonly concurrency: number;
  private paused = false;
  private pauseUntil = 0;
  private pauseTimer: NodeJS.Timeout | null = null;

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

  async enqueue<T>(task: () => Promise<T>, priority: QueuePriority = 'background'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const priorityIndex = priorityList.indexOf(priority);
      const insertIndex = this.queue.findIndex(
        // We want to put it at the back of the same priority level
        t => priorityList.indexOf(t.priority) > priorityIndex
      );

      const fn = async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }

      this.queue.splice(insertIndex === -1 ? this.queue.length : insertIndex, 0, {
        priority,
        fn
      });
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

    const queueStatus = this.queue.reduce((acc, task) => {
      acc[task.priority] = (acc[task.priority] || 0) + 1;
      return acc;
    }, {} as Record<QueuePriority, number>);

    console.log(`[ProcessingQueue] Processing next task. Queue status: ${JSON.stringify(queueStatus)}, Currently processing: ${this.processing}`);

    if (task) {
      try {
        await task.fn();
      } catch (error) {
        console.error('[ProcessingQueue] Task failed:', error);
      } finally {
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
}

// Global queue for image/video processing
export const mediaProcessingQueue = new ProcessingQueue(4);
