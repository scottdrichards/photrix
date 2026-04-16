import {
  createFallbackPhoto,
  fetchFolders,
  fetchGeotaggedPhotos,
  fetchPhotos,
  setBackgroundTasksEnabled,
  fetchSuggestions,
  fetchSuggestionsWithCounts,
  subscribeStatusStream,
} from "./api";
import {
  filterFieldCapabilities,
  FIELD_METADATA,
} from "../../shared/filter-contract/src";

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
    expect(fetchMock).toHaveBeenCalledWith("/api/folders/photos/2024/", {
      signal: undefined,
    });
  });

  it("setBackgroundTasksEnabled posts toggle payload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: false }),
    } as Response);

    const result = await setBackgroundTasksEnabled(false);

    expect(result).toEqual({ enabled: false });
    expect(fetchMock).toHaveBeenCalledWith("/api/status/background-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
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
            sizeInBytes: 1_250_000,
            duration: 5,
            videoCodec: "hevc",
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
      cameraModelFilter: ["EOS R6"],
      lensFilter: ["RF 24-70mm"],
    });

    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(calledUrl, window.location.origin);

    expect(url.pathname).toBe("/api/files/trip/");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("5");
    expect(url.searchParams.get("includeSubfolders")).toBe("true");
    expect(url.searchParams.get("metadata")?.split(",")).toEqual(
      expect.arrayContaining(["sizeInBytes", "duration", "videoCodec"]),
    );

    const filterRaw = url.searchParams.get("filter");
    expect(filterRaw).not.toBeNull();
    const filter = JSON.parse(filterRaw ?? "{}");
    expect(filter.operation).toBe("and");
    expect(filter.conditions).toEqual(
      expect.arrayContaining([
        { rating: { min: 3 } },
        { mimeType: { startsWith: "video/" } },
        { personInImage: ["Sam", "sam", "Taylor"] },
        { cameraModel: ["EOS R6"] },
        { lens: ["RF 24-70mm"] },
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
        sizeInBytes: 1_250_000,
        duration: 5,
        videoCodec: "hevc",
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

  it("does not serialize nullable array UI state as API filter conditions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [],
        total: 0,
        page: 1,
        pageSize: 200,
      }),
    } as Response);

    await fetchPhotos({
      peopleInImageFilter: null,
      cameraModelFilter: null,
      lensFilter: null,
    });

    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(calledUrl, window.location.origin);

    expect(url.searchParams.get("filter")).toBeNull();
  });

  it("exposes shared filter field capabilities for nullable and array-backed fields", () => {
    expect(filterFieldCapabilities.peopleInImageFilter).toEqual({
      supportsArray: true,
      allowsNullState: true,
    });
    expect(filterFieldCapabilities.cameraModelFilter).toEqual({
      supportsArray: true,
      allowsNullState: true,
    });
    expect(filterFieldCapabilities.mediaTypeFilter).toEqual({
      supportsArray: false,
      allowsNullState: false,
    });

    const nullableFields = Object.entries(FIELD_METADATA)
      .filter(([, { nullable }]) => nullable)
      .map(([field]) => field);
    expect(nullableFields).toEqual([
      "peopleInImageFilter",
      "cameraModelFilter",
      "lensFilter",
      "ratingFilter",
      "locationBounds",
      "dateRange",
    ]);

    const arrayFields = Object.entries(FIELD_METADATA)
      .filter(([, { supportsArray }]) => supportsArray)
      .map(([field]) => field);
    expect(arrayFields).toEqual([
      "peopleInImageFilter",
      "cameraModelFilter",
      "lensFilter",
    ]);
  });

  it("fetchSuggestions returns empty list for blank query without network request by default", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await fetchSuggestions({
      field: "personInImage",
      q: "   ",
    });

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetchSuggestions can request blank-query suggestions when enabled", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: ["Canon EOS R6"] }),
    } as Response);

    const result = await fetchSuggestions({
      field: "cameraModel",
      q: "   ",
      allowBlankQuery: true,
    });

    expect(result).toEqual(["Canon EOS R6"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(calledUrl, window.location.origin);
    expect(url.pathname).toBe("/api/suggestions");
    expect(url.searchParams.get("q")).toBe("");
    expect(url.searchParams.get("field")).toBe("cameraModel");
  });

  it("fetchSuggestionsWithCounts requests count-ranked suggestions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        suggestions: [
          { value: "Sam", count: 14 },
          { value: "Taylor", count: 9 },
        ],
      }),
    } as Response);

    const result = await fetchSuggestionsWithCounts({
      field: "personInImage",
      q: "",
      allowBlankQuery: true,
      includeCounts: true,
      limit: 10,
    });

    expect(result).toEqual([
      { value: "Sam", count: 14 },
      { value: "Taylor", count: 9 },
    ]);

    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(calledUrl, window.location.origin);
    expect(url.pathname).toBe("/api/suggestions");
    expect(url.searchParams.get("field")).toBe("personInImage");
    expect(url.searchParams.get("q")).toBe("");
    expect(url.searchParams.get("includeCounts")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("10");
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
