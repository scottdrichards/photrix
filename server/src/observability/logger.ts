import pino from "pino";
import { config } from "../config/config.ts";

const isDev = !config().server.isProduction;

export const logger = pino({
  level: config().server.logLevel,
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
