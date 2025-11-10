import { describe, it, expect } from "@jest/globals";
import { matchesFilter } from "./matchesFilter.ts";
import type { FileRecord } from "./indexDatabase.type.ts";

const createFileRecord = (relativePath: string): FileRecord => ({
  relativePath,
  mimeType: "image/jpeg",
  sizeInBytes: 1000,
  created: new Date("2020-01-01"),
  modified: new Date("2020-01-01"),
});

describe("matchesFilter - path filtering", () => {
  describe("regex filter for subfolder exclusion", () => {
    it("should match files directly in the folder", () => {
      const filter = {
        relativePath: {
          regex: "^subFolder/[^/]+$"
        }
      };

      const file1 = createFileRecord("subFolder/file1.jpg");
      const file2 = createFileRecord("subFolder/file2.png");

      expect(matchesFilter(file1, filter)).toBe(true);
      expect(matchesFilter(file2, filter)).toBe(true);
    });

    it("should NOT match files in subfolders", () => {
      const filter = {
        relativePath: {
          regex: "^subFolder/[^/]+$"
        }
      };

      const file1 = createFileRecord("subFolder/nested/file1.jpg");
      const file2 = createFileRecord("subFolder/nested/deeper/file2.png");
      const file3 = createFileRecord("subFolder/another/file3.jpg");

      expect(matchesFilter(file1, filter)).toBe(false);
      expect(matchesFilter(file2, filter)).toBe(false);
      expect(matchesFilter(file3, filter)).toBe(false);
    });

    it("should NOT match files in sibling folders", () => {
      const filter = {
        relativePath: {
          regex: "^subFolder/[^/]+$"
        }
      };

      const file1 = createFileRecord("otherFolder/file1.jpg");
      const file2 = createFileRecord("file2.jpg");

      expect(matchesFilter(file1, filter)).toBe(false);
      expect(matchesFilter(file2, filter)).toBe(false);
    });

    it("should handle nested paths correctly", () => {
      const filter = {
        relativePath: {
          regex: "^subFolder/nested/[^/]+$"
        }
      };

      const match1 = createFileRecord("subFolder/nested/file1.jpg");
      const match2 = createFileRecord("subFolder/nested/file2.png");
      const noMatch1 = createFileRecord("subFolder/file.jpg");
      const noMatch2 = createFileRecord("subFolder/nested/deeper/file.jpg");

      expect(matchesFilter(match1, filter)).toBe(true);
      expect(matchesFilter(match2, filter)).toBe(true);
      expect(matchesFilter(noMatch1, filter)).toBe(false);
      expect(matchesFilter(noMatch2, filter)).toBe(false);
    });

    it("should escape special regex characters in path", () => {
      // Test that paths with special chars are properly escaped
      const pathWithSpecialChars = "folder.with.dots";
      const escapedPath = pathWithSpecialChars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      const filter = {
        relativePath: {
          regex: `^${escapedPath}/[^/]+$`
        }
      };

      const match = createFileRecord("folder.with.dots/file.jpg");
      const noMatch = createFileRecord("folderXwithXdots/file.jpg");

      expect(matchesFilter(match, filter)).toBe(true);
      expect(matchesFilter(noMatch, filter)).toBe(false);
    });
  });

  describe("glob filter", () => {
    it("should match files with glob pattern", () => {
      const filter = {
        relativePath: {
          glob: "subFolder/*.jpg"
        }
      };

      const match1 = createFileRecord("subFolder/file1.jpg");
      const match2 = createFileRecord("subFolder/file2.jpg");
      const noMatch = createFileRecord("subFolder/file.png");

      expect(matchesFilter(match1, filter)).toBe(true);
      expect(matchesFilter(match2, filter)).toBe(true);
      expect(matchesFilter(noMatch, filter)).toBe(false);
    });
  });

  describe("includes filter", () => {
    it("should match files containing string", () => {
      const filter = {
        relativePath: {
          includes: "vacation"
        }
      };

      const match1 = createFileRecord("2024/vacation/photo.jpg");
      const match2 = createFileRecord("vacation-pics/img.png");
      const noMatch = createFileRecord("work/document.pdf");

      expect(matchesFilter(match1, filter)).toBe(true);
      expect(matchesFilter(match2, filter)).toBe(true);
      expect(matchesFilter(noMatch, filter)).toBe(false);
    });
  });

  describe("empty filter", () => {
    it("should match all files", () => {
      const filter = {};

      const file1 = createFileRecord("any/path/file.jpg");
      const file2 = createFileRecord("another/file.png");

      expect(matchesFilter(file1, filter)).toBe(true);
      expect(matchesFilter(file2, filter)).toBe(true);
    });
  });

  describe("logical filters", () => {
    it("should handle AND operation", () => {
      const filter = {
        operation: "and" as const,
        conditions: [
          { relativePath: { includes: "subFolder" } },
          { mimeType: "image/jpeg" }
        ]
      };

      const match = createFileRecord("subFolder/file.jpg");
      const noMatch1 = createFileRecord("otherFolder/file.jpg");
      const noMatch2 = { ...createFileRecord("subFolder/file.png"), mimeType: "image/png" };

      expect(matchesFilter(match, filter)).toBe(true);
      expect(matchesFilter(noMatch1, filter)).toBe(false);
      expect(matchesFilter(noMatch2, filter)).toBe(false);
    });

    it("should handle OR operation", () => {
      const filter = {
        operation: "or" as const,
        conditions: [
          { relativePath: { includes: "folder1" } },
          { relativePath: { includes: "folder2" } }
        ]
      };

      const match1 = createFileRecord("folder1/file.jpg");
      const match2 = createFileRecord("folder2/file.jpg");
      const noMatch = createFileRecord("folder3/file.jpg");

      expect(matchesFilter(match1, filter)).toBe(true);
      expect(matchesFilter(match2, filter)).toBe(true);
      expect(matchesFilter(noMatch, filter)).toBe(false);
    });
  });
});
