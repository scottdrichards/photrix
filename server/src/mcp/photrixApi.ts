// Thin client over the Photrix HTTP API. The MCP server never touches the SQLite
// index directly — it calls the same REST endpoints the web client uses, so it
// inherits auth, share-scoping, and all query/aggregation logic for free and can
// run on a different host from Photrix itself.

const BASE_URL = (process.env.PHOTRIX_BASE_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const REQUEST_TIMEOUT_MS = Number(process.env.PHOTRIX_MCP_TIMEOUT_MS) || 30_000;

export const photrixBaseUrl = BASE_URL;

// Photrix serves files at /api/files/<relativePath>. Folder paths start with a
// leading "/", which the route does not want, and each segment must be
// percent-encoded so spaces/unicode in file names survive the fetch.
export const encodeRelativePath = (relativePath: string): string =>
  relativePath.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");

// A human-openable URL for a result (auth may still be required in the browser).
export const viewUrl = (relativePath: string, height = 1024): string =>
  `${BASE_URL}/api/files/${encodeRelativePath(relativePath)}?representation=webSafe&height=${height}`;

// ---- Response shapes (subset of what the endpoints return) ----

export type SearchItem = {
  folder: string;
  fileName: string;
  mimeType: string | null;
  similarity: number;
  sources: string[];
};
export type SearchResponse = { items: SearchItem[]; total: number; query: string };

export type FaceRep = { path: string; fileName: string };
export type PersonCluster = {
  id: string;
  count: number;
  name?: string | null;
  yearRangeLabel?: string | null;
  representative: FaceRep;
};
export type PeopleResponse = {
  clusters: PersonCluster[];
  totalFaces: number;
  totalClusters: number;
  pendingFaces?: number;
};

export type ClusterDetailResponse = {
  cluster: {
    id: string;
    count: number;
    name?: string | null;
    faces: FaceRep[];
  } | null;
};

export type FileItem = {
  folder: string;
  fileName: string;
  mimeType?: string | null;
  dateTaken?: number | string | null;
  rating?: number | null;
  cameraMake?: string | null;
  cameraModel?: string | null;
  locationLatitude?: number | null;
  locationLongitude?: number | null;
  dimensionWidth?: number | null;
  dimensionHeight?: number | null;
  [key: string]: unknown;
};
export type QueryResponse = {
  items: FileItem[];
  total: number;
  page: number;
  pageSize: number;
};
export type DateRangeResponse = { minDate: number | null; maxDate: number | null };
export type CountResponse = { count: number };

export type FilterElement = unknown;
export type FetchedImage = { base64: string; mimeType: string };

// ---- API calls ----

// Each MCP request builds its own token-bound api so a remote agent
// authenticates to Photrix with *its own* key (falling back to the env
// PHOTRIX_TOKEN for single-user setups). Photrix is the single source of auth:
// a revoked key simply produces a 401 here.
export type PhotrixApi = {
  searchPhotos: (opts: {
    q: string;
    limit: number;
    folder?: string;
    includeSubfolders: boolean;
    sources?: string[];
  }) => Promise<SearchResponse>;
  listPeople: (includeSubfolders?: boolean) => Promise<PeopleResponse>;
  getPersonPhotos: (clusterId: string) => Promise<ClusterDetailResponse>;
  queryFiles: (opts: {
    filter?: FilterElement;
    metadata: string[];
    pageSize: number;
    includeSubfolders?: boolean;
  }) => Promise<QueryResponse>;
  getDateRange: () => Promise<DateRangeResponse>;
  getCount: (filter?: FilterElement) => Promise<CountResponse>;
  fetchImage: (relativePath: string, height: number) => Promise<FetchedImage>;
};

export const createPhotrixApi = (token?: string): PhotrixApi => {
  const authToken = token ?? process.env.PHOTRIX_TOKEN;
  const authHeaders = (): Record<string, string> =>
    authToken ? { Authorization: `Bearer ${authToken}` } : {};

  const apiFetch = async (pathWithQuery: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${BASE_URL}${pathWithQuery}`, {
        signal: controller.signal,
        headers: authHeaders(),
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const apiJson = async <T>(pathWithQuery: string): Promise<T> => {
    let res: Response;
    try {
      res = await apiFetch(pathWithQuery);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Photrix request timed out after ${REQUEST_TIMEOUT_MS}ms (${pathWithQuery}). Is the server running at ${BASE_URL}?`,
        );
      }
      throw new Error(
        `Could not reach Photrix at ${BASE_URL}${pathWithQuery}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Photrix API returned ${res.status} for ${pathWithQuery}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    return (await res.json()) as T;
  };

  return {
    searchPhotos: (opts) => {
      const params = new URLSearchParams({ q: opts.q, limit: String(opts.limit) });
      if (opts.folder) params.set("path", opts.folder);
      if (opts.includeSubfolders) params.set("includeSubfolders", "true");
      if (opts.sources?.length) params.set("sources", opts.sources.join(","));
      return apiJson<SearchResponse>(`/api/search?${params.toString()}`);
    },

    listPeople: (includeSubfolders = true) => {
      const params = new URLSearchParams({ aggregate: "people" });
      if (includeSubfolders) params.set("includeSubfolders", "true");
      return apiJson<PeopleResponse>(`/api/files/?${params.toString()}`);
    },

    getPersonPhotos: (clusterId) => {
      const params = new URLSearchParams({
        aggregate: "peopleClusterDetail",
        clusterId,
        includeSubfolders: "true",
      });
      return apiJson<ClusterDetailResponse>(`/api/files/?${params.toString()}`);
    },

    queryFiles: (opts) => {
      const params = new URLSearchParams({
        metadata: opts.metadata.join(","),
        pageSize: String(opts.pageSize),
      });
      if (opts.includeSubfolders ?? true) params.set("includeSubfolders", "true");
      if (opts.filter !== undefined) params.set("filter", JSON.stringify(opts.filter));
      return apiJson<QueryResponse>(`/api/files/?${params.toString()}`);
    },

    getDateRange: () =>
      apiJson<DateRangeResponse>(
        `/api/files/?aggregate=dateRange&includeSubfolders=true`,
      ),

    getCount: (filter) => {
      const params = new URLSearchParams({ count: "true", includeSubfolders: "true" });
      if (filter !== undefined) params.set("filter", JSON.stringify(filter));
      return apiJson<CountResponse>(`/api/files/?${params.toString()}`);
    },

    // Pull a display-ready copy of an image so the agent can actually "see" the
    // photo. `webSafe` transcodes HEIC/RAW to JPEG and resizes to the given edge.
    fetchImage: async (relativePath, height) => {
      const params = new URLSearchParams({
        representation: "webSafe",
        height: String(height),
      });
      const res = await apiFetch(
        `/api/files/${encodeRelativePath(relativePath)}?${params.toString()}`,
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Could not fetch image ${relativePath} (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        );
      }
      const mimeType = res.headers.get("content-type") ?? "image/jpeg";
      const buffer = Buffer.from(await res.arrayBuffer());
      return { base64: buffer.toString("base64"), mimeType };
    },
  };
};
