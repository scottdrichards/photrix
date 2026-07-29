import { describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";

jest.unstable_mockModule("../auth/authService.ts", () => ({
  getShareScope: () => ({ filter: {}, description: "Trip Favorites" }),
  getShareLinkLabel: () => Promise.resolve(null),
}));

const { sharePreviewHandler } = await import("./sharePreviewHandler.ts");

describe("sharePreviewHandler redirect", () => {
  it("uses a relative app URL so mounted deployments keep their base path", async () => {
    const req = new EventEmitter() as http.IncomingMessage & EventEmitter;
    req.url = "/share?token=t";
    req.headers = { host: "photos.example.com" };

    let body = "";
    const res = {
      writeHead: jest.fn(() => res as unknown as http.ServerResponse),
      end: jest.fn((chunk?: string) => {
        if (chunk) body += chunk;
        return res as unknown as http.ServerResponse;
      }),
    } as unknown as http.ServerResponse;

    const database = {
      queryFiles: jest.fn(() => Promise.resolve({ items: [], total: 0 })),
      countNamedPeopleForFiles: jest.fn(() => Promise.resolve(new Map())),
    } as unknown as IndexDatabase;

    await sharePreviewHandler(req, res, database);

    expect(body).toContain('href="./?token=t"');
    expect(body).toContain('window.location.replace("./?token=t")');
  });
});
