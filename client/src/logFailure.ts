import { logClientEvent } from "./diagnostics";

/** True for work that was cancelled on purpose (an aborted fetch, an interrupted play()). */
export const isAbort = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

/**
 * A rejection handler for work nothing awaits: reports the failure to the
 * server's diagnostics log instead of dropping it. A deliberate cancellation
 * isn't a failure and isn't reported.
 */
export const logFailure =
  (event: string, message: string) =>
  (error: unknown): void => {
    if (isAbort(error)) return;
    logClientEvent({
      level: "warn",
      event,
      message,
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  };
