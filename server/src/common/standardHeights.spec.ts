import { parseToStandardHeight, standardHeights } from "./standardHeights.js";

describe("parseToStandardHeight", () => {
  it("returns original for missing or invalid input", () => {
    expect(parseToStandardHeight(null)).toBe("original");
    expect(parseToStandardHeight("" as string | null)).toBe("original");
    expect(parseToStandardHeight("not-a-number")).toBe("original");
  });

  it("returns the exact standard height when provided", () => {
    expect(parseToStandardHeight("320")).toBe(320);
    expect(parseToStandardHeight("1080")).toBe(1080);
  });

  it("rounds up to the next standard height", () => {
    expect(parseToStandardHeight("161")).toBe(320);
    expect(parseToStandardHeight("500")).toBe(640);
  });

  it("falls back to original when larger than known sizes", () => {
    expect(parseToStandardHeight("4000")).toBe("original");
  });

  it("returns smallest standard height for negative numbers", () => {
    expect(parseToStandardHeight("-5")).toBe(160);
  });

  it("includes original in available heights", () => {
    expect(standardHeights.includes("original")).toBe(true);
  });
});
