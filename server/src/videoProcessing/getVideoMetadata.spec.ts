import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";

const createFakeSpawnProcess = () => {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
};

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe("getVideoMetadata", () => {
  it("parses ffprobe JSON output into metadata", async () => {
    const fakeProcess = createFakeSpawnProcess();

    const spawnMock = jest.fn(() => {
      queueMicrotask(() => {
        fakeProcess.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              format: {
                duration: "12.5",
                tags: { creation_time: "2024-03-10T12:34:56.000Z" },
              },
              streams: [
                {
                  codec_type: "video",
                  width: 1920,
                  height: 1080,
                  codec_name: "h264",
                  r_frame_rate: "30000/1001",
                  tags: { rotate: "90" },
                },
                {
                  codec_type: "audio",
                  codec_name: "aac",
                },
              ],
            }),
          ),
        );
        fakeProcess.emit("close", 0);
      });
      return fakeProcess;
    });

    jest.unstable_mockModule("child_process", () => ({
      spawn: spawnMock,
    }));

    const { getVideoMetadata } = await import("./getVideoMetadata.ts");
    const metadata = await getVideoMetadata("video.mp4");

    expect(spawnMock).toHaveBeenCalled();
    expect(metadata.duration).toBe(12.5);
    expect(metadata.dateTaken).toEqual(new Date("2024-03-10T12:34:56.000Z"));
    expect(metadata.dimensionWidth).toBe(1080);
    expect(metadata.dimensionHeight).toBe(1920);
    expect(metadata.orientation).toBe(6);
    expect(metadata.videoCodec).toBe("h264");
    expect(metadata.audioCodec).toBe("aac");
    expect(metadata.framerate).toBeCloseTo(29.97, 2);
  });

  it("rejects when ffprobe exits non-zero", async () => {
    const fakeProcess = createFakeSpawnProcess();

    const spawnMock = jest.fn(() => {
      queueMicrotask(() => {
        fakeProcess.stderr.emit("data", Buffer.from("ffprobe failed"));
        fakeProcess.emit("close", 1);
      });
      return fakeProcess;
    });

    jest.unstable_mockModule("child_process", () => ({
      spawn: spawnMock,
    }));

    const { getVideoMetadata } = await import("./getVideoMetadata.ts");

    await expect(getVideoMetadata("broken.mp4")).rejects.toThrow(/ffprobe failed/i);
  });

  it("rejects on invalid JSON output", async () => {
    const fakeProcess = createFakeSpawnProcess();

    const spawnMock = jest.fn(() => {
      queueMicrotask(() => {
        fakeProcess.stdout.emit("data", Buffer.from("not-json"));
        fakeProcess.emit("close", 0);
      });
      return fakeProcess;
    });

    jest.unstable_mockModule("child_process", () => ({
      spawn: spawnMock,
    }));

    const { getVideoMetadata } = await import("./getVideoMetadata.ts");

    await expect(getVideoMetadata("bad-json.mp4")).rejects.toThrow();
  });
});
