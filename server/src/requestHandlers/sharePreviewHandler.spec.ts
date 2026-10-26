import { describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";

const tripScope = {
  filter: { folder: { folder: "/trip/", recursive: true } },
  description: "Trip Favorites",
};
let currentScope: Record<string, unknown> = tripScope;

jest.unstable_mockModule("../auth/authService.ts", () => ({
  getShareScope: () => currentScope,
  getShareLinkLabel: () => Promise.resolve(null),
}));

const { sharePreviewHandler } = await import("./sharePreviewHandler.ts");

type PreviewFile = {
  folder: string;
  fileName: string;
  mimeType: string | null;
  rating?: number;
};

const renderPreviewPage = async (
  files: PreviewFile[],
  namedPeople: Record<string, number>,
) => {
  const req = new EventEmitter() as http.IncomingMessage & EventEmitter;
  req.url = "/share?token=t";
  req.headers = { host: "photos.example.com" };

  let body = "";
  const res = {
    writeHead: jest.fn(() => res),
    end: jest.fn((chunk?: string) => {
      if (chunk) body += chunk;
      return res;
    }),
  } as unknown as http.ServerResponse;

  const database = {
    queryFiles: jest.fn(() => Promise.resolve({ items: files, total: files.length })),
    countNamedPeopleForFiles: jest.fn(() => Promise.resolve(new Map(Object.entries(namedPeople)))),
  } as unknown as IndexDatabase;

  await sharePreviewHandler(req, res, database);
  return { body, database };
};

const renderPreview = async (files: PreviewFile[], namedPeople: Record<string, number>) => {
  const { body } = await renderPreviewPage(files, namedPeople);
  // The mosaic <img> order is the ranking; og:image tags follow the same order.
  return [...body.matchAll(/<img src="[^"]*\/api\/files\/([^?"]+)\?/g)].map(([, path]) =>
    decodeURIComponent(path),
  );
};

const photo = (fileName: string, rating?: number): PreviewFile => ({
  folder: "/trip/",
  fileName,
  mimeType: "image/jpeg",
  ...(rating === undefined ? {} : { rating }),
});

describe("sharePreviewHandler preview ranking", () => {
  it("leads with the highest-rated photo", async () => {
    const order = await renderPreview(
      [photo("low.jpg", 2), photo("best.jpg", 5), photo("mid.jpg", 4)],
      {},
    );
    expect(order[0]).toBe("trip/best.jpg");
  });

  it("breaks rating ties by the number of named people", async () => {
    const order = await renderPreview(
      [photo("solo.jpg", 5), photo("group.jpg", 5), photo("pair.jpg", 5)],
      { "/trip/group.jpg": 4, "/trip/pair.jpg": 2, "/trip/solo.jpg": 1 },
    );
    expect(order).toEqual(["trip/group.jpg", "trip/pair.jpg", "trip/solo.jpg"]);
  });

  it("ranks a rated landscape above an unrated group shot", async () => {
    const order = await renderPreview([photo("crowd.jpg"), photo("vista.jpg", 3)], {
      "/trip/crowd.jpg": 6,
    });
    expect(order[0]).toBe("trip/vista.jpg");
  });

  it("excludes videos from the mosaic and caps it at four images", async () => {
    const order = await renderPreview(
      [
        { folder: "/trip/", fileName: "clip.mov", mimeType: "video/quicktime", rating: 5 },
        { folder: "/trip/", fileName: "reel.mp4", mimeType: null, rating: 5 },
        photo("a.jpg", 5),
        photo("b.jpg", 4),
        photo("c.jpg", 3),
        photo("d.jpg", 2),
        photo("e.jpg", 1),
      ],
      {},
    );
    expect(order).toEqual(["trip/a.jpg", "trip/b.jpg", "trip/c.jpg", "trip/d.jpg"]);
  });
});

describe("sharePreviewHandler scope", () => {
  it("queries with the share's own filter", async () => {
    currentScope = tripScope;
    const { database } = await renderPreviewPage([photo("a.jpg", 5)], {});
    expect(database.queryFiles).toHaveBeenCalledWith(
      expect.objectContaining({ filter: tripScope.filter }),
    );
  });

  it("shows no count or images for a share that scopes nothing", async () => {
    currentScope = { filter: {}, description: "Everything" };
    try {
      const { body, database } = await renderPreviewPage([photo("a.jpg", 5)], {});
      expect(database.queryFiles).not.toHaveBeenCalled();
      expect(body).not.toContain("/api/files/");
      expect(body).toContain('content="Shared · Shared via Photrix"');
    } finally {
      currentScope = tripScope;
    }
  });
});
