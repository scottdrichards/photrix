import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildPhotrixMcpServer } from "./buildServer.ts";
import type { PhotrixApi } from "./photrixApi.ts";

const unused = () => Promise.reject(new Error("not stubbed"));
const stubApi = (overrides: Partial<PhotrixApi>): PhotrixApi => ({
  searchPhotos: unused,
  listPeople: unused,
  getPersonPhotos: unused,
  queryFiles: unused,
  getDateRange: unused,
  listFieldValues: unused,
  fetchImage: unused,
  ...overrides,
});

const clients: Client[] = [];
const connect = async (api: PhotrixApi) => {
  const server = buildPhotrixMcpServer(api);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  return client;
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};
const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

describe("Photrix MCP tools", () => {
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  it("exposes every tool as read-only", async () => {
    const client = await connect(stubApi({}));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_person_photos",
      "get_photo_image",
      "list_people",
      "list_values",
      "on_this_day",
      "query_photos",
      "search_photos",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("search_photos returns structured photos alongside readable text", async () => {
    const searchPhotos = jest.fn<PhotrixApi["searchPhotos"]>().mockResolvedValue({
      items: [
        {
          folder: "/2023/",
          fileName: "a b.jpg",
          mimeType: null,
          similarity: 0.9,
          sources: ["image"],
        },
      ],
      total: 1,
      query: "dog",
    });
    const client = await connect(stubApi({ searchPhotos }));

    const result = await call(client, "search_photos", { query: "dog" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      photos: [{ path: "/2023/a b.jpg", sources: ["image"] }],
    });
    expect(result.content[0].text).toContain("/2023/a b.jpg");
    expect(searchPhotos).toHaveBeenCalledWith(
      expect.objectContaining({ q: "dog", limit: 20 }),
    );
  });

  it("surfaces a failing Photrix call as an error result instead of throwing", async () => {
    const client = await connect(
      stubApi({
        searchPhotos: () => Promise.reject(new Error("Photrix API returned 401")),
      }),
    );
    const result = await call(client, "search_photos", { query: "dog" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("401");
  });

  it("list_people filters to named people and respects the limit", async () => {
    const rep = { path: "/x.jpg", fileName: "x.jpg" };
    const client = await connect(
      stubApi({
        listPeople: () =>
          Promise.resolve({
            clusters: [
              { id: "person-1", count: 5, name: "Alice", representative: rep },
              { id: "person-2", count: 9, name: null, representative: rep },
              { id: "person-3", count: 2, name: "Bob", representative: rep },
            ],
            totalFaces: 16,
            totalClusters: 3,
          }),
      }),
    );
    const result = await call(client, "list_people", { onlyNamed: true, limit: 1 });
    expect(result.structuredContent).toMatchObject({
      people: [{ id: "person-1", name: "Alice", photoCount: 5 }],
      totalPeople: 3,
    });
  });

  it("get_person_photos resolves a name case-insensitively and de-duplicates paths", async () => {
    const rep = { path: "/x.jpg", fileName: "x.jpg" };
    const getPersonPhotos = jest.fn<PhotrixApi["getPersonPhotos"]>().mockResolvedValue({
      cluster: {
        id: "person-1",
        count: 2,
        name: "Alice",
        faces: [
          { path: "/a.jpg", fileName: "a.jpg" },
          { path: "/a.jpg", fileName: "a.jpg" },
          { path: "/b.jpg", fileName: "b.jpg" },
        ],
      },
    });
    const client = await connect(
      stubApi({
        getPersonPhotos,
        listPeople: () =>
          Promise.resolve({
            clusters: [{ id: "person-1", count: 2, name: "Alice", representative: rep }],
            totalFaces: 3,
            totalClusters: 1,
          }),
      }),
    );
    const result = await call(client, "get_person_photos", { person: " alice " });
    expect(getPersonPhotos).toHaveBeenCalledWith("person-1");
    expect(result.structuredContent).toMatchObject({
      photos: [{ path: "/a.jpg" }, { path: "/b.jpg" }],
    });
  });

  it("get_person_photos reports an unknown name as an error", async () => {
    const client = await connect(
      stubApi({
        listPeople: () =>
          Promise.resolve({ clusters: [], totalFaces: 0, totalClusters: 0 }),
      }),
    );
    const result = await call(client, "get_person_photos", { person: "Nobody" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("list_people");
  });

  it("query_photos combines filters with AND and passes the page through", async () => {
    const queryFiles = jest.fn<PhotrixApi["queryFiles"]>().mockResolvedValue({
      items: [
        { folder: "/t/", fileName: "p.jpg", dateTaken: Date.UTC(2023, 5, 1), rating: 4 },
      ],
      total: 31,
      page: 2,
      pageSize: 30,
    });
    const client = await connect(stubApi({ queryFiles }));

    const result = await call(client, "query_photos", {
      dateFrom: "2023-01-01",
      dateTo: "2023-12-31",
      minRating: 4,
      tag: "trip",
      page: 2,
    });

    const { filter, page } = queryFiles.mock.calls[0][0] as { filter: any; page: number };
    expect(page).toBe(2);
    expect(filter.operation).toBe("and");
    expect(filter.conditions).toEqual(
      expect.arrayContaining([
        {
          dateTaken: {
            min: Date.parse("2023-01-01"),
            max: Date.parse("2023-12-31") + 86_399_999,
          },
        },
        { rating: { min: 4 } },
        { tags: "trip" },
      ]),
    );
    expect(result.structuredContent).toMatchObject({
      total: 31,
      page: 2,
      photos: [{ path: "/t/p.jpg", rating: 4, dateTaken: "2023-06-01" }],
    });
  });

  it("query_photos rejects an unparseable date", async () => {
    const client = await connect(stubApi({}));
    const result = await call(client, "query_photos", { dateFrom: "not-a-date" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("dateFrom");
  });

  it("on_this_day builds one range per year and lists highest-rated first", async () => {
    const queryFiles = jest.fn<PhotrixApi["queryFiles"]>().mockResolvedValue({
      items: [
        { folder: "/", fileName: "low.jpg", rating: 1 },
        { folder: "/", fileName: "high.jpg", rating: 5 },
      ],
      total: 2,
      page: 1,
      pageSize: 500,
    });
    const client = await connect(
      stubApi({
        queryFiles,
        getDateRange: () =>
          Promise.resolve({
            minDate: new Date(2021, 0, 1).getTime(),
            maxDate: new Date(2023, 0, 1).getTime(),
          }),
      }),
    );
    const result = await call(client, "on_this_day", { month: 6, day: 15 });

    const { filter } = queryFiles.mock.calls[0][0] as { filter: any };
    expect(filter.operation).toBe("or");
    expect(filter.conditions).toHaveLength(3);
    expect(result.structuredContent).toMatchObject({
      photos: [{ path: "/high.jpg" }, { path: "/low.jpg" }],
    });
  });

  it("list_values lists the distinct values and counts for a field", async () => {
    const listFieldValues = jest
      .fn<PhotrixApi["listFieldValues"]>()
      .mockResolvedValue([{ value: "trip", count: 12 }]);
    const client = await connect(stubApi({ listFieldValues }));
    const result = await call(client, "list_values", { field: "tags", search: "tr" });
    expect(listFieldValues).toHaveBeenCalledWith({
      field: "tags",
      search: "tr",
      limit: 50,
    });
    expect(result.structuredContent).toEqual({
      field: "tags",
      values: [{ value: "trip", count: 12 }],
    });
  });

  it("get_photo_image returns an image content block", async () => {
    const client = await connect(
      stubApi({
        fetchImage: () => Promise.resolve({ base64: "AAAA", mimeType: "image/jpeg" }),
      }),
    );
    const result = await call(client, "get_photo_image", { path: "/a.jpg" });
    expect(result.content[0]).toMatchObject({
      type: "image",
      data: "AAAA",
      mimeType: "image/jpeg",
    });
  });
});
