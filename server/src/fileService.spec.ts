import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import imageSize from "image-size";
import { FolderIndexer } from "./folderIndexer.js";
import { FileService } from "./fileService.js";
import { createExampleWorkspace, resolveWorkspacePath } from "../tests/testUtils.js";

async function createService() {
  const workspace = await createExampleWorkspace("photrix-files-");
  const indexer = new FolderIndexer(workspace, { watch: false });
  await indexer.start();
  const service = new FileService(indexer);
  return { workspace, indexer, service };
}

describe("FileService", () => {
  it("retrieves file by filename", async () => {
    const { indexer, service } = await createService();
    try {
      const result = await service.getFileByFilename("sewing-threads.heic");
      expect(result.contentType).toBe("image/heic");
      expect(result.data.byteLength).toBeGreaterThan(0);
    } finally {
      await indexer.stop(true);
    }
  });

  it("returns original representation when requested", async () => {
    const { indexer, service, workspace } = await createService();
    try {
      const absolute = resolveWorkspacePath(workspace, "sewing-threads.heic");
      const raw = await readFile(absolute);
      const result = await service.getFile("sewing-threads.heic", {
        representation: { type: "original" },
      });
      const buffer = Buffer.from(result.data);
      expect(buffer.equals(raw)).toBe(true);
      expect(result.contentType).toBe("image/heic");
    } finally {
      await indexer.stop(true);
    }
  });

  it("returns metadata representation", async () => {
    const { indexer, service } = await createService();
    try {
      const result = await service.getFile("sewing-threads.heic", {
        representation: { type: "metadata", metadataKeys: ["name", "cameraMake"] },
      });
      expect(result.contentType).toBe("application/json");
      const text = Buffer.from(result.data).toString("utf8");
      const parsed = JSON.parse(text);
      expect(parsed.name).toBe("sewing-threads.heic");
      expect(parsed.cameraMake?.toLowerCase()).toBe("samsung");
    } finally {
      await indexer.stop(true);
    }
  });

  it("creates webSafe representation", async () => {
    const { indexer, service } = await createService();
    try {
      const result = await service.getFile("sewing-threads.heic", {
        representation: { type: "webSafe" },
      });
      expect(result.contentType).toBe("image/jpeg");
      const buffer = Buffer.from(result.data);
      expect(buffer.byteLength).toBeGreaterThan(0);
      const dimensions = imageSize(buffer);
      expect(dimensions.width).toBeLessThanOrEqual(4000);
      expect(dimensions.height).toBeLessThanOrEqual(3000);
    } finally {
      await indexer.stop(true);
    }
  });

  it("resizes images when resize representation is provided", async () => {
    const { indexer, service } = await createService();
    try {
      const result = await service.getFile("sewing-threads.heic", {
        representation: { type: "resize", maxWidth: 800 },
      });
      expect(result.contentType).toBe("image/jpeg");
      const buffer = Buffer.from(result.data);
      expect(buffer.byteLength).toBeGreaterThan(0);
      const dimensions = imageSize(buffer);
      expect(dimensions.width).toBeLessThanOrEqual(800);
      expect(dimensions.height).toBeLessThanOrEqual(800);
    } finally {
      await indexer.stop(true);
    }
  });

  it("throws when requesting unknown file", async () => {
    const { indexer, service } = await createService();
    try {
      await expect(service.getFile("missing.jpg")).rejects.toThrow(
        /not currently indexed/i
      );
    } finally {
      await indexer.stop(true);
    }
  });

  it("throws when filename not found", async () => {
    const { indexer, service } = await createService();
    try {
      await expect(service.getFileByFilename("missing.jpg")).rejects.toThrow(
        /not found/i
      );
    } finally {
      await indexer.stop(true);
    }
  });
});
