import type http from "node:http";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";
import { writeJson } from "../utils.ts";
import { readJsonRequest } from "../common/readBody.ts";

type TogglePayload = {
  enabled: boolean;
};

export const statusBackgroundTasksRequestHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  { taskOrchestrator }: { taskOrchestrator: TaskOrchestrator },
) => {
  const payload = await readJsonRequest<TogglePayload>(req, res);
  if (!payload) return;
  if (typeof payload.enabled !== "boolean") {
    writeJson(res, 400, { error: "'enabled' must be a boolean" });
    return;
  }

  taskOrchestrator.setPerformBackgroundTasks(payload.enabled);
  writeJson(res, 200, { enabled: taskOrchestrator.getPerformBackgroundTasks() });
};
