// Test helpers for calling a request handler directly, without a server.
import type http from "node:http";
import { PassThrough, Writable } from "node:stream";

type HandlerRequest = http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>;

/**
 * A request whose body (JSON-encoded unless it is a string or a Buffer) arrives
 * once the handler starts reading.
 */
export const fakeRequest = (
  method: string,
  url: string,
  body?: unknown,
  headers: http.IncomingHttpHeaders = {},
): HandlerRequest => {
  const stream = new PassThrough();
  const payload =
    body === undefined || typeof body === "string" || Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body);
  queueMicrotask(() => stream.end(payload));
  return Object.assign(stream, {
    method,
    url,
    headers: { host: "localhost", ...headers },
  }) as unknown as HandlerRequest;
};

/** A response that records its status, headers and body, and can be piped into. */
export const recordResponse = () => {
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};
  let status: number | undefined;
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const finished = new Promise<void>((resolve) => stream.once("finish", () => resolve()));
  const res = Object.assign(stream, {
    headersSent: false,
    writeHead(code: number, values: Record<string, unknown> = {}) {
      status = code;
      for (const [name, value] of Object.entries(values)) headers[name.toLowerCase()] = value;
      res.headersSent = true;
      return res;
    },
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    flushHeaders() {},
  });
  const text = () => Buffer.concat(chunks).toString("utf-8");
  return {
    res: res as unknown as http.ServerResponse,
    status: () => status,
    header: (name: string) => headers[name.toLowerCase()],
    text,
    json: <T = Record<string, unknown>>() => JSON.parse(text()) as T,
    bytes: () => Buffer.concat(chunks),
    /** Resolves once the body has been fully written, for piped responses. */
    finished,
  };
};
