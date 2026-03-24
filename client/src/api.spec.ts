import {
  acceptFaceSuggestion,
  createFallbackPhoto,
  fetchFaceMatches,
  fetchFacePersonSuggestions,
  fetchFacePeople,
  fetchFaceQueue,
  fetchFolders,
  fetchGeotaggedPhotos,
  fetchPhotos,
  setBackgroundTasksEnabled,
  fetchSuggestions,
  fetchSuggestionsWithCounts,
  rejectFaceSuggestion,
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
    expect(fetchMock).toHaveBeenCalledWith("/api/folders/photos/2024/", {
      credentials: "include",
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
      credentials: "include",
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

  it("fetchFaceQueue builds query parameters and returns queue payload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            faceId: "f1",
            relativePath: "/trip/a.jpg",
            fileName: "a.jpg",
            dimensions: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            person: null,
            status: "unverified",
            source: "auto-detected",
            quality: { overall: 0.76 },
            thumbnail: { preferredHeight: 320, cropVersion: "v1" },
            suggestion: { personId: "p1", confidence: 0.81 },
          },
        ],
        total: 1,
        page: 2,
        pageSize: 20,
      }),
    } as Response);

    const result = await fetchFaceQueue({
      status: "unverified",
      personId: "p1",
      minConfidence: 0.7,
      page: 2,
      pageSize: 20,
    });

    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(calledUrl, window.location.origin);
    expect(url.pathname).toBe("/api/faces/queue");
    expect(url.searchParams.get("status")).toBe("unverified");
    expect(url.searchParams.get("personId")).toBe("p1");
    expect(url.searchParams.get("minConfidence")).toBe("0.7");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("pageSize")).toBe("20");

    expect(result.total).toBe(1);
    expect(result.items[0]).toEqual({
      faceId: "f1",
      relativePath: "/trip/a.jpg",
      fileName: "a.jpg",
      dimensions: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      person: null,
      status: "unverified",
      source: "auto-detected",
      quality: { overall: 0.76 },
      thumbnail: { preferredHeight: 320, cropVersion: "v1" },
      suggestion: { personId: "p1", confidence: 0.81 },
    });
  });

  it("fetchFacePeople returns people list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        people: [
          {
            id: "p1",
            name: "Sam",
            count: 3,
            representativeFace: {
              faceId: "f1",
              relativePath: "/trip/a.jpg",
              fileName: "a.jpg",
              dimensions: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
              thumbnail: { preferredHeight: 224, cropVersion: "v1" },
            },
          },
        ],
      }),
    } as Response);

    const result = await fetchFacePeople();

    expect(result).toEqual([
      {
        id: "p1",
        name: "Sam",
        count: 3,
        representativeFace: {
          faceId: "f1",
          relativePath: "/trip/a.jpg",
          fileName: "a.jpg",
          dimensions: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          thumbnail: { preferredHeight: 224, cropVersion: "v1" },
        },
      },
    ]);
  });

  it("fetchFacePeople appends path and includeSubfolders params", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ people: [] }),
    } as Response);

    await fetchFacePeople({ path: "trip/", includeSubfolders: false });

    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(calledUrl, window.location.origin);
    expect(url.pathname).toBe("/api/faces/people");
    expect(url.searchParams.get("path")).toBe("trip/");
    expect(url.searchParams.get("includeSubfolders")).toBe("false");
  });

  it("fetchFaceMatches returns closest face matches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            faceId: "match-1",
            relativePath: "/trip/b.jpg",
            fileName: "b.jpg",
            dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
            confidence: 0.9321,
            person: null,
            status: "unverified",
          },
        ],
      }),
    } as Response);

    const result = await fetchFaceMatches({ faceId: "face-1", limit: 5 });

    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(calledUrl, window.location.origin);
    expect(url.pathname).toBe("/api/faces/face-1/matches");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(result[0]?.faceId).toBe("match-1");
  });

  it("fetchFacePersonSuggestions returns profile-based suggestions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            faceId: "suggested-1",
            relativePath: "/trip/s.jpg",
            fileName: "s.jpg",
            dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
            confidence: 0.87,
            person: null,
            status: "unverified",
          },
        ],
      }),
    } as Response);

    const result = await fetchFacePersonSuggestions({ personId: "name:sam", limit: 25 });

    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(calledUrl, window.location.origin);
    expect(url.pathname).toBe("/api/faces/people/name%3Asam/suggestions");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(result[0]?.faceId).toBe("suggested-1");
  });

  it("acceptFaceSuggestion posts review payload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, action: "accept", faceId: "f1" }),
    } as Response);

    await acceptFaceSuggestion({
      faceId: "f1",
      personId: "p1",
      reviewer: "scott",
    });

    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("/api/faces/f1/accept");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      personId: "p1",
      reviewer: "scott",
    });
  });

  it("rejectFaceSuggestion posts review payload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, action: "reject", faceId: "f1" }),
    } as Response);

    await rejectFaceSuggestion({
      faceId: "f1",
      personId: "p1",
      reviewer: "scott",
    });

    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("/api/faces/f1/reject");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      personId: "p1",
      reviewer: "scott",
    });
  });
});
