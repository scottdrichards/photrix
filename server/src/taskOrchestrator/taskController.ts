export type TaskState = "running" | "paused" | "cancelled" | "complete";

export type TaskController = {
  readonly state: TaskState;
  checkCancelled: () => void;
  markComplete: () => void;
  waitUntilResumed: () => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  cancel: () => void;
};

export const createTaskController = (cancelMessage: string): TaskController => {
  let state: TaskState = "running";
  let resumeSignal: (() => void) | null = null;
  const cancelledError = new Error(cancelMessage);

  return {
    get state() {
      return state;
    },
    checkCancelled: () => {
      if (state === "cancelled") throw cancelledError;
    },
    markComplete: () => {
      state = "complete";
    },
    waitUntilResumed: async () => {
      if (state !== "paused") return;
      await new Promise<void>((resolve) => {
        resumeSignal = resolve;
      });
    },
    pause: () => {
      if (state === "running") state = "paused";
    },
    resume: () => {
      if (state === "paused") state = "running";
      resumeSignal?.();
      resumeSignal = null;
      return Promise.resolve();
    },
    cancel: () => {
      state = "cancelled";
      resumeSignal?.();
      resumeSignal = null;
    },
  };
};
