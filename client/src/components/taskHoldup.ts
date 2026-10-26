import type { TaskHoldup } from "../api";

const RESOURCE_LABEL: Record<string, string> = {
  gpu: "the GPU",
  cpu: "CPU",
  memoryMB: "memory",
  disk: "the disk",
  network: "the network",
};

const joinNames = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * One line saying why a background task is held up. `gpu` marks the holdups
 * caused by GPU contention, which the status view highlights: they are the
 * ones a user can do something about (stop a playback) or that explain a task
 * being several times slower than usual.
 */
export const describeHoldup = (holdup: TaskHoldup): { text: string; gpu: boolean } => {
  switch (holdup.reason) {
    case "background-off":
      return { text: "Paused: background tasks are off", gpu: false };
    case "user-active":
      return { text: "Paused while the app is in use", gpu: false };
    case "gpu-lent":
      return { text: "Paused: GPU lent to video playback", gpu: true };
    case "server-busy":
      return { text: "Throttled: server busy", gpu: false };
    case "faces-on-cpu":
      return { text: "Slowed: GPU full, faces running on CPU", gpu: true };
    case "waiting-for-resources": {
      const resources = holdup.resources ?? [];
      const what = joinNames(resources.map((r) => RESOURCE_LABEL[r] ?? r)) || "resources";
      const who = holdup.heldBy?.length ? ` (in use by ${joinNames(holdup.heldBy)})` : "";
      return { text: `Waiting for ${what}${who}`, gpu: resources.includes("gpu") };
    }
  }
};
