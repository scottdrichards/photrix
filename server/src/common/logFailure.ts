import { toError } from "./toError.ts";

type Logger = { warn: (details: object, message: string) => void };

/**
 * A rejection handler for work nothing awaits: logs the failure instead of
 * swallowing it. `void persist().catch(logFailure(log, "Could not persist X"))`
 */
export const logFailure =
  (log: Logger, message: string) =>
  (error: unknown): void =>
    log.warn({ err: toError(error) }, message);
