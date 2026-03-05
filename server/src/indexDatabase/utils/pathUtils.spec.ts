import { describe, expect, it } from "@jest/globals";
import { joinPath, normalizeFolderPath, splitPath } from "./pathUtils.ts";

describe("pathUtils", () => {
  it("normalizes folder path separators and slashes", () => {
    expect(normalizeFolderPath("photos\\2024")).toBe("/photos/2024/");
    expect(normalizeFolderPath("/photos/2024/")).toBe("/photos/2024/");
    expect(normalizeFolderPath("/")).toBe("/");
  });

  it("splits root file path", () => {
    expect(splitPath("file.jpg")).toEqual({ folder: "/", fileName: "file.jpg" });
  });

  it("splits nested file path with windows separators", () => {
    expect(splitPath("a\\b\\c.mp4")).toEqual({ folder: "/a/b/", fileName: "c.mp4" });
  });

  it("joins folder and file into normalized relative path", () => {
    expect(joinPath("a\\b", "file.jpg")).toBe("/a/b/file.jpg");
  });
});
