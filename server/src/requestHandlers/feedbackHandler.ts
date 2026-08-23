import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { writeJson } from "../utils.ts";

// Claims expire after 1 hour so a crashed agent doesn't lock a suggestion forever.
const CLAIM_EXPIRY_MS = 60 * 60 * 1000;

type FeedbackRow = {
  id: number;
  text: string;
  createdAt: number;
  claimedAt: number | null;
  claimedBy: string | null;
  completedAt: number | null;
  source: string | null;
};

type FeedbackStatus = "open" | "active" | "completed";

const rowStatus = (row: FeedbackRow, now: number): FeedbackStatus => {
  if (row.completedAt != null) return "completed";
  if (row.claimedAt != null && now - row.claimedAt < CLAIM_EXPIRY_MS) return "active";
  return "open";
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });

export const feedbackHandler = async (
  req: http.IncomingMessage & { url: string },
  res: http.ServerResponse,
  database: IndexDatabase,
  options: { markExternal?: boolean } = {},
): Promise<void> => {
  const url = new URL(req.url, "http://localhost");
  const pathParts = url.pathname.split("/").filter(Boolean);
  // pathParts: ["api", "feedback"] or ["api", "feedback", ":id"]
  const idParam = pathParts[2];

  // GET /api/feedback — list all suggestions with their status
  if (req.method === "GET" && !idParam) {
    const statusFilter = url.searchParams.get("status");
    const rows = await database.asyncSqlite.all<FeedbackRow>(
      "SELECT id, text, createdAt, claimedAt, claimedBy, completedAt, source FROM feedback ORDER BY createdAt ASC",
    );
    const now = Date.now();
    const feedback = rows
      .map((row) => ({ ...row, status: rowStatus(row, now) }))
      .filter((row) => !statusFilter || row.status === statusFilter);
    writeJson(res, 200, { feedback });
    return;
  }

  // POST /api/feedback — submit a new suggestion. Reachable from a share-link
  // session too (see createServer.ts) — markExternal is set whenever this
  // submission came through one, so triage can be appropriately skeptical of
  // it without having to trust free-text content alone.
  if (req.method === "POST" && !idParam) {
    let body: { text?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { text?: unknown };
    } catch {
      writeJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    if (typeof body.text !== "string" || body.text.trim().length === 0) {
      writeJson(res, 400, { error: "text is required" });
      return;
    }

    const text = body.text.trim().slice(0, 2000);
    const source = options.markExternal ? "external" : null;
    await database.asyncSqlite.run(
      "INSERT INTO feedback (text, createdAt, source) VALUES (?, ?, ?)",
      [text, Date.now(), source],
    );

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

    let body: { action?: unknown; claimedBy?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as { action?: unknown; claimedBy?: unknown };
    } catch {
      writeJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    const now = Date.now();

    if (body.action === "claim") {
      const agent = typeof body.claimedBy === "string" ? body.claimedBy.slice(0, 200) : "agent";
      const expiryThreshold = now - CLAIM_EXPIRY_MS;
      // Atomic compare-and-set: only claim if unclaimed or claim has expired
      const result = await database.asyncSqlite.run(
        `UPDATE feedback SET claimedAt = ?, claimedBy = ?
         WHERE id = ? AND completedAt IS NULL
           AND (claimedAt IS NULL OR claimedAt < ?)`,
        [now, agent, id, expiryThreshold],
      );
      if (result.changes === 0) {
        writeJson(res, 409, { error: "Already claimed or not found" });
        return;
      }
      writeJson(res, 200, { ok: true });
      return;
    }

    if (body.action === "unclaim") {
      await database.asyncSqlite.run(
        "UPDATE feedback SET claimedAt = NULL, claimedBy = NULL WHERE id = ? AND completedAt IS NULL",
        [id],
      );
      writeJson(res, 200, { ok: true });
      return;
    }

    if (body.action === "complete") {
      await database.asyncSqlite.run(
        "UPDATE feedback SET completedAt = ? WHERE id = ? AND completedAt IS NULL",
        [now, id],
      );
      writeJson(res, 200, { ok: true });
      return;
    }

    writeJson(res, 400, { error: "action must be 'claim', 'unclaim', or 'complete'" });
  }
};
