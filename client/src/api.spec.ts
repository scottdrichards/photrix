import {
  createFallbackPhoto,
  fetchFolders,
  fetchGeotaggedPhotos,
  fetchPhotos,
  fetchSuggestions,
  subscribeStatusStream,
} from "./api";

describe("api", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetchFolders normalizes path and returns folders", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ folders: ["a", "b"] }),
    } as Response);

    const result = await fetchFolders("/photos/2024/");

    expect(result).toEqual(["a", "b"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/folders/photos/2024/");
  });

  it("fetchPhotos builds query and maps media urls/metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            folder: "trip/",
            fileName: "clip.mp4",
            mimeType: null,
            rating: 4,
          },
        ],
        total: 1,
        page: 2,
        pageSize: 5,
      }),
    } as Response);

    const result = await fetchPhotos({
      page: 2,
      pageSize: 5,
      includeSubfolders: true,
      path: "trip/",
      ratingFilter: { rating: 3, atLeast: true },
      mediaTypeFilter: "video",
      peopleInImageFilter: [" Sam ", "sam", "Taylor"],
    });

    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(calledUrl, window.location.origin);

    expect(url.pathname).toBe("/api/files/trip/");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("5");
    expect(url.searchParams.get("includeSubfolders")).toBe("true");

    const filterRaw = url.searchParams.get("filter");
    expect(filterRaw).not.toBeNull();
    const filter = JSON.parse(filterRaw ?? "{}");
    expect(filter.operation).toBe("and");
    expect(filter.conditions).toEqual(
      expect.arrayContaining([
        { rating: { min: 3 } },
        { mimeType: { startsWith: "video/" } },
        { personInImage: ["Sam", "sam", "Taylor"] },
      ]),
    );

    expect(result.total).toBe(1);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(5);
    expect(result.items[0]).toMatchObject({
      path: "trip/clip.mp4",
      name: "clip.mp4",
      mediaType: "video",
      metadata: {
        mimeType: null,
        rating: 4,
      },
    });
    expect(result.items[0].thumbnailUrl).toContain("representation=webSafe");
    expect(result.items[0].videoPreviewUrl).toContain("representation=preview");
    expect(result.items[0].hlsUrl).toContain("representation=hls");
  });

  it("fetchGeotaggedPhotos marks truncated when aggregate count is lower than total", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        clusters: [
          {
            latitude: 10,
            longitude: 20,
            count: 2,
            samplePath: "a/1.jpg",
            sampleName: "1.jpg",
          },
        ],
        total: 3,
      }),
    } as Response);

    const result = await fetchGeotaggedPhotos();

    expect(result.total).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.points).toEqual([
      {
        path: "a/1.jpg",
        name: "1.jpg",
        latitude: 10,
        longitude: 20,
        count: 2,
      },
    ]);
  });

  it("fetchSuggestions returns empty list for blank query without network request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await fetchSuggestions({
      field: "personInImage",
      q: "   ",
    });

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("createFallbackPhoto returns upload-based urls", () => {
    const fallback = createFallbackPhoto("folder/a.jpg");

    expect(fallback.path).toBe("folder/a.jpg");
    expect(fallback.name).toBe("a.jpg");
    expect(fallback.mediaType).toBe("photo");

    const originalPath = new URL(fallback.originalUrl).pathname;
    const thumbnailPath = new URL(fallback.thumbnailUrl).pathname;
    const previewPath = new URL(fallback.previewUrl).pathname;
    const fullPath = new URL(fallback.fullUrl).pathname;

    expect(originalPath).toBe("/api/uploads/folder/a.jpg");
    expect(thumbnailPath).toBe("/api/uploads/folder/a.jpg");
    expect(previewPath).toBe("/api/uploads/folder/a.jpg");
    expect(fullPath).toBe("/api/uploads/folder/a.jpg");
  });

  it("subscribeStatusStream forwards updates and parse errors", () => {
    class FakeEventSource {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      close = vi.fn();

      constructor(public readonly url: string) {}
    }

    const OriginalEventSource = globalThis.EventSource;
    const eventSources: FakeEventSource[] = [];
    // @ts-expect-error test override
    globalThis.EventSource = class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        eventSources.push(this);
      }
    };

    const onUpdate = vi.fn();
    const onError = vi.fn();

    const unsubscribe = subscribeStatusStream(onUpdate, onError);

    expect(eventSources[0].url).toBe("/api/status/stream");

    eventSources[0].onmessage?.({
      data: JSON.stringify({ databaseSize: 1 }),
    } as MessageEvent<string>);
    eventSources[0].onmessage?.({ data: "not-json" } as MessageEvent<string>);
    eventSources[0].onerror?.(new Event("error"));

    expect(onUpdate).toHaveBeenCalledWith({ databaseSize: 1 });
    expect(onError).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(eventSources[0].close).toHaveBeenCalled();

    globalThis.EventSource = OriginalEventSource;
  });
});
