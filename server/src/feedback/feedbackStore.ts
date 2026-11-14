import type { AsyncSqlite } from "../common/asyncSqlite.ts";

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
  hasDiagnostics: number;
};

type FeedbackStatus = "open" | "active" | "completed";

const rowStatus = (row: FeedbackRow, now: number): FeedbackStatus => {
  if (row.completedAt != null) return "completed";
  if (row.claimedAt != null && now - row.claimedAt < CLAIM_EXPIRY_MS) return "active";
  return "open";
};

/** The in-app suggestion queue: the only code that reads or writes the `feedback` table. */
export class FeedbackStore {
  constructor(private readonly db: AsyncSqlite) {}

  /** The session snapshot saved with a suggestion, or null when it has none. */
  async getDiagnostics(id: number): Promise<unknown> {
    const row = await this.db.get<{ diagnostics: string | null }>(
      "SELECT diagnostics FROM feedback WHERE id = ?",
      [id],
    );
    return row?.diagnostics ? (JSON.parse(row.diagnostics) as unknown) : null;
  }

  async list(now: number) {
    const rows = await this.db.all<FeedbackRow>(
      "SELECT id, text, createdAt, claimedAt, claimedBy, completedAt, source, diagnostics IS NOT NULL AS hasDiagnostics FROM feedback ORDER BY createdAt ASC",
    );
    return rows.map((row) => ({
      ...row,
      hasDiagnostics: Boolean(row.hasDiagnostics),
      status: rowStatus(row, now),
    }));
  }

  async add(entry: {
    text: string;
    createdAt: number;
    source: string | null;
    diagnostics: string | null;
  }): Promise<void> {
    await this.db.run(
      "INSERT INTO feedback (text, createdAt, source, diagnostics) VALUES (?, ?, ?, ?)",
      [entry.text, entry.createdAt, entry.source, entry.diagnostics],
    );
  }

  /** Atomic compare-and-set: false when it is already claimed, completed or missing. */
  async claim(id: number, claimedBy: string, now: number): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE feedback SET claimedAt = ?, claimedBy = ?
         WHERE id = ? AND completedAt IS NULL
           AND (claimedAt IS NULL OR claimedAt < ?)`,
      [now, claimedBy, id, now - CLAIM_EXPIRY_MS],
    );
    return result.changes !== 0;
  }

  async unclaim(id: number): Promise<void> {
    await this.db.run(
      "UPDATE feedback SET claimedAt = NULL, claimedBy = NULL WHERE id = ? AND completedAt IS NULL",
      [id],
    );
  }

  async complete(id: number, now: number): Promise<void> {
    await this.db.run(
      "UPDATE feedback SET completedAt = ? WHERE id = ? AND completedAt IS NULL",
      [now, id],
    );
  }
}
