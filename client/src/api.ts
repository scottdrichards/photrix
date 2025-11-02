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

export interface PhotoItem {
  path: string;
  name: string;
  mediaType: "photo" | "video";
  thumbnailUrl: string;
  previewUrl: string;
  fullUrl: string;
  metadata?: ApiPhotoItem["metadata"];
}

export interface ApiPhotoResponse {
  items: ApiPhotoItem[];
  total: number;
  page: number;
}

export interface ApiFilter {
  directory?: string[];
  cameraMake?: string[];
  cameraModel?: string[];
  location?: {
    minLatitude?: number;
    maxLatitude?: number;
    minLongitude?: number;
    maxLongitude?: number;
  };
  dateRange?: {
    start?: string;
    end?: string;
  };
  rating?: number[] | { min?: number; max?: number };
  tags?: string[];
}

export interface FetchPhotosOptions {
  page?: number;
  pageSize?: number;
  metadata?: ReadonlyArray<string>;
  filter?: ApiFilter;
  signal?: AbortSignal;
}

export interface FetchPhotosResult {
  items: PhotoItem[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_METADATA_KEYS = ["mimeType", "dimensions"] as const;

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
  const mediaType = inferMediaType(item);
  const thumbnailUrl = buildFileUrl(item.path, {
    representation: "resize",
    maxWidth: "480",
    maxHeight: "480",
  });
  const previewUrl = buildFileUrl(item.path, {
    representation: "webSafe",
  });
  const fullUrl =
    mediaType === "video"
      ? buildFileUrl(item.path, { representation: "original" })
      : previewUrl;

  return {
    path: item.path,
    name,
    mediaType,
    thumbnailUrl,
    previewUrl,
    fullUrl,
    metadata: item.metadata,
  };
};

const inferMediaType = (item: ApiPhotoItem): "photo" | "video" => {
  const mime = item.metadata?.mimeType ?? null;
  if (typeof mime === "string" && mime.toLowerCase().startsWith("video/")) {
    return "video";
  }
  const lowerPath = item.path.toLowerCase();
  if (VIDEO_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))) {
    return "video";
  }
  return "photo";
};

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".wmv"];

export const fetchPhotos = async ({
  page = 1,
  pageSize = 200,
  metadata = DEFAULT_METADATA_KEYS,
  filter,
  signal,
}: FetchPhotosOptions = {}): Promise<FetchPhotosResult> => {
  const params = new URLSearchParams();
  params.set("metadata", Array.from(metadata).join(","));
  params.set("page", page.toString());
  params.set("pageSize", pageSize.toString());

  if (filter) {
    if (filter.directory && filter.directory.length > 0) {
      filter.directory.forEach((dir) => params.append("directory", dir));
    }
    if (filter.cameraMake && filter.cameraMake.length > 0) {
      filter.cameraMake.forEach((make) => params.append("cameraMake", make));
    }
    if (filter.cameraModel && filter.cameraModel.length > 0) {
      filter.cameraModel.forEach((model) => params.append("cameraModel", model));
    }
    if (filter.tags && filter.tags.length > 0) {
      filter.tags.forEach((tag) => params.append("tags", tag));
    }
    if (filter.location) {
      if (filter.location.minLatitude !== undefined) {
        params.set("location.minLatitude", filter.location.minLatitude.toString());
      }
      if (filter.location.maxLatitude !== undefined) {
        params.set("location.maxLatitude", filter.location.maxLatitude.toString());
      }
      if (filter.location.minLongitude !== undefined) {
        params.set("location.minLongitude", filter.location.minLongitude.toString());
      }
      if (filter.location.maxLongitude !== undefined) {
        params.set("location.maxLongitude", filter.location.maxLongitude.toString());
      }
    }
    if (filter.dateRange) {
      if (filter.dateRange.start) {
        params.set("dateRange.start", filter.dateRange.start);
      }
      if (filter.dateRange.end) {
        params.set("dateRange.end", filter.dateRange.end);
      }
    }
    if (filter.rating) {
      if (typeof filter.rating === "object" && !Array.isArray(filter.rating)) {
        if (filter.rating.min !== undefined) {
          params.set("rating.min", filter.rating.min.toString());
        }
        if (filter.rating.max !== undefined) {
          params.set("rating.max", filter.rating.max.toString());
        }
      }
    }
  }

  const response = await fetch(`/api/files?${params.toString()}`, { signal });

  if (!response.ok) {
    throw new Error(`Failed to fetch photos (status ${response.status})`);
  }

  const payload = (await response.json()) as ApiPhotoResponse;
  return {
    items: payload.items.map(createPhotoItem),
    total: payload.total,
    page: payload.page,
    pageSize,
  };
};

export const createFallbackPhoto = (path: string): PhotoItem => {
  const name = path.split("/").pop() ?? path;
  return {
    path,
    name,
    mediaType: "photo",
    thumbnailUrl: buildFallbackUrl(path),
    previewUrl: buildFallbackUrl(path),
    fullUrl: buildFallbackUrl(path),
  };
};
