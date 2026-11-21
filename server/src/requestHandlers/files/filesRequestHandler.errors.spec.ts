import { describe, expect, it, jest } from "@jest/globals";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import type { TaskOrchestrator } from "../../taskOrchestrator/taskOrchestrator.ts";

// The share-video export pulls in the HLS module; this file never reaches it.
jest.unstable_mockModule("../../videoProcessing/exportShareVideo.ts", () => ({
  exportShareVideo: jest.fn(),
  parseShareVideoShortSide: () => 1080,
}));

class ImageConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageConversionError";
  }
}
const internal = "sharp: unsupported image format at /srv/library/photo.heic";
jest.unstable_mockModule("../../imageProcessing/convertImage.ts", () => ({
  convertImage: jest.fn(async () => {
    throw new ImageConversionError(internal);
  }),
  convertImageCrop: jest.fn(),
  convertImageToMultipleSizes: jest.fn(),
  convertEmbeddedThumbnail: jest.fn(async () => null),
  contentTypeForImageFormat: () => "image/webp",
  IMAGE_OUTPUT_CONTENT_TYPE: "image/webp",
  IMAGE_OUTPUT_EXTENSION: "webp",
  MICRO_THUMBNAIL_HEIGHT: 160,
  ImageConversionError,
}));

const orchestrator = {
  noteUserActivity: () => {},
  beginUserRequest: () => ({ release: () => {}, refresh: () => {} }),
} as unknown as TaskOrchestrator;

describe("files endpoint: undecodable image", () => {
  it("answers 422 without the converter's message", async () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-files-422-"));
    writeFileSync(path.join(storageRoot, "photo.heic"), "not an image");
    const { filesEndpointRequestHandler } = await import("./filesRequestHandler.ts");

    let status = 0;
    let body = "";
    const res = {
      headersSent: false,
      writeHead: (code: number) => {
        status = code;
        return res;
      },
      end: (chunk?: string) => {
        if (chunk) body += chunk;
        return res;
      },
    } as unknown as http.ServerResponse;

    await filesEndpointRequestHandler(
      {
        url: "/api/files/photo.heic?representation=webSafe&height=320",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      { database: {} as IndexDatabase, storageRoot, taskOrchestrator: orchestrator },
    );

    expect(status).toBe(422);
    expect(JSON.parse(body)).toMatchObject({ error: "Invalid image" });
    expect(body).not.toContain("sharp");
    expect(body).not.toContain("/srv/library");
  });
});
