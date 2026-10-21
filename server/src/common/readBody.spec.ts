import { PassThrough } from "node:stream";
import type http from "node:http";
import { BodyTooLargeError, readJsonBody, readTextBody } from "./readBody.ts";

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
