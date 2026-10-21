import type http from "node:http";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";
import { writeJson } from "../utils.ts";
import { readJsonBody } from "../common/readBody.ts";

type TogglePayload = {
  enabled: boolean;
};

export const statusBackgroundTasksRequestHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  { taskOrchestrator }: { taskOrchestrator: TaskOrchestrator },
) => {
  try {
    const payload = await readJsonBody<TogglePayload>(req);
    if (typeof payload.enabled !== "boolean") {
      writeJson(res, 400, { error: "'enabled' must be a boolean" });
      return;
    }

    taskOrchestrator.setPerformBackgroundTasks(payload.enabled);
    const enabled = taskOrchestrator.getPerformBackgroundTasks();
    writeJson(res, 200, { enabled });
  } catch (error) {
    writeJson(res, 400, {
      error: "Invalid JSON payload",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
