let backgroundTasksEnabled = true;
let waitingResolvers: Array<() => void> = [];

export const isBackgroundTasksEnabled = () => backgroundTasksEnabled;

export const setBackgroundTasksEnabled = (enabled: boolean) => {
  if (backgroundTasksEnabled === enabled) {
    return backgroundTasksEnabled;
  }

  backgroundTasksEnabled = enabled;
  console.log(
    `[background-tasks] ${enabled ? "enabled" : "disabled"} background processing`,
  );

  if (enabled) {
    for (const resolve of waitingResolvers) {
      resolve();
    }
    waitingResolvers = [];
  }

  return backgroundTasksEnabled;
};

export const waitForBackgroundTasksEnabled = async (): Promise<void> => {
  if (backgroundTasksEnabled) {
    return;
  }

  await new Promise<void>((resolve) => {
    waitingResolvers.push(resolve);
  });
};
