import { describe, expect, it, jest } from "@jest/globals";
import { Readable } from "node:stream";
import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { faceIdentifyRequestHandler } from "./faceIdentifyRequestHandler.ts";

/** An unexpected failure is logged in full but the caller only gets a generic message. */
describe("face identify 500", () => {
  it("does not return the raw error message", async () => {
    const internal = "SQLITE_CORRUPT: /srv/library/index.db near row 42";
    const database = {
      faceClusters: {
        getNamedFaceCentroids: async () => {
          throw new Error(internal);
        },
      },
    } as unknown as IndexDatabase;
    const req = Readable.from([
      Buffer.from(JSON.stringify({ imageUrl: "http://127.0.0.1:5000/frame.jpg" })),
    ]) as unknown as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>;
    Object.assign(req, {
      url: "/api/faces/identify",
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
    });
    let status: number | undefined;
    let text = "";
    const res = {
      headersSent: false,
      writableEnded: false,
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

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(Buffer.from("x"), { status: 200 }));
    try {
      await faceIdentifyRequestHandler(req, res, {
        database,
        analyzeImage: jest.fn() as never,
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(status).toBe(500);
    expect(text).not.toContain("SQLITE");
    expect(text).not.toContain("index.db");
    expect((JSON.parse(text) as { error: string }).error).toBe("Face identification failed");
  });
});
