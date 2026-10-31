import { fitsOneShare, WEB_SHARE_MAX_BYTES } from "./webShareLimits";

const MB = 1024 * 1024;

describe("fitsOneShare", () => {
  it("accepts up to 10 files within 50 MB", () => {
    expect(fitsOneShare(Array.from({ length: 10 }, () => 2 * MB))).toBe(true);
    expect(fitsOneShare([WEB_SHARE_MAX_BYTES])).toBe(true);
  });

  it("refuses more than 10 files whatever their size", () => {
    expect(fitsOneShare(Array.from({ length: 11 }, () => 1))).toBe(false);
    expect(fitsOneShare(Array.from({ length: 11 }, () => undefined))).toBe(false);
  });

  it("refuses more than 50 MB in total", () => {
    expect(fitsOneShare([30 * MB, 21 * MB])).toBe(false);
    expect(fitsOneShare([WEB_SHARE_MAX_BYTES + 1])).toBe(false);
  });

  it("counts an unknown size as nothing", () => {
    expect(fitsOneShare([undefined, 49 * MB])).toBe(true);
    expect(fitsOneShare([undefined, 51 * MB])).toBe(false);
  });
});
