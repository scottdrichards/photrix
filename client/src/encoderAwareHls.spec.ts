import Hls from "hls.js";
import { describe, expect, it } from "vitest";
import {
  createEncoderAwareAbrController,
  createServerWaitTracker,
  discountServerWait,
  hasFirstByte,
  onTheFlyHlsConfig,
} from "./encoderAwareHls";

const stats = (start: number, first: number, end: number) => ({
  aborted: false,
  loaded: 600_000,
  retry: 0,
  total: 600_000,
  chunkCount: 1,
  bwEstimate: 0,
  loading: { start, first, end },
  parsing: { start: 0, end: 0 },
  buffering: { start: 0, first: 0, end: 0 },
});

describe("discountServerWait", () => {
  it("leaves a request at the round-trip floor alone", () => {
    const tracker = createServerWaitTracker();
    const s = stats(1000, 1040, 1100);
    expect(discountServerWait(s, tracker)).toBe(0);
    expect(s.loading.start).toBe(1000);
  });

  it("takes the encoder's wait out of the time a segment took to load", () => {
    const tracker = createServerWaitTracker();
    discountServerWait(stats(0, 40, 100), tracker); // a playlist: answered at once

    // A 1080p segment the server had to encode first: 3 s to the first byte,
    // then 60 ms to transfer. Counted whole, that reads as 1.6 Mbit/s and
    // hls.js drops to 360p; the network actually moved it at ~80 Mbit/s.
    const s = stats(10_000, 13_000, 13_060);
    expect(discountServerWait(s, tracker)).toBe(2_960);
    expect(s.loading.start).toBe(12_960);
    expect(s.loading.end - s.loading.start).toBe(100);
  });

  it("does nothing to a request that never got a first byte", () => {
    const tracker = createServerWaitTracker();
    const s = stats(1000, 0, 0);
    expect(discountServerWait(s, tracker)).toBe(0);
    expect(s.loading.start).toBe(1000);
    expect(tracker.minTtfbMs).toBe(Infinity);
  });
});

describe("the encoder-aware ABR controller", () => {
  it("hooks the real hls.js emergency-abandon rule", () => {
    // If this fails after an hls.js upgrade, the internal it wraps was renamed
    // and ABR has silently gone back to abandoning segments the server is
    // still encoding. Find the new name in hls.js's abr-controller.
    const hls = new Hls({ abrController: createEncoderAwareAbrController(Hls) });
    const controller = (hls as unknown as { abrController: { encoderAware?: boolean } })
      .abrController;
    expect(controller.encoderAware).toBe(true);
    hls.destroy();
  });

  it("is part of the viewer's config", () => {
    const config = onTheFlyHlsConfig(Hls, 50);
    expect(config.abrController).toBeDefined();
    expect(config.abrEwmaDefaultEstimate).toBe(50_000_000);
  });

  it("only lets the abandon rule judge a fragment whose bytes are flowing", () => {
    expect(hasFirstByte(stats(1000, 0, 0))).toBe(false);
    expect(hasFirstByte(stats(1000, 1500, 0))).toBe(true);
  });
});
