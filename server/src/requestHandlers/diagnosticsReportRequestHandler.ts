import type http from "node:http";
import { buildDiagnosticsReport } from "../observability/buildDiagnosticsReport.ts";
import { getPerfSnapshot } from "../observability/perfMonitor.ts";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";
import { writeJson } from "../common/writeJson.ts";

/**
 * `GET /api/diagnostics/perf` — live server performance (see perfMonitor.ts).
 * `GET /api/diagnostics/report[?clientSessionId=]` — see buildDiagnosticsReport.ts.
 */
export const diagnosticsReportRequestHandler = async (
  req: http.IncomingMessage & { url: string },
  res: http.ServerResponse,
  taskOrchestrator: TaskOrchestrator,
) => {
  const url = new URL(req.url, "http://localhost");
  writeJson(
    res,
    200,
    url.pathname === "/api/diagnostics/perf"
      ? getPerfSnapshot()
      : await buildDiagnosticsReport(
          url.searchParams.get("clientSessionId"),
          taskOrchestrator,
        ),
  );
};
