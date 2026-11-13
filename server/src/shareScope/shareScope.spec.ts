import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const embedText = jest.fn<(q: string) => Promise<Float32Array>>();
const embedTextWithClap = jest.fn<(q: string) => Promise<Float32Array>>();

jest.unstable_mockModule("../imageAnalysis/imageAnalysisWorker.ts", () => ({ embedText }));
jest.unstable_mockModule("../audioProcessing/clapWorker.ts", () => ({ embedTextWithClap }));

const { resolveShareFilter, ShareScopeError } = await import("./shareScope.ts");

const noExclusions = { getDefaultExclusionFilter: async () => null };

describe("resolveShareFilter", () => {
  beforeEach(() => {
    embedText.mockReset();
    embedTextWithClap.mockReset();
  });

  it("returns a plain share's filter without embedding anything", async () => {
    await expect(resolveShareFilter({ filter: { folder: { folder: "/a" } } }, noExclusions, "t0")).resolves.toEqual(
      { folder: { folder: "/a" } },
    );
    expect(embedText).not.toHaveBeenCalled();
  });

  it("shares one in-flight resolution between concurrent requests", async () => {
    let finish: (v: Float32Array) => void = () => {};
    embedText.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const scope = { filter: {}, semanticQuery: "beach", searchSources: ["image" as const] };

    const results = Array.from({ length: 20 }, () => resolveShareFilter(scope, noExclusions, "t1"));
    finish(new Float32Array([0.5, 0.5]));
    const filters = await Promise.all(results);

    expect(embedText).toHaveBeenCalledTimes(1);
    expect(new Set(filters).size).toBe(1);
  });

  it("does not cache a failure", async () => {
    embedText.mockRejectedValueOnce(new Error("worker busy"));
    embedText.mockResolvedValueOnce(new Float32Array([1]));
    const scope = { filter: {}, semanticQuery: "dogs", searchSources: ["image" as const] };

    await expect(resolveShareFilter(scope, noExclusions, "t2")).rejects.toThrow("worker busy");
    await expect(resolveShareFilter(scope, noExclusions, "t2")).resolves.toBeTruthy();
    expect(embedText).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an empty filter", {}],
    ["a root folder", { folder: { folder: "/", recursive: true } }],
    ["an empty logical filter", { operation: "and", conditions: [] }],
    ["an uncompilable clause", { semanticImage: { queryVector: [], minSimilarity: 0.2 } }],
    ["an injected field name", { "1) OR (1": "x" }],
  ])("refuses a share scoped by %s", async (_label, filter) => {
    const result = resolveShareFilter({ filter }, noExclusions, `t-${_label}`);
    await expect(result).rejects.toBeInstanceOf(ShareScopeError);
    await expect(result).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a semantic share whose resolved filter still drops a clause", async () => {
    embedText.mockResolvedValueOnce(new Float32Array([]));
    const scope = { filter: {}, semanticQuery: "x", searchSources: ["image" as const] };
    await expect(resolveShareFilter(scope, noExclusions, "t3")).rejects.toMatchObject({ statusCode: 403 });
  });

  // A share sees what the owner sees: the standing "hide by default" filter
  // (feedback #95) applies to every request a share link makes.
  it("excludes what the owner hides by default", async () => {
    const database = { getDefaultExclusionFilter: async () => ({ tags: ["private"] }) };
    await expect(
      resolveShareFilter({ filter: { folder: { folder: "/a" } } }, database, "t4"),
    ).resolves.toEqual({
      operation: "and",
      conditions: [
        { folder: { folder: "/a" } },
        { operation: "not", conditions: [{ tags: ["private"] }] },
      ],
    });
  });
});
