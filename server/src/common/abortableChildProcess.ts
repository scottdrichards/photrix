import type { ChildProcess } from "node:child_process";

const FORCE_KILL_AFTER_ABORT_MS = 1_000;

export const bindChildProcessAbort = (
  child: Pick<ChildProcess, "kill">,
  signal: AbortSignal | undefined,
) => {
  let aborted = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

  if (!signal) {
    return {
      wasAborted: () => false,
      cleanup: () => {},
    };
  }

  const onAbort = () => {
    aborted = true;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, FORCE_KILL_AFTER_ABORT_MS);
    forceKillTimer.unref?.();
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    wasAborted: () => aborted,
    cleanup: () => {
      if (!signal.aborted) {
        signal.removeEventListener("abort", onAbort);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
    },
  };
};
