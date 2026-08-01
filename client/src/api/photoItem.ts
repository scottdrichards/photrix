import { getToken } from "../auth";
import type { ApiPhotoItem, PhotoItem } from "./types";

export const DEFAULT_METADATA_KEYS = [
  "mimeType",
  "regions",
  "dimensionWidth",
  "dimensionHeight",
  "dateTaken",
  "description",
  "aiDescription",
  "sizeInBytes",
  "created",
  "modified",
  "cameraMake",
  "cameraModel",
  "exposureTime",
  "aperture",
  "iso",
  "focalLength",
  "lens",
  "flash",
  "whiteBalance",
  "subjectDistance",
  "rating",
  "tags",
  "editAdj",
  "photoQualityScore",
  "locationLatitude",
  "locationLongitude",
  "orientation",
  "duration",
  "framerate",
  "videoCodec",
  "livePhotoVideoFileName",
  "embeddedVideoLength",
] as const;

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".wmv"];

const encodePathSegments = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

export const buildFileUrl = (path: string, params: Record<string, string>): string => {
  // Use /api/files/{path} for individual file access (no trailing slash)
  // Strip leading slash from path since folder paths start with /
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(`/api/files/${encodePathSegments(normalizedPath)}`, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  // <img src> tags can't send Authorization headers, so embed the token as a
  // query param — the server accepts either form.
  const token = getToken();
  if (token) url.searchParams.set("token", token);
  return url.toString();
};

export const buildFallbackUrl = (path: string): string => {
  const url = new URL(`/api/uploads/${encodePathSegments(path)}`, window.location.origin);
  return url.toString();
};

export const buildFilesQueryUrl = (path: string, params: URLSearchParams) =>
  path
    ? `/api/files/${encodePathSegments(path)}?${params.toString()}`
    : `/api/files/?${params.toString()}`;

const inferMediaType = (item: ApiPhotoItem): "photo" | "video" => {
  const mime = item.mimeType ?? null;
  if (typeof mime === "string" && mime.toLowerCase().startsWith("video/")) {
    return "video";
  }
  const lowerName = item.fileName.toLowerCase();
  if (VIDEO_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
    return "video";
  }
  return "photo";
};

export const createPhotoItem = (item: ApiPhotoItem): PhotoItem => {
  const relativePath = item.folder + item.fileName;
  const name = item.fileName;
  const mediaType = inferMediaType(item);
  const originalUrl = buildFileUrl(relativePath, {});
  const thumbnailUrl = buildFileUrl(relativePath, {
    representation: "webSafe",
    height: "320",
  });
  // Instant, I/O-cheap grid tile served from the JPEG's embedded EXIF thumbnail
  // (header-only read). The grid paints this first, then upgrades to the sharper
  // 320 `thumbnailUrl` lazily. Photos only; video keeps its generated thumbnail.
  const microThumbnailUrl =
    mediaType === "photo"
      ? buildFileUrl(relativePath, { representation: "micro" })
      : undefined;
  const previewUrl =
    mediaType === "video"
      ? thumbnailUrl
      : buildFileUrl(relativePath, {
          representation: "webSafe",
          height: "2160",
        });
  const fullUrl =
    mediaType === "video"
      ? buildFileUrl(relativePath, { representation: "webSafe", height: "2160" })
      : previewUrl;
  const videoPreviewUrl =
    mediaType === "video"
      ? buildFileUrl(relativePath, { representation: "preview" })
      : undefined;
  const hlsUrl =
    mediaType === "video"
      ? buildFileUrl(relativePath, { representation: "hls", height: "original" })
      : undefined;
  const livePhotoVideoFileName = item.livePhotoVideoFileName;
  const livePhotoUrl =
    mediaType === "photo" && typeof livePhotoVideoFileName === "string"
      ? buildFileUrl(item.folder + livePhotoVideoFileName, {})
      : mediaType === "photo" && typeof item.embeddedVideoLength === "number"
        ? buildFileUrl(relativePath, { representation: "live-photo" })
        : undefined;

  const metadata = Object.fromEntries(
    Object.entries(item).filter(([key]) => key !== "folder" && key !== "fileName"),
  );

  return {
    path: relativePath,
    name,
    mediaType,
    originalUrl,
    thumbnailUrl,
    microThumbnailUrl,
    previewUrl,
    fullUrl,
    videoPreviewUrl,
    hlsUrl,
    livePhotoUrl,
    metadata,
  };
};

export const createFallbackPhoto = (path: string): PhotoItem => {
  const name = path.split("/").pop() ?? path;
  return {
    path,
    name,
    mediaType: "photo",
    originalUrl: buildFallbackUrl(path),
    thumbnailUrl: buildFallbackUrl(path),
    previewUrl: buildFallbackUrl(path),
    fullUrl: buildFallbackUrl(path),
  };
};

