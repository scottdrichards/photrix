import { describe, expect, it } from "@jest/globals";
import { hlsOutputFrameRate } from "./hlsOutputFrameRate.ts";

describe("hlsOutputFrameRate", () => {
  it("keeps the source rate when it is 30fps or less, so no frames are repeated", () => {
    expect(hlsOutputFrameRate("15/1")).toBe("15/1");
    expect(hlsOutputFrameRate("24000/1001")).toBe("24000/1001");
    expect(hlsOutputFrameRate("25/1")).toBe("25/1");
    expect(hlsOutputFrameRate("30/1")).toBe("30/1");
  });

  it("halves (or thirds, quarters…) faster sources so every kept frame is evenly spaced", () => {
    expect(hlsOutputFrameRate("60/1")).toBe("30/1");
    expect(hlsOutputFrameRate("60000/1001")).toBe("30000/1001");
    expect(hlsOutputFrameRate("50/1")).toBe("25/1");
    expect(hlsOutputFrameRate("120/1")).toBe("30/1");
    expect(hlsOutputFrameRate("240/1")).toBe("30/1");
  });

  it("snaps a variable-frame-rate phone clip's average to the standard rate it is near", () => {
    // iPhone VFR clips report an average a hair off 30 (or 60).
    expect(hlsOutputFrameRate("5999/200")).toBe("30/1");
    expect(hlsOutputFrameRate("359940/5999")).toBe("30/1");
  });

  it("uses 30fps when ffprobe reports no usable rate", () => {
    expect(hlsOutputFrameRate("0/0")).toBe("30/1");
    expect(hlsOutputFrameRate("")).toBe("30/1");
  });
});
