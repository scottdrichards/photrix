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

const makeReq = (q: string, limit?: number) =>
  ({
    url: `/api/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`,
    headers: { host: "localhost" },
  }) as unknown as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>;

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

  it("keeps a top image hit in the top-N even when transcript matches flood the results", async () => {
    // Transcript matches all carry a flat 0.6 while image cosine is ~0.2, so a
    // raw-magnitude merge would fill every top slot with transcript hits and
    // truncate the image match out. Rank fusion must keep the image hit visible.
    const handler = await loadHandler({
      embedTextWithClap: async () => {
        throw new Error("clap down");
      },
    });

    const imageHit = { folder: "/photos/", fileName: "castle.jpg", mimeType: "image/jpeg", similarity: 0.2 };
    const transcriptHits = Array.from({ length: 5 }, (_, i) => ({
      folder: "/trip/",
      fileName: `clip${i}.mp4`,
      mimeType: "video/mp4",
      similarity: 0.6,
    }));

    const database = {
      semanticSearch: jest.fn(async () => [imageHit]),
      audioSemanticSearch: jest.fn(async () => []),
      audioTranscriptSearch: jest.fn(async () => transcriptHits),
    } as unknown as IndexDatabase;

    const { res, getStatus, getJson } = createJsonResponse();
    await handler(makeReq("castle", 2), res, { database });

    expect(getStatus()).toBe(200);
    const fileNames = getJson().items.map((it: { fileName: string }) => it.fileName);
    expect(fileNames).toContain("castle.jpg");
  });

  it("boosts a file matched by multiple sources above single-source hits", async () => {
    const handler = await loadHandler({});

    const shared = { folder: "/a/", fileName: "shared.mp4", mimeType: "video/mp4", similarity: 0.2 };
    const imageOnly = { folder: "/a/", fileName: "image-only.jpg", mimeType: "image/jpeg", similarity: 0.9 };

    const database = {
      semanticSearch: jest.fn(async () => [imageOnly, shared]),
      audioSemanticSearch: jest.fn(async () => []),
      audioTranscriptSearch: jest.fn(async () => [shared]),
    } as unknown as IndexDatabase;

    const { res, getStatus, getJson } = createJsonResponse();
    await handler(makeReq("shared"), res, { database });

    expect(getStatus()).toBe(200);
    // shared is rank-2 in image but appears in two sources, so its fused score
    // (1/62 + 1/61) beats image-only's single rank-1 contribution (1/61).
    expect(getJson().items[0].fileName).toBe("shared.mp4");
  });

  it("tags each result with the modalities that matched it", async () => {
    const handler = await loadHandler({});

    const shared = { folder: "/a/", fileName: "shared.mp4", mimeType: "video/mp4", similarity: 0.2 };
    const imageOnly = { folder: "/a/", fileName: "image-only.jpg", mimeType: "image/jpeg", similarity: 0.9 };

    const database = {
      semanticSearch: jest.fn(async () => [imageOnly, shared]),
      audioSemanticSearch: jest.fn(async () => []),
      audioTranscriptSearch: jest.fn(async () => [shared]),
    } as unknown as IndexDatabase;

    const { res, getStatus, getJson } = createJsonResponse();
    await handler(makeReq("shared"), res, { database });

    expect(getStatus()).toBe(200);
    const bySource = Object.fromEntries(
      getJson().items.map((it: { fileName: string; sources: string[] }) => [it.fileName, it.sources]),
    );
    expect(bySource["shared.mp4"]).toEqual(["image", "transcript"]);
    expect(bySource["image-only.jpg"]).toEqual(["image"]);
  });

  it("runs only the sources named in the `sources` param and skips the rest", async () => {
    const handler = await loadHandler({});

    const transcriptHit = { folder: "/a/", fileName: "spoken.mp4", mimeType: "video/mp4", similarity: 0.6 };
    const semanticSearch = jest.fn(async () => []);
    const audioSemanticSearch = jest.fn(async () => []);
    const database = {
      semanticSearch,
      audioSemanticSearch,
      audioTranscriptSearch: jest.fn(async () => [transcriptHit]),
    } as unknown as IndexDatabase;

    const req = {
      url: `/api/search?q=${encodeURIComponent("hello")}&sources=transcript&debug=1`,
      headers: { host: "localhost" },
    } as unknown as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>;

    const { res, getStatus, getJson } = createJsonResponse();
    await handler(req, res, { database });

    expect(getStatus()).toBe(200);
    // The disabled embedding searches must not even touch their (slow) workers.
    expect(semanticSearch).not.toHaveBeenCalled();
    expect(audioSemanticSearch).not.toHaveBeenCalled();
    const json = getJson();
    expect(json.items.map((it: { fileName: string }) => it.fileName)).toEqual(["spoken.mp4"]);
    expect(json._diagnostics.clip).toEqual({ status: "skipped" });
    expect(json._diagnostics.clap).toEqual({ status: "skipped" });
  });

  it("drops low-confidence CLAP audio hits below the relevance floor but keeps confident ones", async () => {
    const handler = await loadHandler({});

    // CLAP cosine sits on a higher scale than CLIP and is not relevance-calibrated
    // across queries, so noise can score ~0.4. Only confident audio (>= floor)
    // should reach the results; a sub-floor "match" is dropped before fusion.
    const noiseVideo = { folder: "/a/", fileName: "noise.mp4", mimeType: "video/mp4", similarity: 0.41 };
    const confidentVideo = { folder: "/a/", fileName: "music.mp4", mimeType: "video/mp4", similarity: 0.52 };

    const database = {
      semanticSearch: jest.fn(async () => []),
      audioSemanticSearch: jest.fn(async () => [confidentVideo, noiseVideo]),
      audioTranscriptSearch: jest.fn(async () => []),
    } as unknown as IndexDatabase;

    const { res, getStatus, getJson } = createJsonResponse();
    await handler(makeReq("music"), res, { database });

    expect(getStatus()).toBe(200);
    const names = getJson().items.map((i: { fileName: string }) => i.fileName);
    expect(names).toContain("music.mp4");
    expect(names).not.toContain("noise.mp4");
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
