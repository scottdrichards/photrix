import { describe, expect, it } from "vitest";
import { buildFilters, buildFullShareFilter, toFaceAttributeKeys } from "./filters";

const faceCondition = (filters: Record<string, unknown>[]) =>
  filters.find(
    (filter) => "faceCluster" in filter || "faceMatch" in filter || "operation" in filter,
  );

describe("toFaceAttributeKeys", () => {
  it("returns nothing for an absent or empty selection", () => {
    expect(toFaceAttributeKeys(null)).toEqual([]);
    expect(toFaceAttributeKeys(undefined)).toEqual([]);
    expect(toFaceAttributeKeys({ attributes: [] })).toEqual([]);
  });

  it("normalises to canonical order so the emitted filter is stable", () => {
    // The filter JSON is a request cache key and is embedded verbatim in share
    // links, so the same selection must always serialise identically.
    expect(toFaceAttributeKeys({ attributes: ["inFocus", "smiling"] })).toEqual([
      "smiling",
      "inFocus",
    ]);
    expect(toFaceAttributeKeys({ attributes: ["smiling", "inFocus"] })).toEqual([
      "smiling",
      "inFocus",
    ]);
  });

  it("drops unrecognised keys", () => {
    expect(
      toFaceAttributeKeys({ attributes: ["smiling", "wearingAHat"] as never }),
    ).toEqual(["smiling"]);
  });
});

describe("buildFilters — face conditions", () => {
  it("emits the plain person filter when no attributes are selected", () => {
    const filters = buildFilters({ faceClusterFilter: ["person-3", "person-12"] });

    // Unchanged from before attributes existed, so existing share links and
    // cached queries keep producing byte-identical filter JSON.
    expect(faceCondition(filters)).toEqual({ faceCluster: [3, 12] });
  });

  it("combines people and attributes into a single condition", () => {
    const filters = buildFilters({
      faceClusterFilter: ["person-3"],
      faceAttributeFilter: { attributes: ["smiling", "eyesOpen"] },
    });

    // One condition, not two: the attributes must apply to person 3's own face.
    expect(faceCondition(filters)).toEqual({
      faceMatch: { clusterIds: [3], attributes: ["smiling", "eyesOpen"] },
    });
    expect(filters.filter((filter) => "faceCluster" in filter)).toHaveLength(0);
  });

  it("ORs selected people in 'any' mode when attributes are present", () => {
    const filters = buildFilters({
      faceClusterFilter: ["person-3", "person-12"],
      faceClusterMatchMode: "any",
      faceAttributeFilter: { attributes: ["smiling"] },
    });

    expect(faceCondition(filters)).toEqual({
      operation: "or",
      conditions: [
        { faceMatch: { clusterIds: [3], attributes: ["smiling"] } },
        { faceMatch: { clusterIds: [12], attributes: ["smiling"] } },
      ],
    });
  });

  it("allows attributes with no person selected", () => {
    const filters = buildFilters({
      faceAttributeFilter: { attributes: ["inFocus"] },
    });

    expect(faceCondition(filters)).toEqual({ faceMatch: { attributes: ["inFocus"] } });
  });

  it("omits includeUnknown when it matches the server default", () => {
    const filters = buildFilters({
      faceAttributeFilter: { attributes: ["smiling"], includeUnknown: true },
    });

    expect(faceCondition(filters)).toEqual({ faceMatch: { attributes: ["smiling"] } });
  });

  it("sends includeUnknown only when the user asked to exclude unscored faces", () => {
    const filters = buildFilters({
      faceAttributeFilter: { attributes: ["smiling"], includeUnknown: false },
    });

    expect(faceCondition(filters)).toEqual({
      faceMatch: { attributes: ["smiling"], includeUnknown: false },
    });
  });

  it("falls back to the person filter when every attribute is unrecognised", () => {
    const filters = buildFilters({
      faceClusterFilter: ["person-9"],
      faceAttributeFilter: { attributes: ["nonsense"] as never },
    });

    expect(faceCondition(filters)).toEqual({ faceCluster: [9] });
  });

  it("emits no face condition at all when nothing is selected", () => {
    expect(faceCondition(buildFilters({}))).toBeUndefined();
    expect(
      faceCondition(buildFilters({ faceAttributeFilter: { attributes: [] } })),
    ).toBeUndefined();
  });

  it("ORs plain person filters in 'any' mode without attributes", () => {
    const filters = buildFilters({
      faceClusterFilter: ["person-3", "person-12"],
      faceClusterMatchMode: "any",
    });

    expect(faceCondition(filters)).toEqual({
      operation: "or",
      conditions: [{ faceCluster: 3 }, { faceCluster: 12 }],
    });
  });
});

describe("buildFullShareFilter", () => {
  it("carries face attributes into the share scope", () => {
    // A share of a "photo ready" view must stay narrowed for the recipient.
    const shared = buildFullShareFilter({
      faceClusterFilter: ["person-4"],
      faceAttributeFilter: { attributes: ["smiling", "wellExposed"] },
    });

    expect(shared).toEqual({
      faceMatch: { clusterIds: [4], attributes: ["smiling", "wellExposed"] },
    });
  });
});
