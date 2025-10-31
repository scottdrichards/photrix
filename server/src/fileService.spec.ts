import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { imageSize } from "image-size";
import { FolderIndexer } from "./folderIndexer.js";
import sharp from "sharp";
import { FileService, type FileServiceOptions } from "./fileService.js";
import { createExampleWorkspace, resolveWorkspacePath } from "../tests/testUtils.js";

async function createService(options?: FileServiceOptions) {
  const workspace = await createExampleWorkspace("photrix-files-");
  const indexer = new FolderIndexer(workspace, { watch: false });
  await indexer.start();
  const service = new FileService(indexer, options);
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
        representation: { type: "metadata", metadataKeys: ["cameraMake", "mimeType"] },
      });
      expect(result.contentType).toBe("application/json");
      const text = Buffer.from(result.data).toString("utf8");
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed.name).toBeUndefined();
      expect((parsed.mimeType as string | undefined)?.toLowerCase()).toContain(
        "image/heic",
      );
      expect((parsed.cameraMake as string | undefined)?.toLowerCase()).toBe("samsung");
      expect(Object.keys(parsed)).toEqual(["cameraMake", "mimeType"]);
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
      expect(result.contentType).toBe("image/webp");
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
        /not currently indexed/i,
      );
    } finally {
      await indexer.stop(true);
    }
  });

  it("throws when filename not found", async () => {
    const { indexer, service } = await createService();
    try {
      await expect(service.getFileByFilename("missing.jpg")).rejects.toThrow(
        /not found/i,
      );
    } finally {
      await indexer.stop(true);
    }
  });

  it("uses video thumbnail extractor when resizing a video", async () => {
    const thumbnail = await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 3,
        background: { r: 12, g: 92, b: 164 },
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    const { indexer, service, workspace } = await createService({
      videoThumbnailExtractor: async () => thumbnail,
    });

    try {
      const relativePath = "sample-video.mp4";
      const absolutePath = resolveWorkspacePath(workspace, relativePath);
      await writeFile(absolutePath, Buffer.from("not-a-real-video"));
      await indexer.indexFile(absolutePath);

      const result = await service.getFile(relativePath, {
        representation: { type: "resize", maxWidth: 320, maxHeight: 320 },
      });

      expect(result.contentType).toBe("image/webp");
      const buffer = Buffer.from(result.data);
      expect(buffer.byteLength).toBeGreaterThan(0);
      const dimensions = imageSize(buffer);
      expect(dimensions.width).toBeLessThanOrEqual(320);
      expect(dimensions.height).toBeLessThanOrEqual(320);
    } finally {
      await indexer.stop(true);
    }
  });

  it("falls back to placeholder thumbnail when extractor fails", async () => {
    const { indexer, service, workspace } = await createService({
      videoThumbnailExtractor: async () => {
        throw new Error("boom");
      },
    });

    try {
      const relativePath = "broken-video.mp4";
      const absolutePath = resolveWorkspacePath(workspace, relativePath);
      await writeFile(absolutePath, Buffer.from("still-not-a-video"));
      await indexer.indexFile(absolutePath);

      const result = await service.getFile(relativePath, {
        representation: { type: "resize", maxWidth: 320, maxHeight: 320 },
      });

      expect(result.contentType).toBe("image/webp");
      const buffer = Buffer.from(result.data);
      const dimensions = imageSize(buffer);
      expect(buffer.byteLength).toBeGreaterThan(0);
      expect(dimensions.width).toBeLessThanOrEqual(320);
      expect(dimensions.height).toBeLessThanOrEqual(320);
    } finally {
      await indexer.stop(true);
    }
  });
});
