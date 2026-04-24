import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import type http from "node:http";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import type { TaskOrchestrator } from "../../taskOrchestrator/taskOrchestrator.ts";
import { getMirroredCachedFilePath } from "../../common/cacheUtils.ts";

const baseOrchestrator: TaskOrchestrator = {
  setProcessBackgroundTasks: () => {},
  getProcessBackgroundTasks: () => true,
  getQueueSummary: () => ({
    completed: {
      image: { count: 0, sizeBytes: 0 },
      video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
    },
    active: {
      image: { count: 0, sizeBytes: 0 },
      video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
    },
    userBlocked: {
      image: { count: 0, sizeBytes: 0 },
      video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
    },
    userImplicit: {
      image: { count: 0, sizeBytes: 0 },
      video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
    },
    background: {
      image: { count: 0, sizeBytes: 0 },
      video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
    },
  }),
  addTask: () => {},
};

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
        orchestrator: baseOrchestrator,
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
        orchestrator: baseOrchestrator,
      },
    );

    await once(res, "end");

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["Content-Type"]).toBe("image/jpeg");
    expect(Buffer.concat(chunks).toString()).toBe("thumb");
  });

  it("queues HLS task and serves master playlist when GPU available but not initialized", async () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-files-hls-queue-"));
    const sourceFile = path.join(storageRoot, "clip.mp4");
    writeFileSync(sourceFile, "video");

    const hlsDir = mkdtempSync(path.join(os.tmpdir(), "photrix-hls-dir-"));
    const masterPlaylistPath = path.join(hlsDir, "master.m3u8");
    // Pre-write master.m3u8 so readFile succeeds after prepareMultibitrateHLSStructure runs
    writeFileSync(
      masterPlaylistPath,
      "#EXTM3U\n360p/playlist.m3u8\n720p/playlist.m3u8\n",
    );

    jest.unstable_mockModule("../../videoProcessing/gpuAcceleration.ts", () => ({
      getGpuAcceleration: jest.fn(async () => ({ vendor: "nvidia", label: "NVIDIA" })),
    }));

    const prepareMultibitrateHLSStructure = jest.fn(async () => {});

    jest.unstable_mockModule("../../videoProcessing/generateMultibitrateHLS.ts", () => ({
      generateMultibitrateHLS: jest.fn(),
      getMultibitrateHLSInfo: jest.fn(async () => ({
        initialized: false,
        complete: false,
        exists: false,
        hlsDir,
        masterPlaylistPath,
      })),
      getVariantPlaylistPath: jest.fn(),
      getVariantSegmentPath: jest.fn(),
      prepareMultibitrateHLSStructure,
    }));

    const { filesEndpointRequestHandler } = await import("./filesRequestHandler.ts");
    const { res, getBody } = createJsonResponse();
    const addTask = jest.fn();
    const orchestrator = { ...baseOrchestrator, addTask };

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
        orchestrator,
      },
    );

    expect(prepareMultibitrateHLSStructure).toHaveBeenCalled();
    expect(addTask).toHaveBeenCalledWith(
      { type: "hls", relativePath: "clip.mp4" },
      "blocking",
    );
    expect((res.writeHead as jest.Mock).mock.calls.at(-1)?.[0]).toBe(200);
    expect(getBody()).toContain("#EXTM3U");
  });

  it("returns 404 when multibitrate variant playlist times out", async () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-files-hls-variant-"));
    const sourceFile = path.join(storageRoot, "clip.mp4");
    writeFileSync(sourceFile, "video");

    const hlsDir = path.join(storageRoot, "cache", "hls", "abr");
    const missingVariantPlaylistPath = path.join(hlsDir, "360p", "playlist.m3u8");

    jest.unstable_mockModule("../../videoProcessing/generateMultibitrateHLS.ts", () => ({
      generateMultibitrateHLS: jest.fn(),
      getMultibitrateHLSInfo: jest.fn(async () => ({
        initialized: true,
        complete: true,
        exists: true,
        hlsDir,
        masterPlaylistPath: path.join(hlsDir, "master.m3u8"),
      })),
      getVariantPlaylistPath: jest.fn(() => missingVariantPlaylistPath),
      getVariantSegmentPath: jest.fn(),
      prepareMultibitrateHLSStructure: jest.fn(),
    }));

    jest.unstable_mockModule("../../videoProcessing/hlsSegmentWatcher.ts", () => ({
      waitForHlsFile: jest.fn(async () => false),
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
        orchestrator: baseOrchestrator,
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls.at(-1)?.[0]).toBe(404);
    expect(JSON.parse(getBody()).error).toBe(
      "HLS variant playlist not found or timed out",
    );
  });

  it("returns 422 when HLS requested without GPU and no cached HLS", async () => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-files-hls-nocuda-"));
    const sourceFile = path.join(storageRoot, "clip.mp4");
    writeFileSync(sourceFile, "video");

    jest.unstable_mockModule("../../videoProcessing/gpuAcceleration.ts", () => ({
      getGpuAcceleration: jest.fn(async () => null),
    }));

    jest.unstable_mockModule("../../videoProcessing/generateMultibitrateHLS.ts", () => ({
      generateMultibitrateHLS: jest.fn(),
      getMultibitrateHLSInfo: jest.fn(async () => ({
        initialized: false,
        complete: false,
        exists: false,
        hlsDir: "",
        masterPlaylistPath: "",
      })),
      getVariantPlaylistPath: jest.fn(),
      getVariantSegmentPath: jest.fn(),
      prepareMultibitrateHLSStructure: jest.fn(),
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
        orchestrator: baseOrchestrator,
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls.at(-1)?.[0]).toBe(422);
    expect(JSON.parse(getBody()).error).toBe("HLS not available");
  });

  it("serves no-cache master playlist while encoding is in progress", async () => {
    const storageRoot = mkdtempSync(
      path.join(os.tmpdir(), "photrix-files-hls-inprogress-"),
    );
    const sourceFile = path.join(storageRoot, "clip.mp4");
    writeFileSync(sourceFile, "video");

    const hlsDir = mkdtempSync(path.join(os.tmpdir(), "photrix-hls-inprogress-"));
    const masterPlaylistPath = path.join(hlsDir, "master.m3u8");
    writeFileSync(masterPlaylistPath, "#EXTM3U\n360p/playlist.m3u8\n");

    jest.unstable_mockModule("../../videoProcessing/generateMultibitrateHLS.ts", () => ({
      generateMultibitrateHLS: jest.fn(),
      getMultibitrateHLSInfo: jest.fn(async () => ({
        initialized: true,
        complete: false,
        exists: false,
        hlsDir,
        masterPlaylistPath,
      })),
      getVariantPlaylistPath: jest.fn(),
      getVariantSegmentPath: jest.fn(),
      prepareMultibitrateHLSStructure: jest.fn(),
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
        orchestrator: baseOrchestrator,
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls.at(-1)?.[0]).toBe(200);
    const cacheControl = (res.writeHead as jest.Mock).mock.calls.at(-1)?.[1]?.[
      "Cache-Control"
    ];
    expect(cacheControl).toBe("no-cache");
    expect(getBody()).toContain("#EXTM3U");
  });

  it("serves permanently cached master playlist when encoding is complete", async () => {
    const storageRoot = mkdtempSync(
      path.join(os.tmpdir(), "photrix-files-hls-complete-"),
    );
    const sourceFile = path.join(storageRoot, "clip.mp4");
    writeFileSync(sourceFile, "video");

    const hlsDir = mkdtempSync(path.join(os.tmpdir(), "photrix-hls-complete-"));
    const masterPlaylistPath = path.join(hlsDir, "master.m3u8");
    writeFileSync(
      masterPlaylistPath,
      "#EXTM3U\n360p/playlist.m3u8\n720p/playlist.m3u8\n",
    );

    jest.unstable_mockModule("../../videoProcessing/generateMultibitrateHLS.ts", () => ({
      generateMultibitrateHLS: jest.fn(),
      getMultibitrateHLSInfo: jest.fn(async () => ({
        initialized: true,
        complete: true,
        exists: true,
        hlsDir,
        masterPlaylistPath,
      })),
      getVariantPlaylistPath: jest.fn(),
      getVariantSegmentPath: jest.fn(),
      prepareMultibitrateHLSStructure: jest.fn(),
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
        orchestrator: baseOrchestrator,
      },
    );

    expect((res.writeHead as jest.Mock).mock.calls.at(-1)?.[0]).toBe(200);
    const cacheControl = (res.writeHead as jest.Mock).mock.calls.at(-1)?.[1]?.[
      "Cache-Control"
    ];
    expect(cacheControl).toBe("public, max-age=31536000");
    expect(getBody()).toContain("#EXTM3U");
  });
});
