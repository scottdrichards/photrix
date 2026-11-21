import { describe, expect, it } from "@jest/globals";
import type http from "node:http";
import { networkProbeRequestHandler } from "./networkProbeRequestHandler.ts";

const run = (url: string, host: string | undefined, options?: { shareLink?: boolean }) => {
  let length = 0;
  const res = {
    writeHead: () => res,
    end: (payload: Buffer) => {
      length = payload.length;
    },
  } as unknown as http.ServerResponse;
  const req = { url, headers: { host } } as unknown as http.IncomingMessage & {
    url: string;
  };
  networkProbeRequestHandler(req, res, options);
  return length;
};

describe("networkProbeRequestHandler", () => {
  it("does not throw on a malformed Host header", () => {
    expect(() => run("/api/network-probe?bytes=65536", "bad host/::", undefined)).not.toThrow();
    expect(run("/api/network-probe?bytes=65536", "[", undefined)).toBe(64 * 1024);
  });

  it("caps share-link callers at 2 MB and others at 20 MB", () => {
    expect(run("/api/network-probe?bytes=99999999", "x", { shareLink: true })).toBe(2 * 1024 * 1024);
    expect(run("/api/network-probe?bytes=99999999", "x")).toBe(20 * 1024 * 1024);
  });
});
