import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PersonCluster, PhotrixApi } from "./photrixApi.ts";

type QueryOpts = Parameters<PhotrixApi["queryFiles"]>[0];

const person = (id: number, name: string | null, count = 10): PersonCluster => ({
  id: `person-${id}`,
  count,
  name,
  representative: { path: "/a.jpg", fileName: "a.jpg" },
});

const PEOPLE = [
  person(1, "Alice Diane Example", 50),
  person(2, "Bob Example", 40),
  person(3, "Alison Other", 30),
  person(4, null, 20),
];

const fakeApi = (overrides: Partial<PhotrixApi> = {}) => {
  const queries: QueryOpts[] = [];
  const imageHeights: number[] = [];
  const api: PhotrixApi = {
    searchPhotos: async () => ({ items: [], total: 0, query: "" }),
    listPeople: async () => ({
      clusters: PEOPLE,
      totalFaces: 140,
      totalClusters: PEOPLE.length,
    }),
    getPersonPhotos: async () => ({ cluster: null }),
    queryFiles: async (opts) => {
      queries.push(opts);
      return {
        items: [
          { folder: "/2020/", fileName: "a.jpg", rating: 5, dateTaken: Date.UTC(2020, 0, 2) },
          { folder: "/2021/", fileName: "b.mp4", mimeType: "video/mp4" },
        ],
        total: 45,
        page: opts.page ?? 1,
        pageSize: opts.pageSize,
      };
    },
    getDateRange: async () => ({
      minDate: new Date(2019, 5, 1).getTime(),
      maxDate: new Date(2021, 5, 1).getTime(),
    }),
    getCount: async () => ({ count: 0 }),
    fetchImage: async (_path, height) => {
      imageHeights.push(height);
      return { base64: "AAAA", mimeType: "image/jpeg" };
    },
    checkAuth: async () => "ok",
    ...overrides,
  };
  return { api, queries, imageHeights };
};

// PHOTRIX_PUBLIC_URL is read at import, so each test imports fresh.
const connect = async (api: PhotrixApi, env: Record<string, string> = {}) => {
  jest.resetModules();
  Object.assign(process.env, env);
  const { buildPhotrixMcpServer } = await import("./buildServer.ts");
  const server = buildPhotrixMcpServer(api);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "spec", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return { ...result, text: result.content.map((c) => c.text ?? "").join("\n") };
  };
  return { call, close: () => client.close() };
};

describe("resolvePerson", () => {
  it("prefers an exact name, then a unique prefix, then every word", async () => {
    const { resolvePerson } = await import("./buildServer.ts");
    expect(resolvePerson(PEOPLE, "bob example").match?.id).toBe("person-2");
    expect(resolvePerson(PEOPLE, "Bob").match?.id).toBe("person-2");
    expect(resolvePerson(PEOPLE, "alice example").match?.id).toBe("person-1");
  });

  it("reports an ambiguous name instead of guessing", async () => {
    const { resolvePerson } = await import("./buildServer.ts");
    const result = resolvePerson(PEOPLE, "Ali");
    expect(result.match).toBeUndefined();
    expect(result.candidates.map((c) => c.id)).toEqual(["person-1", "person-3"]);
  });

  it("finds nobody for an unknown name", async () => {
    const { resolvePerson } = await import("./buildServer.ts");
    expect(resolvePerson(PEOPLE, "Zed").candidates).toEqual([]);
  });
});

describe("photrix MCP tools", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
    delete process.env.PHOTRIX_PUBLIC_URL;
  });

  it("asks Photrix for one sorted page rather than sorting a big page itself", async () => {
    const { api, queries } = fakeApi();
    const session = await connect(api);
    close = session.close;

    const result = await session.call("on_this_day", { month: 1, day: 2, limit: 5 });

    expect(queries[0]).toMatchObject({ pageSize: 5, page: 1, sort: "rating:desc" });
    expect(result.text).toContain("Showing 1–2 of 45. Pass page: 2 for more.");
  });

  it("looks a person up by first name and queries their photos with the face filter", async () => {
    const { api, queries } = fakeApi();
    const session = await connect(api);
    close = session.close;

    const result = await session.call("get_person_photos", {
      person: "bob",
      dateFrom: "2020-01-01",
      dateTo: "2020-12-31",
      sort: "best",
      page: 2,
      limit: 10,
    });

    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("person-2 (Bob Example)");
    expect(queries[0]).toMatchObject({ page: 2, pageSize: 10, sort: "rating:desc" });
    expect(queries[0].filter).toEqual({
      operation: "and",
      conditions: [
        { faceCluster: [2] },
        {
          dateTaken: {
            min: Date.parse("2020-01-01"),
            max: Date.parse("2020-12-31") + 24 * 60 * 60 * 1000 - 1,
          },
        },
      ],
    });
  });

  it("lists the candidates when a name is ambiguous", async () => {
    const { api } = fakeApi();
    const session = await connect(api);
    close = session.close;

    const result = await session.call("get_person_photos", { person: "Ali" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("person-1 (Alice Diane Example)");
    expect(result.text).toContain("person-3 (Alison Other)");
  });

  it("filters list_people by name and counts faces, not photos", async () => {
    const { api } = fakeApi();
    const session = await connect(api);
    close = session.close;

    const result = await session.call("list_people", { name: "example" });

    expect(result.text).toContain("person-1: Alice Diane Example — 50 face(s)");
    expect(result.text).toContain("person-2: Bob Example");
    expect(result.text).not.toContain("person-3");
  });

  it("links results to the public URL when one is configured", async () => {
    const { api } = fakeApi();
    const session = await connect(api, { PHOTRIX_PUBLIC_URL: "https://photos.example.com/" });
    close = session.close;

    const result = await session.call("query_photos", { minRating: 5 });

    expect(result.text).toContain(
      "view: https://photos.example.com/api/files/2020/a.jpg?representation=webSafe&height=1080",
    );
    expect(result.text).toContain("/2021/b.mp4 — video");
  });

  it("maps image sizes onto Photrix's standard heights and flags video frames", async () => {
    const { api, imageHeights } = fakeApi();
    const session = await connect(api);
    close = session.close;

    await session.call("get_photo_image", { path: "/2020/a.jpg" });
    await session.call("get_photo_image", { path: "/2020/a.jpg", size: "small" });
    const video = await session.call("get_photo_image", { path: "/2021/b.MP4" });

    expect(imageHeights).toEqual([1080, 320, 1080]);
    expect(video.text).toContain("is a video; this is a still frame");
  });

  it("rejects a size larger than the server can bound", async () => {
    const { api } = fakeApi();
    const session = await connect(api);
    close = session.close;

    const result = await session.call("get_photo_image", { path: "/a.jpg", size: 4096 });

    expect(result.isError).toBe(true);
  });
});
