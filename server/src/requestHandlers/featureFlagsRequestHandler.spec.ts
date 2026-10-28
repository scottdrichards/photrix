import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { FeatureFlagStore } from "../featureFlags/featureFlagStore.ts";
import { featureFlagsRequestHandler } from "./featureFlagsRequestHandler.ts";

const request = (method: string, url: string, body?: unknown) => {
  const stream = new PassThrough();
  queueMicrotask(() => stream.end(body === undefined ? undefined : JSON.stringify(body)));
  return Object.assign(stream, { method, url, headers: {} }) as unknown as http.IncomingMessage &
    Required<Pick<http.IncomingMessage, "url">>;
};

const response = () => {
  const recorded: { status?: number; body?: { flags?: unknown[]; error?: string } } = {};
  const res = {
    writeHead: (status: number) => {
      recorded.status = status;
      return res;
    },
    setHeader: () => res,
    end: (text: string) => {
      recorded.body = JSON.parse(text);
    },
  } as unknown as http.ServerResponse;
  return { res, recorded };
};

describe("featureFlagsRequestHandler", () => {
  let dir: string;
  let db: AsyncSqlite;
  let store: FeatureFlagStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "photrix-flag-api-"));
    db = await AsyncSqlite.open(path.join(dir, "flags.db"), { readPoolSize: 1 });
    await db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
    store = await FeatureFlagStore.load(db, {});
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists every flag, for share links too", async () => {
    const { res, recorded } = response();
    await featureFlagsRequestHandler(request("GET", "/api/feature-flags"), res, { store, canChange: false });
    expect(recorded.status).toBe(200);
    expect(recorded.body?.flags).toEqual([expect.objectContaining({ name: "thumbnailBackfill" })]);
  });

  it("lets a signed-in session switch a flag", async () => {
    const { res, recorded } = response();
    await featureFlagsRequestHandler(
      request("PUT", "/api/feature-flags/thumbnailBackfill", { enabled: false }),
      res,
      { store, canChange: true },
    );
    expect(recorded.status).toBe(200);
    expect(store.isEnabled("thumbnailBackfill")).toBe(false);
  });

  it("refuses a share link, an unknown flag and a non-boolean value", async () => {
    const cases: Array<[string, unknown, boolean, number]> = [
      ["thumbnailBackfill", { enabled: false }, false, 403],
      ["noSuchFlag", { enabled: false }, true, 404],
      ["thumbnailBackfill", { enabled: "off" }, true, 400],
    ];
    for (const [name, body, canChange, status] of cases) {
      const { res, recorded } = response();
      await featureFlagsRequestHandler(request("PUT", `/api/feature-flags/${name}`, body), res, {
        store,
        canChange,
      });
      expect(recorded.status).toBe(status);
    }
    expect(store.isEnabled("thumbnailBackfill")).toBe(true);
  });

  it("answers 409 for a flag pinned by the environment", async () => {
    const pinned = await FeatureFlagStore.load(db, { PHOTRIX_FLAG_THUMBNAIL_BACKFILL: "true" });
    const { res, recorded } = response();
    await featureFlagsRequestHandler(
      request("PUT", "/api/feature-flags/thumbnailBackfill", { enabled: false }),
      res,
      { store: pinned, canChange: true },
    );
    expect(recorded.status).toBe(409);
    expect(recorded.body?.error).toContain("PHOTRIX_FLAG_THUMBNAIL_BACKFILL");
  });
});
