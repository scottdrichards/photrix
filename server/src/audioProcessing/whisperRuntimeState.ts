export type WhisperRuntimeState = {
  status: "idle" | "starting" | "ready";
  pid?: number;
  startedAt?: number;
  readyAt?: number;
  device?: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  lastExit?: {
    at: number;
    code: number | null;
    signal: NodeJS.Signals | null;
    evicted: boolean;
    pendingCount: number;
  };
  lastTimeout?: {
    at: number;
    requestId: number;
    operation: string;
    videoPath?: string;
    elapsedMs?: number;
  };
};

let state: WhisperRuntimeState = {
  status: "idle",
};

const cloneState = (): WhisperRuntimeState => ({
  ...state,
  lastExit: state.lastExit ? { ...state.lastExit } : undefined,
  lastTimeout: state.lastTimeout ? { ...state.lastTimeout } : undefined,
});

export const getWhisperRuntimeState = (): WhisperRuntimeState => cloneState();

export const noteWhisperWorkerStarting = (pid: number | undefined): void => {
  state = {
    ...state,
    status: "starting",
    pid,
    startedAt: Date.now(),
    readyAt: undefined,
    device: undefined,
    fallbackFrom: undefined,
    fallbackReason: undefined,
  };
};

export const noteWhisperWorkerReady = (ready: {
  pid: number | undefined;
  device?: string;
  fallbackFrom?: string;
  fallbackReason?: string;
}): void => {
  state = {
    ...state,
    status: "ready",
    pid: ready.pid,
    readyAt: Date.now(),
    device: ready.device,
    fallbackFrom: ready.fallbackFrom,
    fallbackReason: ready.fallbackReason,
  };
};

export const noteWhisperWorkerTimeout = (timeout: {
  requestId: number;
  operation: string;
  videoPath?: string;
  elapsedMs?: number;
}): void => {
  state = {
    ...state,
    lastTimeout: {
      at: Date.now(),
      requestId: timeout.requestId,
      operation: timeout.operation,
      videoPath: timeout.videoPath,
      elapsedMs: timeout.elapsedMs,
    },
  };
};

export const noteWhisperWorkerExit = (exit: {
  code: number | null;
  signal: NodeJS.Signals | null;
  evicted: boolean;
  pendingCount: number;
}): void => {
  state = {
    ...state,
    status: "idle",
    pid: undefined,
    readyAt: undefined,
    device: undefined,
    fallbackFrom: undefined,
    fallbackReason: undefined,
    lastExit: {
      at: Date.now(),
      code: exit.code,
      signal: exit.signal,
      evicted: exit.evicted,
      pendingCount: exit.pendingCount,
    },
  };
};
