import type http from "node:http";

const DEFAULT_PROBE_SIZE_BYTES = 1_000_000;
const MIN_PROBE_SIZE_BYTES = 64 * 1024;
const MAX_PROBE_SIZE_BYTES = 20 * 1024 * 1024;

// Share-link holders get a much smaller ceiling so an anonymous caller cannot
// pull 20 MB per request.
const MAX_SHARE_PROBE_SIZE_BYTES = 2 * 1024 * 1024;

const clampProbeSize = (
  requestedSize: string | null,
  maxBytes: number,
): number => {
  const parsedSize = Number.parseInt(requestedSize ?? "", 10);
  if (!Number.isFinite(parsedSize)) {
    return Math.min(DEFAULT_PROBE_SIZE_BYTES, maxBytes);
  }

  return Math.min(maxBytes, Math.max(MIN_PROBE_SIZE_BYTES, parsedSize));
};

export const networkProbeRequestHandler = (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  options: { shareLink?: boolean } = {},
) => {
  // Fixed base: the Host header is client-controlled and can make URL parsing throw.
  const url = new URL(req.url, "http://localhost");
  const payloadSize = clampProbeSize(
    url.searchParams.get("bytes"),
    options.shareLink ? MAX_SHARE_PROBE_SIZE_BYTES : MAX_PROBE_SIZE_BYTES,
  );
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
