import type http from "node:http";
import type { FeedbackStore } from "../feedback/feedbackStore.ts";
import { writeJson } from "../common/writeJson.ts";
import { readJsonRequest } from "../common/readBody.ts";

export const feedbackHandler = async (
  req: http.IncomingMessage & { url: string },
  res: http.ServerResponse,
  feedback: FeedbackStore,
  options: {
    markExternal?: boolean;
    // Snapshot of the submitter's session (see buildDiagnosticsReport.ts) saved
    // with the suggestion, so whoever triages it can see what was slow or broken.
    buildDiagnosticsReport?: (clientSessionId: string) => Promise<unknown>;
  } = {},
): Promise<void> => {
  const url = new URL(req.url, "http://localhost");
  const pathParts = url.pathname.split("/").filter(Boolean);
  // pathParts: ["api", "feedback"], ["api", "feedback", ":id"] or [..., ":id", "diagnostics"]
  const idParam = pathParts[2];

  // GET /api/feedback/:id/diagnostics — the session snapshot saved with a suggestion
  if (req.method === "GET" && idParam && pathParts[3] === "diagnostics") {
    const diagnostics = await feedback.getDiagnostics(Number.parseInt(idParam, 10));
    if (!diagnostics) {
      writeJson(res, 404, { error: "No diagnostics saved with this suggestion" });
      return;
    }
    writeJson(res, 200, diagnostics);
    return;
  }

  // GET /api/feedback — list all suggestions with their status
  if (req.method === "GET" && !idParam) {
    const statusFilter = url.searchParams.get("status");
    const rows = await feedback.list(Date.now());
    writeJson(res, 200, {
      feedback: rows.filter((row) => !statusFilter || row.status === statusFilter),
    });
    return;
  }

  // POST /api/feedback — submit a new suggestion. Reachable from a share-link
  // session too (see createServer.ts) — markExternal is set whenever this
  // submission came through one, so triage can be appropriately skeptical of
  // it without having to trust free-text content alone.
  if (req.method === "POST" && !idParam) {
    const body = await readJsonRequest<{ text?: unknown; clientSessionId?: unknown }>(req, res);
    if (!body) return;

    if (typeof body.text !== "string" || body.text.trim().length === 0) {
      writeJson(res, 400, { error: "text is required" });
      return;
    }

    const text = body.text.trim().slice(0, 2000);
    const source = options.markExternal ? "external" : null;
    const diagnostics =
      typeof body.clientSessionId === "string" && options.buildDiagnosticsReport
        ? JSON.stringify(await options.buildDiagnosticsReport(body.clientSessionId))
        : null;
    await feedback.add({ text, createdAt: Date.now(), source, diagnostics });

    writeJson(res, 200, { ok: true });
    return;
  }

  // PATCH /api/feedback/:id — claim, unclaim, or complete a suggestion
  if (req.method === "PATCH" && idParam) {
    const id = Number.parseInt(idParam, 10);
    if (!Number.isFinite(id)) {
      writeJson(res, 400, { error: "Invalid id" });
      return;
    }

    const body = await readJsonRequest<{ action?: unknown; claimedBy?: unknown }>(req, res);
    if (!body) return;

    const now = Date.now();

    if (body.action === "claim") {
      const agent =
        typeof body.claimedBy === "string" ? body.claimedBy.slice(0, 200) : "agent";
      if (!(await feedback.claim(id, agent, now))) {
        writeJson(res, 409, { error: "Already claimed or not found" });
        return;
      }
      writeJson(res, 200, { ok: true });
      return;
    }

    if (body.action === "unclaim") {
      await feedback.unclaim(id);
      writeJson(res, 200, { ok: true });
      return;
    }

    if (body.action === "complete") {
      await feedback.complete(id, now);
      writeJson(res, 200, { ok: true });
      return;
    }

    writeJson(res, 400, { error: "action must be 'claim', 'unclaim', or 'complete'" });
  }
};
