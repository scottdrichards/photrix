import { describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import {
  appendWithLimit,
  generateVideoPreview,
  generateVideoThumbnail,
  pipeChildProcessLogs,
} from "./videoUtils.ts";

describe("videoUtils", () => {
  it("appendWithLimit keeps the most recent characters", () => {
    const chunk = "x".repeat(70_000);
    const combined = appendWithLimit("prefix", chunk);

    expect(combined.length).toBe(64_000);
    expect(combined.endsWith("x")).toBe(true);
  });

  it("pipeChildProcessLogs forwards stderr chunks to callback", () => {
    const child = {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    } as unknown as ReturnType<typeof import("child_process").spawn>;

    const captured: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    pipeChildProcessLogs(child, "thumb", (chunk) => {
      captured.push(chunk);
    });

    child.stdout?.emit("data", Buffer.from("line-out\n"));
    child.stderr?.emit("data", Buffer.from("line-err\n"));

    expect(captured).toEqual(["line-err\n"]);
    expect(logSpy).toHaveBeenCalled();
  });

  it("returns cached preview path without conversion work", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-video-preview-"));
    const source = path.join(root, "clip.mp4");
    writeFileSync(source, "video");

    const cached = getMirroredCachedFilePath(source, "preview.320.5s.audio", "mp4");
    mkdirSync(path.dirname(cached), { recursive: true });
    writeFileSync(cached, "cached-preview");

    const result = await generateVideoPreview(source, 320, 5_000);
    expect(result).toBe(cached);
  });

  it("returns cached thumbnail path without invoking ffmpeg", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-video-thumb-"));
    const source = path.join(root, "clip.mp4");
    writeFileSync(source, "video");

    const cached = getMirroredCachedFilePath(source, 320, "jpg");
    mkdirSync(path.dirname(cached), { recursive: true });
    writeFileSync(cached, "cached-thumb");

    const result = await generateVideoThumbnail(source, 320);
    expect(result).toBe(cached);
  });
});
