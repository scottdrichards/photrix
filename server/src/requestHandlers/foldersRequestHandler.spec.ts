import { describe, expect, it, jest } from "@jest/globals";
import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";
import { foldersRequestHandler } from "./foldersRequestHandler.ts";
import { extractShareFolderRoots } from "../auth/shareFolderScope.ts";

/**
 * Feedback #32: a share link should be able to browse into subfolders of what was
 * shared, but never up and out of it. Folder browsing used to be refused outright
 * for any share link, so none of it worked.
 */

const createMockResponse = () => {
  let body = "";
  const res = {
    writeHead: jest.fn(() => res as unknown as http.ServerResponse),
    end: jest.fn((chunk?: string) => {
      if (chunk) body += chunk;
      return res as unknown as http.ServerResponse;
    }),
  } as unknown as http.ServerResponse;
  return {
    res,
    getBody: () => body,
    status: () => (res.writeHead as jest.Mock).mock.calls[0]?.[0] as number | undefined,
  };
};

const shareFilter = {
  folder: { folder: "/Sarah Pictures/2009", recursive: true },
} as unknown as FilterElement;

const shareFolderRoots = extractShareFolderRoots(shareFilter);

const callFolders = async (
  requestPath: string,
  options: { shareFilter?: unknown; query?: string } = {},
) => {
  const getFolders =
    jest.fn<(p: string, f: FilterElement) => Promise<Array<{ name: string; count: number }>>>();
  getFolders.mockResolvedValue([{ name: "11", count: 4 }]);
  const { res, status, getBody } = createMockResponse();

  await foldersRequestHandler(
    {
      url: `/api/folders/${requestPath}${options.query ?? ""}`,
      headers: { host: "localhost" },
    } as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
    res,
    {
      database: { getFolders } as unknown as IndexDatabase,
      ...("shareFilter" in options
        ? { shareFilter: options.shareFilter, shareFolderRoots }
        : {}),
    },
  );

  return { status: status(), body: getBody(), getFolders };
};

describe("foldersRequestHandler under a share link", () => {
  it("lists the shared root", async () => {
    const { status, getFolders } = await callFolders("Sarah Pictures/2009", {
      shareFilter,
    });
    expect(status).toBe(200);
    expect(getFolders).toHaveBeenCalledWith("/Sarah Pictures/2009/", shareFilter);
  });

  it("lists a subfolder of the share", async () => {
    const { status } = await callFolders("Sarah Pictures/2009/11", { shareFilter });
    expect(status).toBe(200);
  });

  it("lists an ancestor so the viewer can navigate down, still share-filtered", async () => {
    const { status, getFolders } = await callFolders("", { shareFilter });
    expect(status).toBe(200);
    // The share filter is applied, so only folders holding shared items come back.
    expect(getFolders).toHaveBeenCalledWith("/", shareFilter);
  });

  it("refuses a sibling folder outside the share", async () => {
    const { status, body, getFolders } = await callFolders("Sarah Pictures/2010", {
      shareFilter,
    });
    expect(status).toBe(403);
    expect(JSON.parse(body)).toEqual({ error: "Forbidden" });
    expect(getFolders).not.toHaveBeenCalled();
  });

  it("refuses an unrelated top-level folder", async () => {
    const { status, getFolders } = await callFolders("Private", { shareFilter });
    expect(status).toBe(403);
    expect(getFolders).not.toHaveBeenCalled();
  });

  it("refuses a traversal attempt that escapes the shared root", async () => {
    const { status } = await callFolders("Sarah%20Pictures/2009/../../Private", {
      shareFilter,
    });
    expect(status).toBe(403);
  });

  it("refuses percent-encoded dot segments, which survive URL parsing", async () => {
    // %2E%2E only becomes ".." after decoding, so a naive prefix check would read
    // this as being inside "/Sarah Pictures/2009/".
    const { status, getFolders } = await callFolders(
      "Sarah%20Pictures/2009/%2E%2E/%2E%2E/Private",
      { shareFilter },
    );
    expect(status).toBe(403);
    expect(getFolders).not.toHaveBeenCalled();
  });

  it("queries the canonical path, never one containing dot segments", async () => {
    const { getFolders } = await callFolders("Sarah%20Pictures/2009/11/%2E%2E", {
      shareFilter,
    });
    expect(getFolders).toHaveBeenCalledWith("/Sarah Pictures/2009/", shareFilter);
  });

  it("ANDs the share filter with a caller-supplied filter", async () => {
    const requestFilter = { rating: 5 };
    const { getFolders } = await callFolders("Sarah Pictures/2009", {
      shareFilter,
      query: `?filter=${encodeURIComponent(JSON.stringify(requestFilter))}`,
    });
    expect(getFolders).toHaveBeenCalledWith("/Sarah Pictures/2009/", {
      operation: "and",
      conditions: [requestFilter, shareFilter],
    });
  });
});

describe("foldersRequestHandler without a share link", () => {
  it("browses the whole library unfiltered, as before", async () => {
    const { status, getFolders } = await callFolders("Private");
    expect(status).toBe(200);
    expect(getFolders).toHaveBeenCalledWith("/Private/", {});
  });
});
