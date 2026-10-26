import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { FeatureFlagPinnedError, FeatureFlagStore } from "./featureFlagStore.ts";

describe("FeatureFlagStore", () => {
  let dir: string;
  let db: AsyncSqlite;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "photrix-flags-"));
    db = await AsyncSqlite.open(path.join(dir, "flags.db"), { readPoolSize: 1 });
    await db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the default until something overrides it", async () => {
    const store = await FeatureFlagStore.load(db, {});
    expect(store.isEnabled("thumbnailBackfill")).toBe(true);
    expect(store.list()).toEqual([
      expect.objectContaining({ name: "thumbnailBackfill", enabled: true, source: "default" }),
    ]);
  });

  it("keeps a runtime override across a restart, and clears it with null", async () => {
    const store = await FeatureFlagStore.load(db, {});
    await store.setOverride("thumbnailBackfill", false);
    expect(store.isEnabled("thumbnailBackfill")).toBe(false);

    const restarted = await FeatureFlagStore.load(db, {});
    expect(restarted.list()[0]).toMatchObject({ enabled: false, source: "override" });

    await restarted.setOverride("thumbnailBackfill", null);
    expect((await FeatureFlagStore.load(db, {})).list()[0]).toMatchObject({ enabled: true, source: "default" });
  });

  it("lets the environment pin a flag, which then can't be overridden", async () => {
    await (await FeatureFlagStore.load(db, {})).setOverride("thumbnailBackfill", true);
    const store = await FeatureFlagStore.load(db, { PHOTRIX_FLAG_THUMBNAIL_BACKFILL: "false" });

    expect(store.list()[0]).toMatchObject({ enabled: false, source: "environment" });
    await expect(store.setOverride("thumbnailBackfill", true)).rejects.toBeInstanceOf(FeatureFlagPinnedError);
  });

  it("refuses to start on a malformed environment value", async () => {
    await expect(FeatureFlagStore.load(db, { PHOTRIX_FLAG_THUMBNAIL_BACKFILL: "0" })).rejects.toThrow(
      'PHOTRIX_FLAG_THUMBNAIL_BACKFILL must be "true" or "false"',
    );
  });

  it("tells listeners when the effective value changes, and only then", async () => {
    const store = await FeatureFlagStore.load(db, {});
    const seen: boolean[] = [];
    store.onChange("thumbnailBackfill", (enabled) => seen.push(enabled));

    await store.setOverride("thumbnailBackfill", true); // already on: no change
    await store.setOverride("thumbnailBackfill", false);
    await store.setOverride("thumbnailBackfill", null);

    expect(seen).toEqual([false, true]);
  });

  it("deletes a stored override for a flag that no longer exists", async () => {
    await db.run("INSERT INTO settings (key, value) VALUES ('featureFlag.retiredFeature', 'true')");
    await FeatureFlagStore.load(db, {});
    expect(await db.all("SELECT key FROM settings")).toEqual([]);
  });
});
