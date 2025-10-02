export interface ApiPhotoItem {
  path: string;
  metadata?: {
    name?: string;
    mimeType?: string | null;
    dateTaken?: string | null;
    dimensions?: { width: number; height: number };
    [key: string]: unknown;
  };
}

export interface ApiPhotoResponse {
  items: ApiPhotoItem[];
  total: number;
  page: number;
}

export interface PhotoItem {
  path: string;
  name: string;
  thumbnailUrl: string;
  fullUrl: string;
  metadata?: ApiPhotoItem["metadata"];
}

const DEFAULT_METADATA_KEYS = ["name", "mimeType", "dimensions"] as const;

const buildFileUrl = (path: string, params: Record<string, string>): string => {
  const url = new URL("/api/file", window.location.origin);
  url.searchParams.set("path", path);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
};

const buildFallbackUrl = (path: string): string => {
  const url = new URL(`/uploads/${path}`, window.location.origin);
  return url.toString();
};

const createPhotoItem = (item: ApiPhotoItem): PhotoItem => {
  const name = item.metadata?.name ?? item.path.split("/").pop() ?? item.path;
  const thumbnailUrl = buildFileUrl(item.path, {
    representation: "resize",
    maxWidth: "480",
    maxHeight: "480",
  });
  const fullUrl = buildFileUrl(item.path, {
    representation: "webSafe",
  });

  return {
    path: item.path,
    name,
    thumbnailUrl,
    fullUrl,
    metadata: item.metadata,
  };
};

export const fetchPhotos = async (signal?: AbortSignal): Promise<PhotoItem[]> => {
  const params = new URLSearchParams();
  params.set("metadata", DEFAULT_METADATA_KEYS.join(","));
  params.set("pageSize", "200");

  const response = await fetch(`/api/files?${params.toString()}`, { signal });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch photos (status ${response.status})`);
  }

  const payload = (await response.json()) as ApiPhotoResponse;
  return payload.items.map(createPhotoItem);
};

export const createFallbackPhoto = (path: string): PhotoItem => {
  const name = path.split("/").pop() ?? path;
  return {
    path,
    name,
    thumbnailUrl: buildFallbackUrl(path),
    fullUrl: buildFallbackUrl(path),
  };
};
