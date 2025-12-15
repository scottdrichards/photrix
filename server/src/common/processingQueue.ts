type QueueTask = {
  fn: () => Promise<void>;
  priority: boolean; // High priority tasks bypass pause
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
    console.log(`[ProcessingQueue] Paused for ${durationMs}ms`);
  }

  /**
   * Add a task to the queue and return a promise that resolves when the task completes.
   * @param task - The task to execute
   * @param priority - If true, task will execute even when queue is paused
   */
  async enqueue<T>(task: () => Promise<T>, priority = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority,
        fn: async () => {
          try {
            const result = await task();
            resolve(result);
          } catch (error) {
            reject(error);
          }
        }
      });
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    // Check if paused
    if (this.paused) {
      if (Date.now() >= this.pauseUntil) {
        this.paused = false;
        console.log(`[ProcessingQueue] Resumed`);
      } else {
        // If paused, only process priority tasks
        const priorityTaskIndex = this.queue.findIndex(t => t.priority);
        if (priorityTaskIndex === -1) {
          // No priority tasks, reschedule check
          setTimeout(() => this.processNext(), 100);
          return;
        }
        // Continue to process the priority task below
      }
    }

    if (this.processing >= this.concurrency || this.queue.length === 0) {
      return;
    }

    // Get next task - prioritize high priority tasks when paused
    let taskIndex = 0;
    if (this.paused) {
      taskIndex = this.queue.findIndex(t => t.priority);
      if (taskIndex === -1) {
        // No priority tasks available
        setTimeout(() => this.processNext(), 100);
        return;
      }
    }

    this.processing++;
    const task = this.queue.splice(taskIndex, 1)[0];
    
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
export const mediaProcessingQueue = new ProcessingQueue(2);
