import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Readable } from "node:stream";
import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { faceIdentifyRequestHandler } from "./faceIdentifyRequestHandler.ts";

/**
 * The identify endpoint fetches frames from URLs the caller names, so it pins
 * them to private addresses. These check that the pin holds for the host the
 * request really goes to, and that a redirect can't carry it elsewhere.
 */

const realFetch = globalThis.fetch;
const fetchMock = jest.fn(async () => new Response("not found", { status: 404 }));

beforeEach(() => {
  fetchMock.mockClear();
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const database = {
  faceClusters: { getNamedFaceCentroids: async () => [] },
} as unknown as IndexDatabase;

const identify = async (body: unknown) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage &
    Required<Pick<http.IncomingMessage, "url">>;
  Object.assign(req, {
    url: "/api/faces/identify",
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
  });
  let status: number | undefined;
  let text = "";
  const res = {
    headersSent: false,
    setHeader: () => res,
    writeHead: (code: number) => {
      status = code;
      return res;
    },
    end: (chunk?: string) => {
      if (chunk) text += chunk;
      return res;
    },
  } as unknown as http.ServerResponse;
  await faceIdentifyRequestHandler(req, res, {
    database,
    analyzeImage: jest.fn() as never,
  });
  return { status, body: text ? (JSON.parse(text) as { error?: string }) : {} };
};

describe("face identify frame URLs", () => {
  it.each([
    "127.0.0.1:80@example.com",
    "127.0.0.1:5000@example.com",
    "example.com",
    "127.0.0.1.example.com",
  ])("refuses frigateEvent host %j without fetching", async (host) => {
    const result = await identify({ frigateEvent: { host, id: "abc" } });
    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a private frigateEvent host, without following redirects", async () => {
    const result = await identify({ frigateEvent: { host: "127.0.0.1:5000", id: "abc" } });
    expect(result.status).toBe(400); // the mock answers 404
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(new URL(String(url)).hostname).toBe("127.0.0.1");
    expect(init.redirect).toBe("manual");
  });

  it.each(["http://example.com/frame.jpg", "http://127.0.0.1@example.com/frame.jpg", "file:///etc/hostname"])(
    "refuses imageUrl %j without fetching",
    async (imageUrl) => {
      const result = await identify({ imageUrl });
      expect(result.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("does not follow a redirect from a private imageUrl", async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://example.com/" } }),
    );
    const result = await identify({ imageUrl: "http://127.0.0.1:5000/frame.jpg" });
    expect(result.status).toBe(400);
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.redirect).toBe("manual");
  });
});
