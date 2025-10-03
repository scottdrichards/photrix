import { describe, it, expect } from "vitest";
import { FolderIndexer } from "./folderIndexer.js";
import { createExampleWorkspace } from "../tests/testUtils.js";

async function createIndexer() {
  const workspace = await createExampleWorkspace("photrix-query-");
  const indexer = new FolderIndexer(workspace, { watch: false });
  await indexer.start();
  return { workspace, indexer };
}

describe("FolderIndexer queryFiles", () => {
  it("finds files by filename across directories", async () => {
    const { indexer } = await createIndexer();
    try {
      const result = await indexer.queryFiles({ filename: ["soundboard.heic"] });
      expect(result.total).toBe(1);
      expect(result.items.map((item) => item.path)).toEqual([
        "subFolder/soundboard.heic",
      ]);
    } finally {
      await indexer.stop(true);
    }
  });

  it("filters by directory prefix", async () => {
    const { indexer } = await createIndexer();
    try {
      const result = await indexer.queryFiles({ directory: ["subFolder"] });
      expect(result.total).toBe(1);
      expect(result.items[0]?.path).toBe("subFolder/soundboard.heic");
    } finally {
      await indexer.stop(true);
    }
  });

  it("supports glob patterns for path matching", async () => {
    const { indexer } = await createIndexer();
    try {
      const result = await indexer.queryFiles({ path: ["**/*.heic"] });
      const paths = result.items.map((item) => item.path).sort();
      expect(paths).toEqual(["sewing-threads.heic", "subFolder/soundboard.heic"]);
    } finally {
      await indexer.stop(true);
    }
  });

  it("filters by camera make", async () => {
    const { indexer } = await createIndexer();
    try {
      const result = await indexer.queryFiles({ cameraMake: ["samsung"] });
      expect(result.total).toBe(2);
      expect(result.items.map((item) => item.path).sort()).toEqual([
        "sewing-threads.heic",
        "subFolder/soundboard.heic",
      ]);
    } finally {
      await indexer.stop(true);
    }
  });

  it("filters by location bounding box", async () => {
    const { indexer } = await createIndexer();
    try {
      const result = await indexer.queryFiles({
        location: {
          minLatitude: 41.725,
          maxLatitude: 41.73,
          minLongitude: 1.82,
          maxLongitude: 1.83,
        },
      });
      expect(result.total).toBe(1);
      expect(result.items[0]?.path).toBe("sewing-threads.heic");
    } finally {
      await indexer.stop(true);
    }
  });

  it("returns only requested metadata keys when specified", async () => {
    const { indexer } = await createIndexer();
    try {
      const result = await indexer.queryFiles(
        { filename: ["sewing-threads.heic"] },
        { metadata: ["name", "cameraMake"] },
      );
      expect(result.total).toBe(1);
      const metadata = result.items[0]?.metadata;
      expect(metadata).toBeDefined();
      expect(Object.keys(metadata ?? {})).toEqual(["name", "cameraMake"]);
      expect(metadata?.name).toBe("sewing-threads.heic");
      expect(metadata?.cameraMake?.toLowerCase()).toBe("samsung");
    } finally {
      await indexer.stop(true);
    }
  });
});
