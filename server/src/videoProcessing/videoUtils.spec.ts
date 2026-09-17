import { afterEach, describe, expect, it, jest } from "@jest/globals";
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

const makeSpawnProcess = () => {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => undefined;
  return proc;
};

/**
 * Mocks ffprobe to report the given color_transfer and every ffmpeg call
 * (GPU probes included) to fail except the real single-frame extract
 * (identified by "-vframes", which no GPU probe uses) so it's the only
 * ffmpeg invocation left standing.
 */
const mockSpawnWithColorTransfer = (colorTransfer: string) =>
  jest.fn((cmd: string, args: readonly string[] = []) => {
    const proc = makeSpawnProcess();
    if (cmd === "ffprobe") {
      queueMicrotask(() => {
        proc.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({ streams: [{ codec_type: "video", color_transfer: colorTransfer }] }),
          ),
        );
        proc.emit("close", 0);
      });
      return proc;
    }
    const isThumbnailExtract = args.includes("-vframes");
    queueMicrotask(() => proc.emit("close", isThumbnailExtract ? 0 : 1));
    return proc;
  });

describe("videoUtils", () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });
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

    pipeChildProcessLogs(child, (chunk) => {
      captured.push(chunk);
    });

    child.stdout?.emit("data", Buffer.from("line-out\n"));
    child.stderr?.emit("data", Buffer.from("line-err\n"));

    expect(captured).toEqual(["line-err\n"]);
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

  // Feedback #132/#133: HDR10/HLG source frames rendered as a washed-out
  // thumbnail because the extract filter never tonemapped them to SDR.
  it("tonemaps an HDR10 (smpte2084) source before scaling the thumbnail", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-video-thumb-hdr-"));
    const source = path.join(root, "hdr10.mp4");
    writeFileSync(source, "video");

    const spawnMock = mockSpawnWithColorTransfer("smpte2084");
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateVideoThumbnail: generateVideoThumbnailFresh } = await import(
      "./videoUtils.ts"
    );
    await generateVideoThumbnailFresh(source, 320);

    const thumbnailCall = spawnMock.mock.calls.find(
      ([, args]) => Array.isArray(args) && (args as string[]).includes("-vframes"),
    );
    expect(thumbnailCall).toBeDefined();
    const args = thumbnailCall![1] as string[];
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("zscale=t=linear");
    expect(vf).toContain("tonemap=hable");
    expect(vf).toMatch(/scale=-2:320$/);
  });

  it("does not tonemap an ordinary SDR (bt709) source", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-video-thumb-sdr-"));
    const source = path.join(root, "sdr.mp4");
    writeFileSync(source, "video");

    const spawnMock = mockSpawnWithColorTransfer("bt709");
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateVideoThumbnail: generateVideoThumbnailFresh } = await import(
      "./videoUtils.ts"
    );
    await generateVideoThumbnailFresh(source, 320);

    const thumbnailCall = spawnMock.mock.calls.find(
      ([, args]) => Array.isArray(args) && (args as string[]).includes("-vframes"),
    );
    expect(thumbnailCall).toBeDefined();
    const args = thumbnailCall![1] as string[];
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toBe("scale=-2:320");
  });
});
