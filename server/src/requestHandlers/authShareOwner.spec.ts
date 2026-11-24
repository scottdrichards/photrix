import { describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { overrideConfig } from "../config/config.fixture.ts";

// Own file: the module mock below must not leak into other handler specs.
describe("authShareTokenHandler owner guard", () => {
  it("refuses to mint when the credential has no resolvable owner", async () => {
    overrideConfig({
      PHOTRIX_SHARE_TOKEN_SECRET: "test-share-secret-of-at-least-32-chars",
    });
    const authService = await import("../auth/authService.ts");
    jest.unstable_mockModule("../auth/authService.ts", () => ({
      ...authService,
      validateToken: () => true,
      getTokenOwner: () => null,
    }));
    const { authShareTokenHandler } = await import("./authRequestHandler.ts");

    let status = 0;
    const res = {
      writeHead: (code: number) => {
        status = code;
        return res;
      },
      end: () => res,
    } as unknown as http.ServerResponse;
    const req = new EventEmitter() as http.IncomingMessage & EventEmitter;
    req.url = "/api/auth/share-token";
    req.headers = { host: "localhost", authorization: "Bearer orphan" };
    queueMicrotask(() => {
      req.emit("data", Buffer.from(JSON.stringify({ filter: { rating: { min: 4 } } })));
      req.emit("end");
    });

    await authShareTokenHandler(req, res, {} as never);

    expect(status).toBe(403);
    overrideConfig({ PHOTRIX_SHARE_TOKEN_SECRET: undefined });
  });
});
