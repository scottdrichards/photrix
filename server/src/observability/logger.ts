import pino from "pino";
import { getCurrentRequestId } from "./requestTrace.ts";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    },
  }),
});

/** Returns a child logger tagged with a module name. */
export const getLogger = (name: string) => logger.child({ module: name });

/**
 * Returns a child logger that includes the current request ID when called
 * from within a request context (AsyncLocalStorage set by runWithRequestTrace).
 */
export const getRequestLogger = (name?: string) => {
  const requestId = getCurrentRequestId();
  const base = name ? logger.child({ module: name }) : logger;
  return requestId ? base.child({ requestId }) : base;
};
