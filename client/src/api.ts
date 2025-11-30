export interface ApiPhotoItem {
  relativePath: string;
  mimeType?: string | null;
  dateTaken?: string | null;
  dimensions?: { width: number; height: number };
  sizeInBytes?: number;
  created?: string;
  modified?: string;
  [key: string]: unknown;
}

export interface PhotoItem {
  path: string;
  name: string;
  mediaType: "photo" | "video";
  thumbnailUrl: string;
  previewUrl: string;
  fullUrl: string;
  videoPreviewUrl?: string;
  metadata?: {
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
  pageSize: number;
}

export interface FetchPhotosOptions {
  page?: number;
  pageSize?: number;
  metadata?: ReadonlyArray<string>;
  includeSubfolders?: boolean;
  path?: string;
  signal?: AbortSignal;
}

export interface FetchPhotosResult {
  items: PhotoItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface QueueStatus {
  length: number;
  active: number;
  total: number;
}

export interface ServerStatus {
  databaseSize: number;
  queues: {
    info: QueueStatus;
    exifMetadata: QueueStatus;
    aiMetadata: QueueStatus;
    faceMetadata: QueueStatus;
    thumbnail: QueueStatus;
  };
  scannedFilesCount: number;
}

const DEFAULT_METADATA_KEYS = ["mimeType", "dimensions"] as const;

export const fetchStatus = async (): Promise<ServerStatus> => {
  const response = await fetch("/api/status");
  if (!response.ok) {
    throw new Error(`Failed to fetch status (status ${response.status})`);
  }
  return await response.json();
};

export const fetchFolders = async (path: string = ""): Promise<string[]> => {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const response = await fetch(`/api/folders/${normalizedPath}`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch folders (status ${response.status})`);
  }
  
  const data = await response.json() as { folders: string[] };
  return data.folders;
};

const buildFileUrl = (path: string, params: Record<string, string>): string => {
  // Use /api/files/{path} for individual file access (no trailing slash)
  const url = new URL(`/api/files/${path}`, window.location.origin);
  // Add any transformation params (for future use)
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
};

const buildFallbackUrl = (path: string): string => {
  const url = new URL(`/api/uploads/${path}`, window.location.origin);
  return url.toString();
};

const createPhotoItem = (item: ApiPhotoItem): PhotoItem => {
  const name = item.relativePath.split("/").pop() ?? item.relativePath;
  const mediaType = inferMediaType(item);
  const thumbnailUrl = buildFileUrl(item.relativePath, {
    representation: "webSafe",
    height: "320",
  });
  const previewUrl = buildFileUrl(item.relativePath, {
    representation: "webSafe",
    height: "2160",
  });
  const fullUrl =
    mediaType === "video"
      ? buildFileUrl(item.relativePath, { representation: "original" })
      : previewUrl;
  const videoPreviewUrl =
    mediaType === "video"
      ? buildFileUrl(item.relativePath, { representation: "preview" })
      : undefined;

  return {
    path: item.relativePath,
    name,
    mediaType,
    thumbnailUrl,
    previewUrl,
    fullUrl,
    videoPreviewUrl,
    metadata: {
      mimeType: item.mimeType,
      dateTaken: item.dateTaken,
      dimensions: item.dimensions,
    },
  };
};

const inferMediaType = (item: ApiPhotoItem): "photo" | "video" => {
  const mime = item.mimeType ?? null;
  if (typeof mime === "string" && mime.toLowerCase().startsWith("video/")) {
    return "video";
  }
  const lowerPath = item.relativePath.toLowerCase();
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
  includeSubfolders = false,
  path = "",
  signal,
}: FetchPhotosOptions = {}): Promise<FetchPhotosResult> => {
  const params = new URLSearchParams();
  params.set("metadata", Array.from(metadata).join(","));
  params.set("page", page.toString());
  params.set("pageSize", pageSize.toString());
  if (includeSubfolders) {
    params.set("includeSubfolders", "true");
  }

  // Use /api/files/ with trailing slash to query for multiple files
  const url = path ? `/api/files/${path}?${params.toString()}` : `/api/files/?${params.toString()}`;
  const response = await fetch(url, { signal });

  if (!response.ok) {
    throw new Error(`Failed to fetch photos (status ${response.status})`);
  }

  const payload = (await response.json()) as ApiPhotoResponse;
  return {
    items: payload.items.map(createPhotoItem),
    total: payload.total,
    page: payload.page,
    pageSize: payload.pageSize,
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
