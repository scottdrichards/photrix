import { describe, expect, it } from "@jest/globals";
import {
  extractShareFolderRoots,
  isFolderWithinShareScope,
} from "./shareFolderScope.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";

const folderShare = (folder: string, recursive = true): FilterElement =>
  ({ folder: { folder, recursive } }) as unknown as FilterElement;

describe("extractShareFolderRoots", () => {
  it("finds the root of a folder share", () => {
    expect(extractShareFolderRoots(folderShare("/Sarah Pictures/2009"))).toEqual([
      { folder: "/Sarah Pictures/2009/", recursive: true },
    ]);
  });

  it("keeps a non-recursive share pinned to the single folder", () => {
    expect(extractShareFolderRoots(folderShare("/Sarah Pictures/2009", false))).toEqual([
      { folder: "/Sarah Pictures/2009/", recursive: false },
    ]);
  });

  it("finds the root when the folder is ANDed with other conditions", () => {
    const filter = {
      operation: "and",
      conditions: [folderShare("/Trips/Iceland"), { rating: 5 }],
    } as unknown as FilterElement;
    expect(extractShareFolderRoots(filter)).toEqual([
      { folder: "/Trips/Iceland/", recursive: true },
    ]);
  });

  it("narrows to the tighter root when two folder conditions are ANDed", () => {
    const filter = {
      operation: "and",
      conditions: [folderShare("/Trips"), folderShare("/Trips/Iceland")],
    } as unknown as FilterElement;
    expect(extractShareFolderRoots(filter)).toEqual([
      { folder: "/Trips/Iceland/", recursive: true },
    ]);
  });

  it("yields no browsable root for a contradictory AND", () => {
    const filter = {
      operation: "and",
      conditions: [folderShare("/Trips/Iceland"), folderShare("/Trips/Japan")],
    } as unknown as FilterElement;
    expect(extractShareFolderRoots(filter)).toEqual([]);
  });

  it("unions the roots of an OR", () => {
    const filter = {
      operation: "or",
      conditions: [folderShare("/A"), folderShare("/B")],
    } as unknown as FilterElement;
    expect(extractShareFolderRoots(filter)).toEqual([
      { folder: "/A/", recursive: true },
      { folder: "/B/", recursive: true },
    ]);
  });

  it("is unbounded when any OR branch is unbounded", () => {
    const filter = {
      operation: "or",
      conditions: [folderShare("/A"), { rating: 5 }],
    } as unknown as FilterElement;
    expect(extractShareFolderRoots(filter)).toBeNull();
  });

  it("is unbounded for a share that is not folder-based", () => {
    expect(extractShareFolderRoots({} as FilterElement)).toBeNull();
    expect(extractShareFolderRoots({ rating: 5 } as unknown as FilterElement)).toBeNull();
    // A StringSearch on folder is not a folder-tree bound.
    expect(
      extractShareFolderRoots({ folder: { includes: "2009" } } as unknown as FilterElement),
    ).toBeNull();
  });
});

describe("isFolderWithinShareScope", () => {
  const roots = extractShareFolderRoots(folderShare("/Sarah Pictures/2009"));

  it("allows the shared root itself", () => {
    expect(isFolderWithinShareScope("/Sarah Pictures/2009", roots)).toBe(true);
  });

  it("allows browsing into subfolders — the point of #32", () => {
    expect(isFolderWithinShareScope("/Sarah Pictures/2009/11", roots)).toBe(true);
    expect(isFolderWithinShareScope("/Sarah Pictures/2009/11/birthday", roots)).toBe(true);
  });

  it("allows the ancestor chain so the viewer can navigate down to the share", () => {
    expect(isFolderWithinShareScope("/", roots)).toBe(true);
    expect(isFolderWithinShareScope("/Sarah Pictures", roots)).toBe(true);
  });

  it("refuses siblings and anything else outside the shared subtree", () => {
    expect(isFolderWithinShareScope("/Sarah Pictures/2010", roots)).toBe(false);
    expect(isFolderWithinShareScope("/Private", roots)).toBe(false);
    expect(isFolderWithinShareScope("/Sarah Pictures/2009x", roots)).toBe(false);
  });

  it("refuses subfolders of a non-recursive share", () => {
    const single = extractShareFolderRoots(folderShare("/Sarah Pictures/2009", false));
    expect(isFolderWithinShareScope("/Sarah Pictures/2009", single)).toBe(true);
    expect(isFolderWithinShareScope("/Sarah Pictures/2009/11", single)).toBe(false);
  });

  it("refuses everything when the share scope is unsatisfiable", () => {
    expect(isFolderWithinShareScope("/", [])).toBe(false);
    expect(isFolderWithinShareScope("/anything", [])).toBe(false);
  });

  it("imposes no path clamp when the share is not folder-based", () => {
    // The share filter itself is the boundary in this case; the listing only
    // ever contains folders holding shared items.
    expect(isFolderWithinShareScope("/anywhere", null)).toBe(true);
  });
});
