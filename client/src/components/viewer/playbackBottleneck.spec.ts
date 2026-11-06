import { describe, expect, it } from "vitest";
import {
  classifyBottleneck,
  readSegmentHeaders,
  shouldShowBottleneck,
  summarizeSegments,
  type SegmentSample,
} from "./playbackBottleneck";

const segment = (overrides: Partial<SegmentSample> = {}): SegmentSample => ({
  durationS: 1,
  waitMs: 0,
  transferMs: 100,
  encodeSpeed: null,
  bytes: 1_000_000,
  ...overrides,
});
const repeat = (n: number, overrides: Partial<SegmentSample> = {}) =>
  Array.from({ length: n }, () => segment(overrides));

describe("classifyBottleneck", () => {
  it("finds nothing wrong when segments arrive with time to spare", () => {
    expect(
      classifyBottleneck(repeat(6, { encodeSpeed: 2.5, transferMs: 150 })),
    ).toBeNull();
  });

  it("waits for a few segments before judging", () => {
    expect(classifyBottleneck(repeat(2, { transferMs: 1500 }))).toBeNull();
  });

  it("blames the network when a segment takes about as long to download as to play", () => {
    // 8 Mbit per second of video, delivered at 8 Mbit / 1.2 s.
    expect(classifyBottleneck(repeat(5, { transferMs: 1200, encodeSpeed: 2 }))).toEqual({
      kind: "network",
      neededMbps: 8,
      gettingMbps: 6.7,
    });
  });

  it("blames the encoder when it runs below realtime and downloads are quick", () => {
    expect(
      classifyBottleneck(repeat(5, { transferMs: 80, waitMs: 900, encodeSpeed: 0.85 })),
    ).toEqual({ kind: "encoder", encodeSpeed: 0.85 });
  });

  it("names the larger of the two when both are short", () => {
    const both = repeat(5, { transferMs: 900, encodeSpeed: 0.7 });
    expect(classifyBottleneck(both)?.kind).toBe("encoder");
    const slowerLink = repeat(5, { transferMs: 1600, encodeSpeed: 0.9 });
    expect(classifyBottleneck(slowerLink)?.kind).toBe("network");
  });

  it("judges on recent segments only", () => {
    const recovered = [
      ...repeat(10, { transferMs: 2000 }),
      ...repeat(6, { transferMs: 100 }),
    ];
    expect(classifyBottleneck(recovered)).toBeNull();
  });
});

describe("shouldShowBottleneck", () => {
  const report = { kind: "encoder", encodeSpeed: 0.8 } as const;

  it("shows only while the cause is draining the buffer", () => {
    expect(
      shouldShowBottleneck({ report, stalled: true, bufferAheadS: 0, showing: false }),
    ).toBe(true);
    expect(
      shouldShowBottleneck({ report, stalled: false, bufferAheadS: 2, showing: false }),
    ).toBe(true);
    expect(
      shouldShowBottleneck({ report, stalled: false, bufferAheadS: 4, showing: false }),
    ).toBe(false);
  });

  it("stays up until the buffer has properly refilled", () => {
    expect(
      shouldShowBottleneck({ report, stalled: false, bufferAheadS: 5, showing: true }),
    ).toBe(true);
    expect(
      shouldShowBottleneck({ report, stalled: false, bufferAheadS: 7, showing: true }),
    ).toBe(false);
  });

  it("never shows without a cause", () => {
    expect(
      shouldShowBottleneck({
        report: null,
        stalled: true,
        bufferAheadS: 0,
        showing: true,
      }),
    ).toBe(false);
  });
});

describe("readSegmentHeaders", () => {
  it("reads the server's wait and encoder speed", () => {
    const headers: Record<string, string> = {
      "X-Photrix-Segment-Wait-Ms": "640",
      "X-Photrix-Encode-Speed": "1.08",
    };
    const xhr = { getResponseHeader: (name: string) => headers[name] ?? null };
    expect(readSegmentHeaders(xhr)).toEqual({ waitMs: 640, encodeSpeed: 1.08 });
  });

  it("treats a missing or garbled header as unknown", () => {
    const xhr = {
      getResponseHeader: (name: string) => (name.endsWith("Wait-Ms") ? "x" : null),
    };
    expect(readSegmentHeaders(xhr)).toEqual({ waitMs: null, encodeSpeed: null });
    expect(readSegmentHeaders(undefined)).toEqual({ waitMs: null, encodeSpeed: null });
  });
});

describe("summarizeSegments", () => {
  it("totals server wait against transfer time for the playback summary", () => {
    const summary = summarizeSegments([
      segment({ waitMs: 100, transferMs: 200, encodeSpeed: 1.2 }),
      segment({ waitMs: 300, transferMs: 400, encodeSpeed: 0.9 }),
      segment({ waitMs: null, transferMs: 600 }),
    ]);
    expect(summary).toEqual({
      segments: 3,
      medianWaitMs: 200,
      totalWaitMs: 400,
      medianTransferMs: 400,
      totalTransferMs: 1200,
      medianEncodeSpeed: 1.05,
      minEncodeSpeed: 0.9,
    });
  });
});
