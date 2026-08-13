import { describe, expect, it } from "@jest/globals";
import { deriveFrigateFrames, type FrigateEventRecord } from "./frigateEventFrames.ts";

const HOST = "192.168.1.225:5000";
const BOX = [0.6, 0.15, 0.35, 0.83];

/** `[[cx, cy], ts]` points, the shape Frigate records a track in. */
const track = (count: number) =>
  Array.from({ length: count }, (_, i) => [[0.5 + i * 0.01, 0.6], 1000 + i * 5]);

describe("deriveFrigateFrames", () => {
  it("reads the REST shape, where box and track are nested under data", () => {
    const event: FrigateEventRecord = {
      camera: "doorbell",
      data: { box: BOX, path_data: track(4) },
    };
    const frames = deriveFrigateFrames(event, { host: HOST });
    expect(frames).toHaveLength(4);
    expect(frames[0].url).toBe(
      "http://192.168.1.225:5000/api/doorbell/recordings/1000/snapshot.jpg",
    );
  });

  it("accepts a flattened record as long as the box is still normalized", () => {
    const event: FrigateEventRecord = {
      camera: "doorbell",
      box: BOX,
      path_data: track(4),
    };
    const frames = deriveFrigateFrames(event, { host: HOST });
    expect(frames).toHaveLength(4);
    expect(frames[0].url).toContain("/recordings/1000/snapshot.jpg");
  });

  it("refuses MQTT's pixel-coordinate box rather than cropping garbage", () => {
    // Captured from a real frigate/events payload: pixel [x1, y1, x2, y2] in
    // the detect frame, NOT normalized [x, y, w, h]. Converting it needs the
    // detect-stream dimensions, which the payload does not carry - so this must
    // refuse rather than crop somewhere meaningless and report "no face".
    const event: FrigateEventRecord = {
      camera: "doorbell",
      box: [528, 244, 566, 262],
      path_data: track(4),
    };
    expect(deriveFrigateFrames(event, { host: HOST })).toEqual([]);
  });

  it("refuses a zero-area box", () => {
    const event: FrigateEventRecord = {
      camera: "doorbell",
      data: { box: [0.5, 0.5, 0, 0.4], path_data: track(2) },
    };
    expect(deriveFrigateFrames(event, { host: HOST })).toEqual([]);
  });

  it("centres each frame's box on where the subject was at that moment", () => {
    const event: FrigateEventRecord = {
      camera: "doorbell",
      data: { box: BOX, path_data: [[[0.5, 0.6], 1000]] },
    };
    const [frame] = deriveFrigateFrames(event, { host: HOST });
    // Box keeps the recorded size but is recentred on the track point.
    expect(frame.box[0]).toBeCloseTo(0.5 - 0.35 / 2, 6);
    expect(frame.box[1]).toBeCloseTo(0.6 - 0.83 / 2, 6);
    expect(frame.box[2]).toBe(0.35);
    expect(frame.box[3]).toBe(0.83);
  });

  it("spreads samples across a long track, keeping first and last", () => {
    const event: FrigateEventRecord = {
      camera: "doorbell",
      data: { box: BOX, path_data: track(11) },
    };
    const frames = deriveFrigateFrames(event, { host: HOST, maxFrames: 4 });
    const stamps = frames.map((f) => Number(f.url.match(/recordings\/(\d+)\//)![1]));
    expect(stamps[0]).toBe(1000);
    expect(stamps.at(-1)).toBe(1050);
    expect(stamps).toHaveLength(4);
    // Strictly increasing — no duplicate moments wasted on the detector.
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it("never returns more frames than the track has points", () => {
    const event: FrigateEventRecord = {
      camera: "doorbell",
      data: { box: BOX, path_data: track(2) },
    };
    expect(deriveFrigateFrames(event, { host: HOST, maxFrames: 4 })).toHaveLength(2);
  });

  it("falls back to evenly spaced timestamps when there is no track", () => {
    const event: FrigateEventRecord = {
      camera: "doorbell",
      start_time: 1000,
      end_time: 1050,
      data: { box: BOX },
    };
    const frames = deriveFrigateFrames(event, { host: HOST, maxFrames: 4 });
    const stamps = frames.map((f) => Number(f.url.match(/recordings\/(\d+)\//)![1]));
    // Interior points only: the ends of an event are the subject entering and
    // leaving frame.
    expect(stamps).toEqual([1010, 1020, 1030, 1040]);
    expect(frames[0].box).toEqual(BOX);
  });

  it("still samples an event that has not ended yet", () => {
    const event: FrigateEventRecord = {
      camera: "doorbell",
      start_time: 1000,
      end_time: null,
      data: { box: BOX },
    };
    const frames = deriveFrigateFrames(event, { host: HOST, maxFrames: 2 });
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.url.includes("/recordings/10"))).toBe(true);
  });

  it("returns nothing when there is no box to crop to", () => {
    // Cropping is what makes a distant face detectable, so a record with no
    // box is not worth a detector pass.
    const event: FrigateEventRecord = { camera: "doorbell", start_time: 1000 };
    expect(deriveFrigateFrames(event, { host: HOST })).toEqual([]);
  });

  it("returns nothing when the camera is missing", () => {
    const event: FrigateEventRecord = { data: { box: BOX, path_data: track(3) } };
    expect(deriveFrigateFrames(event, { host: HOST })).toEqual([]);
  });

  it("ignores malformed track entries rather than emitting broken URLs", () => {
    const event: FrigateEventRecord = {
      camera: "doorbell",
      data: {
        box: BOX,
        path_data: [[[0.5, 0.6], 1000], "nonsense", [[0.5], 1010], [[0.5, 0.6], null]],
      },
    };
    const frames = deriveFrigateFrames(event, { host: HOST });
    expect(frames).toHaveLength(1);
    expect(frames[0].url).toContain("/recordings/1000/");
  });

  it("carries the requested padding onto every frame", () => {
    const event: FrigateEventRecord = {
      camera: "doorbell",
      data: { box: BOX, path_data: track(3) },
    };
    const frames = deriveFrigateFrames(event, { host: HOST, pad: 0.9 });
    expect(frames.map((f) => f.pad)).toEqual([0.9, 0.9, 0.9]);
  });
});
