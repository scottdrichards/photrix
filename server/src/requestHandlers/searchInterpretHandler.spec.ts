import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type { SearchInterpretation } from "../../../shared/filter-contract/src/index.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";

// A configured-but-stubbed Ollama: the handler's "no model configured"
// short-circuit keys off this export.
jest.unstable_mockModule("../shareDescription/ollamaGenerate.ts", () => ({
  getOllamaUrl: () => "http://ollama.test:11434",
  ollamaGenerate: jest.fn(),
}));

const interpretSearchQuery = jest.fn<() => Promise<SearchInterpretation>>();
jest.unstable_mockModule("../naturalLanguageSearch/interpretSearchQuery.ts", () => ({
  interpretSearchQuery,
}));

const loadSearchVocabulary = jest.fn(() =>
  Promise.resolve({ people: [], folders: [] }),
);
jest.unstable_mockModule("../naturalLanguageSearch/searchVocabulary.ts", () => ({
  loadSearchVocabulary,
}));

const { searchInterpretHandler, clearSearchInterpretationCache } = await import(
  "./searchInterpretHandler.ts"
);

const database = {} as IndexDatabase;

const post = async (body: string) => {
  const req = new EventEmitter() as http.IncomingMessage & EventEmitter;
  req.url = "/api/search/interpret";
  req.method = "POST";
  req.headers = { host: "photos.example.com" };
  (req as unknown as { destroy: () => void }).destroy = () => {};

  let status = 0;
  let payload = "";
  const res = {
    writeHead: jest.fn((code: number) => {
      status = code;
      return res as unknown as http.ServerResponse;
    }),
    end: jest.fn((chunk?: string) => {
      if (chunk) payload += chunk;
      return res as unknown as http.ServerResponse;
    }),
  } as unknown as http.ServerResponse;

  const pending = searchInterpretHandler(req, res, { database });
  req.emit("data", Buffer.from(body));
  req.emit("end");
  await pending;

  return { status, body: payload ? (JSON.parse(payload) as SearchInterpretation) : null };
};

const interpretation: SearchInterpretation = {
  interpreted: true,
  query: "photos of Sarah",
  filter: { faceClusterFilter: ["person-12"] },
  chips: [{ field: "faceClusterFilter", label: "Sarah", value: "person-12" }],
  ignored: [],
};

describe("searchInterpretHandler", () => {
  beforeEach(() => {
    clearSearchInterpretationCache();
    interpretSearchQuery.mockReset();
    interpretSearchQuery.mockResolvedValue(interpretation);
  });

  it("returns the interpretation for a query", async () => {
    const { status, body } = await post(JSON.stringify({ q: "photos of Sarah" }));
    expect(status).toBe(200);
    expect(body).toEqual(interpretation);
  });

  it("serves an identical query from cache instead of re-running the model", async () => {
    await post(JSON.stringify({ q: "photos of Sarah" }));
    await post(JSON.stringify({ q: "  Photos of Sarah  " }));
    expect(interpretSearchQuery).toHaveBeenCalledTimes(1);
  });

  it("runs the model again for a different query", async () => {
    await post(JSON.stringify({ q: "photos of Sarah" }));
    await post(JSON.stringify({ q: "photos of Ben" }));
    expect(interpretSearchQuery).toHaveBeenCalledTimes(2);
  });

  it("answers 200 with no interpretation when the translation throws", async () => {
    interpretSearchQuery.mockRejectedValue(new Error("model exploded"));
    const { status, body } = await post(JSON.stringify({ q: "photos of Sarah" }));
    expect(status).toBe(200);
    expect(body).toEqual({ interpreted: false, reason: "error" });
  });

  it("does not cache a failed interpretation", async () => {
    interpretSearchQuery.mockRejectedValueOnce(new Error("model exploded"));
    await post(JSON.stringify({ q: "photos of Sarah" }));
    const { body } = await post(JSON.stringify({ q: "photos of Sarah" }));
    expect(body).toEqual(interpretation);
  });

  it("rejects a body that is not JSON", async () => {
    const { status } = await post("not json");
    expect(status).toBe(400);
  });

  it("short-circuits an empty query without touching the model", async () => {
    const { status, body } = await post(JSON.stringify({ q: "   " }));
    expect(status).toBe(200);
    expect(body).toEqual({ interpreted: false, reason: "empty-query" });
    expect(interpretSearchQuery).not.toHaveBeenCalled();
  });
});
