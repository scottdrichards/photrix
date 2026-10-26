import { describe, expect, it } from "vitest";
import {
  formatAperture,
  formatFileSize,
  formatFocalLength,
  formatShutterSpeed,
} from "./formatFileInfo";

describe("formatShutterSpeed", () => {
  it("renders sub-second exposures as a reciprocal", () => {
    expect(formatShutterSpeed(0.004)).toBe("1/250s");
    expect(formatShutterSpeed("0.5")).toBe("1/2s");
  });
  it("renders exposures of a second or more in seconds", () => {
    expect(formatShutterSpeed(2)).toBe("2s");
  });
  it("returns null for invalid or non-positive input", () => {
    expect(formatShutterSpeed(0)).toBeNull();
    expect(formatShutterSpeed(-1)).toBeNull();
    expect(formatShutterSpeed("abc")).toBeNull();
    expect(formatShutterSpeed(undefined)).toBeNull();
  });
});

describe("formatAperture", () => {
  it("drops the decimal for whole stops and keeps one otherwise", () => {
    expect(formatAperture(8)).toBe("f/8");
    expect(formatAperture(1.8)).toBe("f/1.8");
    expect(formatAperture("2.8")).toBe("f/2.8");
  });
  it("returns null for invalid input", () => {
    expect(formatAperture(0)).toBeNull();
    expect(formatAperture(null)).toBeNull();
    expect(formatAperture("x")).toBeNull();
  });
});

describe("formatFocalLength", () => {
  it("resolves rational notation", () => {
    expect(formatFocalLength("50/1")).toBe("50mm");
    expect(formatFocalLength("245/10")).toBe("25mm");
  });
  it("formats plain numbers", () => {
    expect(formatFocalLength(35)).toBe("35mm");
    expect(formatFocalLength(5.4)).toBe("5.4mm");
  });
  it("keeps strings that already carry a unit", () => {
    expect(formatFocalLength("24 mm")).toBe("24 mm");
  });
  it("returns null for non string/number input", () => {
    expect(formatFocalLength(undefined)).toBeNull();
    expect(formatFocalLength({})).toBeNull();
  });
});

describe("formatFileSize", () => {
  it("scales across B, KB, MB and GB", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatFileSize(1.5 * 1024 ** 3)).toBe("1.50 GB");
  });
  it("returns null for negative or non-numeric input", () => {
    expect(formatFileSize(-1)).toBeNull();
    expect(formatFileSize("nope")).toBeNull();
  });
});
