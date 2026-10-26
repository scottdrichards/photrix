import os from "node:os";
import { listDiagnosticsEvents } from "./diagnosticsStore.ts";
import { getPerfSnapshot } from "./perfMonitor.ts";
import { getSystemMetrics } from "./systemMetrics.ts";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";

/**
 * Everything needed to reconstruct a slowdown or bug in one JSON document: one
 * browser session's client+server timeline, server-wide events (event-loop
 * stalls, slow requests) from the same buffer, the perf snapshot, the task
 * queue and machine load. Paths and search text are already redacted at record
 * time (privacy.ts), so it is safe to hand to an agent. Served by
 * `GET /api/diagnostics/report` and saved with every suggestion (feedbackHandler).
 */
export const buildDiagnosticsReport = async (
  clientSessionId: string | null,
  taskOrchestrator: TaskOrchestrator,
) => ({
  generatedAt: new Date().toISOString(),
  clientSessionId,
  server: {
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpus: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / 1e6),
  },
  system: await getSystemMetrics(),
  perf: getPerfSnapshot(),
  tasks: taskOrchestrator.getDiagnosticsSnapshot(),
  events: listDiagnosticsEvents({ limit: Number.MAX_SAFE_INTEGER }).filter(
    (event) =>
      !clientSessionId ||
      !event.clientSessionId ||
      event.clientSessionId === clientSessionId,
  ),
});
