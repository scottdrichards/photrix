import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";

// A short search budget keeps the "slow worker" tests fast.
process.env.PHOTRIX_SEARCH_TIMEOUT_MS = "200";

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

const createJsonResponse = () => {
  let status = 0;
  let body = "";
  const res = {
    writeHead: jest.fn((code: number) => {
      status = code;
      return res as unknown as http.ServerResponse;
    }),
    end: jest.fn((chunk?: string) => {
      if (chunk) body += chunk;
      return res as unknown as http.ServerResponse;
    }),
  } as unknown as http.ServerResponse;
  return { res, getStatus: () => status, getJson: () => JSON.parse(body) };
};

const makeReq = (q: string) =>
  ({ url: `/api/search?q=${encodeURIComponent(q)}`, headers: { host: "localhost" } }) as unknown as
    http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>;

const transcriptRow = {
  folder: "/trip/",
  fileName: "clip.mp4",
  mimeType: "video/mp4",
  similarity: 0.6,
};

const loadHandler = async (mocks: {
  embedText?: () => Promise<Float32Array>;
  embedTextWithClap?: () => Promise<Float32Array>;
}) => {
  jest.unstable_mockModule("../imageAnalysis/imageAnalysisWorker.ts", () => ({
    embedText: mocks.embedText ?? (async () => new Float32Array([1])),
  }));
  jest.unstable_mockModule("../audioProcessing/clapWorker.ts", () => ({
    embedTextWithClap: mocks.embedTextWithClap ?? (async () => new Float32Array([1])),
  }));
  const { searchRequestHandler } = await import("./searchRequestHandler.ts");
  return searchRequestHandler;
};

describe("searchRequestHandler resilience", () => {
  it("returns transcript results promptly when the image-embed worker hangs", async () => {
    const handler = await loadHandler({
      // Never resolves — simulates a wedged/CPU-starved CLIP worker.
      embedText: () => new Promise<Float32Array>(() => {}),
      embedTextWithClap: () => new Promise<Float32Array>(() => {}),
    });

    const database = {
      semanticSearch: jest.fn(async () => []),
      audioSemanticSearch: jest.fn(async () => []),
      audioTranscriptSearch: jest.fn(async () => [transcriptRow]),
    } as unknown as IndexDatabase;

    const { res, getStatus, getJson } = createJsonResponse();
    const start = Date.now();
    await handler(makeReq("disney"), res, { database });

    expect(Date.now() - start).toBeLessThan(2_000);
    expect(getStatus()).toBe(200);
    const body = getJson();
    expect(body.total).toBe(1);
    expect(body.items[0].fileName).toBe("clip.mp4");
  });

  it("returns 200 with partial results when both embed workers fail but transcript matches", async () => {
    const handler = await loadHandler({
      embedText: async () => {
        throw new Error("clip down");
      },
      embedTextWithClap: async () => {
        throw new Error("clap down");
      },
    });

    const database = {
      semanticSearch: jest.fn(async () => []),
      audioSemanticSearch: jest.fn(async () => []),
      audioTranscriptSearch: jest.fn(async () => [transcriptRow]),
    } as unknown as IndexDatabase;

    const { res, getStatus, getJson } = createJsonResponse();
    await handler(makeReq("disney"), res, { database });

    expect(getStatus()).toBe(200);
    expect(getJson().total).toBe(1);
  });

  it("returns 503 only when both embed workers fail and there are no results at all", async () => {
    const handler = await loadHandler({
      embedText: async () => {
        throw new Error("clip down");
      },
      embedTextWithClap: async () => {
        throw new Error("clap down");
      },
    });

    const database = {
      semanticSearch: jest.fn(async () => []),
      audioSemanticSearch: jest.fn(async () => []),
      audioTranscriptSearch: jest.fn(async () => []),
    } as unknown as IndexDatabase;

    const { res, getStatus, getJson } = createJsonResponse();
    await handler(makeReq("disney"), res, { database });

    expect(getStatus()).toBe(503);
    expect(getJson().error).toBe("Search workers unavailable");
  });
});
