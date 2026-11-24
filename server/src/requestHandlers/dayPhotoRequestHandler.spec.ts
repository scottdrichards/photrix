import { afterAll, describe, expect, it } from "@jest/globals";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { overrideConfig } from "../config/config.fixture.ts";
import { dayPhotoRequestHandler } from "./dayPhotoRequestHandler.ts";
import { fakeRequest, recordResponse } from "./handlerTest.fixture.ts";

const dir = mkdtempSync(path.join(os.tmpdir(), "photrix-day-photo-"));
const cacheDir = path.join(dir, "cache");
const photos = path.join(cacheDir, "day-photos");
mkdirSync(photos, { recursive: true });

// A stand-in interpreter for the generate script: writes a JPEG for one date,
// finds no photos for another, and fails for a third.
const python = path.join(dir, "fake-python");
writeFileSync(
  python,
  `#!/bin/sh
case "$2" in
  2024-05-01) printf 'generated' > "${photos}/$2.jpg" ;;
  2024-05-03) echo boom >&2; exit 1 ;;
esac
`,
);
chmodSync(python, 0o755);
overrideConfig({ CACHE_DIR: cacheDir, PHOTRIX_PYTHON: python });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const call = async (date: string) => {
  const recorded = recordResponse();
  await dayPhotoRequestHandler(fakeRequest("GET", `/api/day-photo/${date}`), recorded.res);
  return recorded;
};

describe("dayPhotoRequestHandler", () => {
  it.each(["2024-5-1", "2024-05-01x", "..%2F..%2Fetc", "", "yesterday"])(
    "answers 400 for the date %j",
    async (date) => {
      const response = await call(date);
      expect(response.status()).toBe(400);
      expect(response.json()).toEqual({ error: "date must be YYYY-MM-DD" });
    },
  );

  it("serves an already generated photo as a day-cacheable JPEG", async () => {
    writeFileSync(path.join(photos, "2023-01-02.jpg"), "cached");
    const response = await call("2023-01-02");
    await response.finished;
    expect(response.status()).toBe(200);
    expect(response.header("Content-Type")).toBe("image/jpeg");
    expect(response.header("Cache-Control")).toBe("public, max-age=86400");
    expect(response.text()).toBe("cached");
  });

  it("generates the photo on first request", async () => {
    const response = await call("2024-05-01");
    await response.finished;
    expect(response.status()).toBe(200);
    expect(response.text()).toBe("generated");
  });

  it("answers 404 for a date with no photos", async () => {
    const response = await call("2024-05-02");
    expect(response.status()).toBe(404);
    expect(response.json()).toEqual({ error: "No photos for this date" });
  });

  it("answers 500 when generation fails", async () => {
    const response = await call("2024-05-03");
    expect(response.status()).toBe(500);
    expect(response.json()).toEqual({ error: "Photo generation failed" });
  });
});
