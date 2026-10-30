import { planShareParts, WEB_SHARE_MAX_BYTES } from "./shareParts";

const MB = 1024 * 1024;
const fileOf = (name: string, bytes: number) => {
  const file = new File(["x"], name);
  Object.defineProperty(file, "size", { value: bytes });
  return file;
};
const names = (files: File[]) => files.map((f) => f.name);

describe("planShareParts", () => {
  it("keeps a set within the limits as one part", () => {
    const files = Array.from({ length: 10 }, (_, i) => fileOf(`${i}.jpg`, 2 * MB));
    const plan = planShareParts(files);
    expect(plan.parts).toHaveLength(1);
    expect(plan.tooLarge).toEqual([]);
  });

  it("splits by count, in order", () => {
    const files = Array.from({ length: 23 }, (_, i) => fileOf(`${i}.jpg`, MB));
    const plan = planShareParts(files);
    expect(plan.parts.map((p) => p.length)).toEqual([10, 10, 3]);
    expect(names(plan.parts.flat())).toEqual(names(files));
  });

  it("splits by total bytes", () => {
    const files = [fileOf("a", 30 * MB), fileOf("b", 15 * MB), fileOf("c", 10 * MB), fileOf("d", 5 * MB)];
    const plan = planShareParts(files);
    expect(plan.parts.map(names)).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("allows a part of exactly the byte limit", () => {
    const plan = planShareParts([fileOf("a", WEB_SHARE_MAX_BYTES)]);
    expect(plan.parts.map(names)).toEqual([["a"]]);
  });

  it("sets aside a file over the limit on its own", () => {
    const plan = planShareParts([fileOf("a.jpg", MB), fileOf("big.mp4", 80 * MB), fileOf("b.jpg", MB)]);
    expect(plan.parts.map(names)).toEqual([["a.jpg", "b.jpg"]]);
    expect(names(plan.tooLarge)).toEqual(["big.mp4"]);
  });

  it("returns no parts when every file is too large", () => {
    const plan = planShareParts([fileOf("big.mp4", 80 * MB)]);
    expect(plan.parts).toEqual([]);
    expect(names(plan.tooLarge)).toEqual(["big.mp4"]);
  });
});
