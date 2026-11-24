import { afterAll, describe, expect, it } from "@jest/globals";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { overrideConfig } from "../config/config.fixture.ts";
import { fakeRequest, recordResponse } from "./handlerTest.fixture.ts";
import { screensaverRequestHandler } from "./screensaverRequestHandler.ts";

// A stand-in interpreter: echoes what the pick script would have been asked
// for, so the spec checks the handler's contract without a library.
const dir = mkdtempSync(path.join(os.tmpdir(), "photrix-screensaver-"));
const script = (name: string, body: string) => {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};
const echoPython = script(
  "echo-python",
  `printf '{"script":"%s","count":"%s","window":"%s","rec":"%s","star":"%s","fam":"%s"}' "$(basename "$1")" "$2" "$3" "$PHOTRIX_SS_REC" "$PHOTRIX_SS_STAR" "$PHOTRIX_SS_FAM"`,
);
const failingPython = script("failing-python", "echo boom >&2; exit 3");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const call = async (url: string, python = echoPython) => {
  overrideConfig({ PHOTRIX_PYTHON: python });
  const recorded = recordResponse();
  await screensaverRequestHandler(fakeRequest("GET", url), recorded.res);
  return recorded;
};

describe("screensaverRequestHandler", () => {
  it("runs the pick script with the defaults and passes its JSON through uncached", async () => {
    const response = await call("/api/screensaver");
    expect(response.status()).toBe(200);
    expect(response.header("Cache-Control")).toBe("no-store");
    expect(response.json()).toMatchObject({ script: "screensaver_pick.py", count: "60", window: "365" });
  });

  it.each([
    ["count=10000&window=99999", "400", "3650"],
    ["count=-5&window=-1", "1", "1"],
    ["count=abc&window=", "60", "365"],
    ["count=12&window=30", "12", "30"],
  ])("clamps %s", async (query, count, window) => {
    expect((await call(`/api/screensaver?${query}`)).json()).toMatchObject({ count, window });
  });

  it("hands numeric weight knobs to the script and drops the rest", async () => {
    const response = await call("/api/screensaver?rec=2&star=abc&fam=0.5");
    expect(response.json()).toMatchObject({ rec: "2", star: "", fam: "0.5" });
  });

  it("answers 500 without the script's output when it fails", async () => {
    const response = await call("/api/screensaver", failingPython);
    expect(response.status()).toBe(500);
    expect(response.json()).toEqual({ error: "screensaver pick failed" });
  });
});
