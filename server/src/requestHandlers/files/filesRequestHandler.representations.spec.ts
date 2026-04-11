import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import type http from "node:http";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import { getMirroredCachedFilePath } from "../../common/cacheUtils.ts";

const createStreamingResponse = () => {
  const res = new PassThrough() as unknown as http.ServerResponse & {
    statusCode?: number;
    headers?: Record<string, unknown>;
  };

  res.writeHead = ((statusCode: number, headers?: Record<string, unknown>) => {
    res.statusCode = statusCode;
    res.headers = headers;
    return res;
  }) as http.ServerResponse["writeHead"];

  return res;
};

const createJsonResponse = () => {
  let body = "";
  const res = {
    headersSent: false,
    writeHead: jest.fn(() => {
      (res as { headersSent: boolean }).headersSent = true;
      return res as unknown as http.ServerResponse;
    }),
    end: jest.fn((chunk?: string) => {
      if (chunk) {
        body += chunk;
      }
      return res as unknown as http.ServerResponse;
    }),
  } as unknown as http.ServerResponse;

  return { res, getBody: () => body };
};

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe("filesRequestHandler representation paths", () => {
  it("serves converted cached image for webSafe representation", async () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-files-websafe-"));
    const sourceFile = path.join(storageRoot, "photo.heic");
    const cachedFile = path.join(storageRoot, "cache", "photo.320.jpg");

    mkdirSync(path.dirname(cachedFile), { recursive: true });
    writeFileSync(sourceFile, "source");
    writeFileSync(cachedFile, "jpeg-content");

    const convertImage = jest.fn(async () => cachedFile);
    const convertImageToMultipleSizes = jest.fn(async () => undefined);

    jest.unstable_mockModule("../../imageProcessing/convertImage.ts", () => ({
      convertImage,
      convertImageToMultipleSizes,
      ImageConversionError: class ImageConversionError extends Error {},
    }));

    const { filesEndpointRequestHandler } = await import("./filesRequestHandler.ts");
    const res = createStreamingResponse();
    const chunks: Buffer[] = [];
    res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    await filesEndpointRequestHandler(
      {
        url: "/api/files/photo.heic?representation=webSafe&height=320",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {} as IndexDatabase,
        storageRoot,
      },
    );

    await once(res, "end");

    expect(convertImage).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["Content-Type"]).toBe("image/jpeg");
    expect(Buffer.concat(chunks).toString()).toBe("jpeg-content");
  });

  it("serves video thumbnail for preview representation", async () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-files-preview-"));
    const sourceFile = path.join(storageRoot, "clip.mp4");
    const cachedThumb = getMirroredCachedFilePath(sourceFile, 320, "jpg");

    mkdirSync(path.dirname(cachedThumb), { recursive: true });
    writeFileSync(sourceFile, "video");
    writeFileSync(cachedThumb, "thumb");

    const { filesEndpointRequestHandler } = await import("./filesRequestHandler.ts");
    const res = createStreamingResponse();
    const chunks: Buffer[] = [];
    res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    await filesEndpointRequestHandler(
      {
        url: "/api/files/clip.mp4?representation=preview",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {} as IndexDatabase,
        storageRoot,
      },
    );

    await once(res, "end");

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["Content-Type"]).toBe("image/jpeg");
    expect(Buffer.concat(chunks).toString()).toBe("thumb");
  });

  it("returns 500 when HLS generation throws", async () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-files-hls-"));
    const sourceFile = path.join(storageRoot, "clip.mp4");
    writeFileSync(sourceFile, "video");

    const generateHLS = jest.fn(async () => {
      throw new Error("hls boom");
    });

    jest.unstable_mockModule("../../videoProcessing/cudaAvailability.ts", () => ({
      isCudaAvailable: jest.fn(async () => true),
    }));

    jest.unstable_mockModule("../../videoProcessing/generateMultibitrateHLS.ts", () => ({
      getMultibitrateHLSInfo: jest.fn(async () => ({
        exists: false,
        hlsDir: "",
        masterPlaylistPath: "",
      })),
      getVariantPlaylistPath: jest.fn(),
      getVariantSegmentPath: jest.fn(),
    }));

    jest.unstable_mockModule("../../videoProcessing/generateHLS.ts", () => ({
      generateHLS,
      getHLSInfo: jest.fn(async () => ({
        hlsDir: path.join(storageRoot, "hls"),
        playlistPath: path.join(storageRoot, "hls", "playlist.m3u8"),
      })),
      getHLSSegmentPath: jest.fn(),
    }));

    const { filesEndpointRequestHandler } = await import("./filesRequestHandler.ts");
    const { res, getBody } = createJsonResponse();

    await filesEndpointRequestHandler(
      {
        url: "/api/files/clip.mp4?representation=hls",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {
          getFileRecord: jest.fn(async () => ({ duration: 30 })),
        } as unknown as IndexDatabase,
        storageRoot,
      },
    );

    expect(generateHLS).toHaveBeenCalled();
    expect((res.writeHead as jest.Mock).mock.calls.at(-1)?.[0]).toBe(500);
    const payload = JSON.parse(getBody());
    expect(payload.error).toBe("HLS generation failed");
  });

  it("returns 404 when multibitrate variant playlist is missing", async () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-files-hls-variant-"));
    const sourceFile = path.join(storageRoot, "clip.mp4");
    writeFileSync(sourceFile, "video");

    const hlsDir = path.join(storageRoot, "cache", "hls", "abr");
    const missingVariantPlaylistPath = path.join(hlsDir, "360p", "playlist.m3u8");

    jest.unstable_mockModule("../../videoProcessing/generateMultibitrateHLS.ts", () => ({
      getMultibitrateHLSInfo: jest.fn(async () => ({
        exists: true,
        hlsDir,
        masterPlaylistPath: path.join(hlsDir, "master.m3u8"),
      })),
      getVariantPlaylistPath: jest.fn(() => missingVariantPlaylistPath),
      getVariantSegmentPath: jest.fn(),
    }));

    jest.unstable_mockModule("../../videoProcessing/generateHLS.ts", () => ({
      generateHLS: jest.fn(),
      getHLSInfo: jest.fn(),
      getHLSSegmentPath: jest.fn(),
    }));

    const { filesEndpointRequestHandler } = await import("./filesRequestHandler.ts");
    const { res, getBody } = createJsonResponse();

    await filesEndpointRequestHandler(
      {
        url: "/api/files/clip.mp4?representation=hls&variant=360",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {
          getFileRecord: jest.fn(async () => ({ duration: 30 })),
        } as unknown as IndexDatabase,
        storageRoot,
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls.at(-1)?.[0]).toBe(404);
    const payload = JSON.parse(getBody());
    expect(payload.error).toBe("HLS variant playlist not found");
  });

  it("returns 422 when HLS requested without CUDA and no cached HLS", async () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-files-hls-nocuda-"));
    const sourceFile = path.join(storageRoot, "clip.mp4");
    writeFileSync(sourceFile, "video");

    jest.unstable_mockModule("../../videoProcessing/cudaAvailability.ts", () => ({
      isCudaAvailable: jest.fn(async () => false),
    }));

    jest.unstable_mockModule("../../videoProcessing/generateMultibitrateHLS.ts", () => ({
      getMultibitrateHLSInfo: jest.fn(async () => ({
        exists: false,
        hlsDir: "",
        masterPlaylistPath: "",
      })),
      getVariantPlaylistPath: jest.fn(),
      getVariantSegmentPath: jest.fn(),
    }));

    jest.unstable_mockModule("../../videoProcessing/generateHLS.ts", () => ({
      generateHLS: jest.fn(),
      getHLSInfo: jest.fn(async () => ({
        hlsDir: path.join(storageRoot, "hls"),
        playlistPath: path.join(storageRoot, "hls", "playlist.m3u8"),
        exists: false,
      })),
      getHLSSegmentPath: jest.fn(),
    }));

    const { filesEndpointRequestHandler } = await import("./filesRequestHandler.ts");
    const { res, getBody } = createJsonResponse();

    await filesEndpointRequestHandler(
      {
        url: "/api/files/clip.mp4?representation=hls",
        headers: { host: "localhost" },
      } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
      res,
      {
        database: {
          getFileRecord: jest.fn(async () => ({ duration: 30 })),
        } as unknown as IndexDatabase,
        storageRoot,
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls.at(-1)?.[0]).toBe(422);
    const payload = JSON.parse(getBody());
    expect(payload.error).toBe("HLS not available");
  });

});
