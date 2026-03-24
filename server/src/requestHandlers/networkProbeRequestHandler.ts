import type http from "node:http";

const DEFAULT_PROBE_SIZE_BYTES = 1_000_000;
const MIN_PROBE_SIZE_BYTES = 64 * 1024;
const MAX_PROBE_SIZE_BYTES = 20 * 1024 * 1024;

const clampProbeSize = (requestedSize: string | null): number => {
  const parsedSize = Number.parseInt(requestedSize ?? "", 10);
  if (!Number.isFinite(parsedSize)) {
    return DEFAULT_PROBE_SIZE_BYTES;
  }

  return Math.min(MAX_PROBE_SIZE_BYTES, Math.max(MIN_PROBE_SIZE_BYTES, parsedSize));
};

export const networkProbeRequestHandler = (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const payloadSize = clampProbeSize(url.searchParams.get("bytes"));
  const payload = Buffer.alloc(payloadSize, "a");

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": payload.length,
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(payload);
};