import { PassThrough } from "node:stream";
import type http from "node:http";
import { BodyTooLargeError, readJsonBody, readJsonRequest, readTextBody } from "./readBody.ts";

const requestFrom = (chunks: Buffer[]): http.IncomingMessage => {
  const stream = new PassThrough();
  queueMicrotask(() => {
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
  return stream as unknown as http.IncomingMessage;
};

describe("readTextBody", () => {
  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = Buffer.from('{"name":"José"}', "utf-8");
    const split = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    const text = await readTextBody(requestFrom([bytes.subarray(0, split), bytes.subarray(split)]));
    expect(text).toBe('{"name":"José"}');
  });

  it("rejects a body over the limit", async () => {
    await expect(readTextBody(requestFrom([Buffer.alloc(10), Buffer.alloc(10)]), 15)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });
});

describe("readJsonBody", () => {
  it("parses JSON", async () => {
    await expect(readJsonBody(requestFrom([Buffer.from('{"a":1}')]))).resolves.toEqual({ a: 1 });
  });

  it("returns ifEmpty for an empty body, and errors without it", async () => {
    await expect(readJsonBody(requestFrom([]), { ifEmpty: {} })).resolves.toEqual({});
    await expect(readJsonBody(requestFrom([]))).rejects.toThrow("Request body is required");
  });

  it("rejects invalid JSON", async () => {
    await expect(readJsonBody(requestFrom([Buffer.from("{nope")]))).rejects.toThrow("Invalid JSON");
  });
});

describe("readJsonRequest", () => {
  const responseRecorder = () => {
    const recorded: { status?: number; body?: unknown } = {};
    const res = {
      writeHead: (status: number) => {
        recorded.status = status;
        return res;
      },
      setHeader: () => res,
      end: (text: string) => {
        recorded.body = JSON.parse(text);
      },
    } as unknown as http.ServerResponse;
    return { res, recorded };
  };

  it("returns the parsed body and leaves the response alone", async () => {
    const { res, recorded } = responseRecorder();
    await expect(readJsonRequest(requestFrom([Buffer.from('{"a":1}')]), res)).resolves.toEqual({ a: 1 });
    expect(recorded.status).toBeUndefined();
  });

  it("answers 400 with the reason for a body that isn't JSON", async () => {
    const { res, recorded } = responseRecorder();
    await expect(readJsonRequest(requestFrom([Buffer.from("{nope")]), res)).resolves.toBeNull();
    expect(recorded).toEqual({ status: 400, body: { error: "Invalid JSON" } });
  });

  it("answers 413, not 400, for a body over the limit", async () => {
    const { res, recorded } = responseRecorder();
    const request = requestFrom([Buffer.alloc(10), Buffer.alloc(10)]);
    await expect(readJsonRequest(request, res, { maxBytes: 15 })).resolves.toBeNull();
    expect(recorded.status).toBe(413);
  });
});
