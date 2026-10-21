import type http from "node:http";

/** Generous for any JSON this API accepts; endpoints with tiny payloads pass less. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Reads a request body as UTF-8 text, refusing anything over `maxBytes`.
 *
 * Chunks are concatenated as bytes and decoded once at the end: decoding each
 * chunk separately (`body += chunk.toString()`) corrupts any multi-byte
 * character — an accented name, an emoji — that straddles a chunk boundary.
 * On overflow the request is destroyed so the client stops uploading.
 */
export const readTextBody = (
  req: http.IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });

type ReadJsonOptions = {
  maxBytes?: number;
  /** Returned for an empty (or whitespace-only) body. Without it, an empty body is an error. */
  ifEmpty?: unknown;
};

/**
 * Reads and parses a JSON request body. Rejects with `BodyTooLargeError`, or a
 * plain `Error` for an empty body (unless `ifEmpty` is given) or invalid JSON.
 */
export const readJsonBody = async <T = unknown>(
  req: http.IncomingMessage,
  { maxBytes, ifEmpty }: ReadJsonOptions = {},
): Promise<T> => {
  const text = (await readTextBody(req, maxBytes)).trim();
  if (!text) {
    if (ifEmpty !== undefined) return ifEmpty as T;
    throw new Error("Request body is required");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Invalid JSON");
  }
};
