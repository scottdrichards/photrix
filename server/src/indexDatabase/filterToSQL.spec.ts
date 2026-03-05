import { describe, expect, it } from "@jest/globals";
import { filterToSQL } from "./filterToSQL.ts";

describe("filterToSQL", () => {
  it("returns empty where for empty filter", () => {
    const result = filterToSQL({});
    expect(result).toEqual({ where: "", params: [] });
  });

  it("builds exact string and number constraints", () => {
    const result = filterToSQL({ cameraMake: "Canon", rating: 5 });
    expect(result.where).toBe("cameraMake = ? AND rating = ?");
    expect(result.params).toEqual(["Canon", 5]);
  });

  it("builds NULL constraint", () => {
    const result = filterToSQL({ dateTaken: null });
    expect(result.where).toBe("dateTaken IS NULL");
    expect(result.params).toEqual([]);
  });

  it("builds date range constraints with timestamps", () => {
    const min = new Date("2024-01-01T00:00:00.000Z");
    const max = new Date("2024-12-31T23:59:59.999Z");

    const result = filterToSQL({ dateTaken: { min, max } });

    expect(result.where).toBe("dateTaken >= ? AND dateTaken <= ?");
    expect(result.params).toEqual([min.getTime(), max.getTime()]);
  });

  it("builds folder recursive constraint", () => {
    const result = filterToSQL({ folder: { folder: "albums/2024", recursive: true } });
    expect(result.where).toBe("folder LIKE ? ESCAPE '\\'");
    expect(result.params).toEqual(["/albums/2024/%"]);
  });

  it("builds json-array contains lookup for tags", () => {
    const result = filterToSQL({ tags: "family" });
    expect(result.where).toContain("json_each(tags)");
    expect(result.params).toEqual(["family"]);
  });

  it("builds glob search with LIKE", () => {
    const result = filterToSQL({ fileName: { glob: "IMG_*.jpg" } });
    expect(result.where).toBe("fileName LIKE ?");
    expect(result.params).toEqual(["IMG_%[.]jpg"]);
  });

  it("builds relativePath regex search using folder and fileName", () => {
    const result = filterToSQL({ relativePath: { regex: ".*\\.heic$" } });
    expect(result.where).toBe("(folder || fileName) REGEXP ?");
    expect(result.params).toEqual([".*\\.heic$"]);
  });

  it("builds nested logical filters", () => {
    const result = filterToSQL({
      operation: "or",
      conditions: [{ cameraMake: "Canon" }, { cameraMake: "Nikon" }],
    });

    expect(result.where).toBe("(cameraMake = ?) OR (cameraMake = ?)");
    expect(result.params).toEqual(["Canon", "Nikon"]);
  });
});
