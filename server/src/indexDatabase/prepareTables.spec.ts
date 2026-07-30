import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { prepareTables } from "./prepareTables.ts";

// Regression guard for the filter panel's camera/lens suggestions dropdown
// being slow to load: queryFieldSuggestions/queryFieldSuggestionsWithCounts
// run a DISTINCT/GROUP BY over cameraMake/cameraModel/lens on every open.
// Those columns had no index, so SQLite fell back to a full `files` scan —
// and because each row also carries the imageEmbedding/audioEmbedding BLOBs,
// every row fetched drags those pages along too (measured ~29s over 191k
// real rows). Giving each column its own covering index (tables.ts
// `indexExpression: true`, same mechanism as mimeType/rating/etc.) turns the
// DISTINCT/GROUP BY into an index-only scan.
describe("prepareTables camera/lens suggestion indexes", () => {
  let dir: string;
  let db: AsyncSqlite;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "prepare-tables-spec-"));
    db = await AsyncSqlite.open(join(dir, "test.db"));
    await prepareTables(db);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates single-column indexes for cameraMake, cameraModel, and lens", async () => {
    const indexes = await db.all<{ name: string }>("PRAGMA index_list(files)");
    const names = new Set(indexes.map((row) => row.name));

    expect(names).toContain("idx_files_cameraMake");
    expect(names).toContain("idx_files_cameraModel");
    expect(names).toContain("idx_files_lens");
  });

  it.each(["cameraMake", "cameraModel", "lens"] as const)(
    "answers the %s suggestions query without a full table scan",
    async (field) => {
      const plan = await db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT DISTINCT ${field} AS suggestion
         FROM files
         WHERE ${field} IS NOT NULL
           AND ${field} != ''
           AND ${field} LIKE ? ESCAPE '\\'
         ORDER BY suggestion COLLATE NOCASE ASC
         LIMIT ?`,
        "%",
        8,
      );

      const details = plan.map((row) => row.detail).join(" | ");
      expect(details).not.toContain(`SCAN files`);
      expect(details).toContain("COVERING INDEX");
    },
  );
});
