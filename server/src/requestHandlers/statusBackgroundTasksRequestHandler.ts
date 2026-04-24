import type http from "node:http";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";
import { writeJson } from "../utils.ts";

type TogglePayload = {
  enabled: boolean;
};

const readJsonBody = async <T>(req: http.IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf-8").trim();
  if (!body) {
    throw new Error("Request body is required");
  }

  return JSON.parse(body) as T;
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

    taskOrchestrator.setProcessBackgroundTasks(payload.enabled);
    const enabled = taskOrchestrator.getProcessBackgroundTasks();
    writeJson(res, 200, { enabled });
  } catch (error) {
    writeJson(res, 400, {
      error: "Invalid JSON payload",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
