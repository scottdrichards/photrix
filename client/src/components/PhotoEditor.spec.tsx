import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADJ,
  applyPixelAdj,
  computeStyle,
  deriveAutoAdjFromSample,
  type EditAdj,
} from "./PhotoEditor";

function makeSolidImageData(width: number, height: number, r: number, g: number, b: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return data;
}

describe("vignette", () => {
  it("is off by default and has no effect on the default adjustments", () => {
    expect(DEFAULT_ADJ.vignette).toBe(0);
  });

  it("computeStyle omits vignetteBackground when vignette is 0", () => {
    const style = computeStyle(DEFAULT_ADJ, "test-svg");
    expect(style.vignetteBackground).toBeUndefined();
  });

  it("computeStyle produces a black radial-gradient overlay for a positive (darkening) vignette", () => {
    const adj: EditAdj = { ...DEFAULT_ADJ, vignette: 60 };
    const style = computeStyle(adj, "test-svg");
    expect(style.vignetteBackground).toBeDefined();
    expect(style.vignetteBackground).toContain("radial-gradient");
    expect(style.vignetteBackground).toContain("0, 0, 0");
  });

  it("computeStyle produces a white radial-gradient overlay for a negative (lightening) vignette", () => {
    const adj: EditAdj = { ...DEFAULT_ADJ, vignette: -60 };
    const style = computeStyle(adj, "test-svg");
    expect(style.vignetteBackground).toBeDefined();
    expect(style.vignetteBackground).toContain("255, 255, 255");
  });

  it("applyPixelAdj darkens the corners but leaves the center untouched for a positive vignette", () => {
    const width = 21;
    const height = 21;
    const data = makeSolidImageData(width, height, 200, 200, 200);
    const adj: EditAdj = { ...DEFAULT_ADJ, vignette: 100 };
    applyPixelAdj(data, width, height, adj);

    const centerIdx = ((height >> 1) * width + (width >> 1)) * 4;
    const cornerIdx = 0;
    expect(data[centerIdx]).toBe(200);
    expect(data[cornerIdx]).toBeLessThan(100);
  });

  it("applyPixelAdj lightens the corners toward white for a negative vignette", () => {
    const width = 21;
    const height = 21;
    const data = makeSolidImageData(width, height, 60, 60, 60);
    const adj: EditAdj = { ...DEFAULT_ADJ, vignette: -100 };
    applyPixelAdj(data, width, height, adj);

    const centerIdx = ((height >> 1) * width + (width >> 1)) * 4;
    const cornerIdx = 0;
    expect(data[centerIdx]).toBe(60);
    expect(data[cornerIdx]).toBeGreaterThan(150);
  });

  it("leaves pixels unchanged when vignette is 0", () => {
    const width = 5;
    const height = 5;
    const data = makeSolidImageData(width, height, 128, 128, 128);
    applyPixelAdj(data, width, height, DEFAULT_ADJ);
    expect(Array.from(data)).toEqual(Array.from(makeSolidImageData(width, height, 128, 128, 128)));
  });
});

describe("deriveAutoAdjFromSample (auto-enhance)", () => {
  it("returns no adjustments for an empty sample", () => {
    expect(deriveAutoAdjFromSample(new Uint8ClampedArray(0), 0)).toEqual({});
  });

  it("cools down a warm (orange) color cast toward neutral", () => {
    // Uniformly warm: red channel well above blue.
    const data = makeSolidImageData(10, 10, 200, 150, 90);
    const result = deriveAutoAdjFromSample(data, 100);
    expect(result.temperature).toBeDefined();
    expect(result.temperature!).toBeLessThan(0);
  });

  it("warms up a cool (blue) color cast toward neutral", () => {
    const data = makeSolidImageData(10, 10, 90, 150, 200);
    const result = deriveAutoAdjFromSample(data, 100);
    expect(result.temperature).toBeDefined();
    expect(result.temperature!).toBeGreaterThan(0);
  });

  it("leaves temperature/tint near zero for an already-neutral gray sample", () => {
    const data = makeSolidImageData(10, 10, 128, 128, 128);
    const result = deriveAutoAdjFromSample(data, 100);
    expect(Math.abs(result.temperature ?? 0)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.tint ?? 0)).toBeLessThanOrEqual(1);
  });

  it("brightens a dark sample with positive exposure", () => {
    const data = makeSolidImageData(10, 10, 40, 40, 40);
    const result = deriveAutoAdjFromSample(data, 100);
    expect(result.exposure).toBeGreaterThan(0);
  });

  it("dims an overly bright sample with negative exposure", () => {
    const data = makeSolidImageData(10, 10, 230, 230, 230);
    const result = deriveAutoAdjFromSample(data, 100);
    expect(result.exposure).toBeLessThan(0);
  });

  it("boosts vibrance for a washed-out (low saturation) sample", () => {
    const data = makeSolidImageData(10, 10, 130, 128, 126);
    const result = deriveAutoAdjFromSample(data, 100);
    expect(result.vibrance).toBeGreaterThan(0);
  });

  it("resets highlights and shadows so they don't fight the recomputed tone curve", () => {
    const data = makeSolidImageData(10, 10, 128, 128, 128);
    const result = deriveAutoAdjFromSample(data, 100);
    expect(result.highlights).toBe(0);
    expect(result.shadows).toBe(0);
  });
});
