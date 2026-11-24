// Child processes (the Python workers, ffmpeg, the day-photo scripts) and
// libraries that read their settings from the environment (the OpenTelemetry
// SDK) get the server's environment as a whole. This file and config.ts are
// the only ones that touch process.env; everything else reads config().

/** The environment for a spawned child: the server's own, plus `extra`. */
export const childProcessEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  ...extra,
});

/** Sets variables every child spawned from now on inherits, replacing any already set. */
export const exportToChildProcesses = (vars: Partial<NodeJS.ProcessEnv>): void => {
  Object.assign(process.env, vars);
};

/** Like exportToChildProcesses, but keeps any value the operator already set. */
export const exportEnvDefaults = (vars: Record<string, string>): void => {
  for (const [name, value] of Object.entries(vars)) process.env[name] ??= value;
};
