import { promises as fs } from "fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "path";
import { imageSize } from "image-size";
import exifr from "exifr";
import type { IndexedFileRecord } from "./models.js";
import { mimeTypeForFilename } from "./mimeTypes.js";

const execFileAsync = promisify(execFile);

type ValueWithValueOf = {
  valueOf: () => unknown;
};

type ExifrMetadata = {
  DateTimeOriginal?: unknown;
  CreateDate?: unknown;
  ExifImageWidth?: unknown;
  ImageWidth?: unknown;
  PixelXDimension?: unknown;
  ExifImageHeight?: unknown;
  ImageHeight?: unknown;
  PixelYDimension?: unknown;
  latitude?: unknown;
  GPSLatitude?: unknown;
  Latitude?: unknown;
  longitude?: unknown;
  GPSLongitude?: unknown;
  Longitude?: unknown;
  Make?: unknown;
  Model?: unknown;
  ExposureTime?: unknown;
  ShutterSpeedValue?: unknown;
  FNumber?: unknown;
  ApertureValue?: unknown;
  ISO?: unknown;
  ISOSpeedRatings?: unknown;
  FocalLength?: unknown;
  LensModel?: unknown;
  Rating?: unknown;
  XPSubject?: unknown;
  xmp?: {
    Rating?: unknown;
  };
  Keywords?: unknown;
  Subject?: unknown;
  Categories?: unknown;
} & Record<string, unknown>;

const hasValueOf = (value: unknown): value is ValueWithValueOf => {
  return (
    typeof value === "object" &&
    value !== null &&
    "valueOf" in value &&
    typeof (value as ValueWithValueOf).valueOf === "function"
  );
};

const toPosixPath = (relativePath: string): string => {
  return relativePath.split(path.sep).join("/");
};

const safeImageSize = async (
  filePath: string,
): Promise<{ width: number; height: number } | undefined> => {
  return new Promise((resolve) => {
    try {
      const dimensions = imageSize(filePath);
      if (dimensions && dimensions.width && dimensions.height) {
        resolve({ width: dimensions.width, height: dimensions.height });
      } else {
        resolve(undefined);
      }
    } catch {
      resolve(undefined);
    }
  });
};

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  if (hasValueOf(value)) {
    const numeric = Number(value.valueOf());
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return undefined;
};

const toDateISO = (value: unknown): string | undefined => {
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) {
      return value.toISOString();
    }
    return undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return undefined;
};

const formatExposure = (value: unknown): string | undefined => {
  const numeric = toNumber(value);
  if (numeric === undefined) {
    if (typeof value === "string") {
      return value;
    }
    return undefined;
  }

  if (numeric === 0) {
    return "0s";
  }
  if (numeric >= 1) {
    return `${numeric}s`;
  }
  const denominator = Math.round(1 / numeric);
  if (denominator > 0) {
    return `1/${denominator}s`;
  }
  return `${numeric}s`;
};

const formatAperture = (value: unknown): string | undefined => {
  const numeric = toNumber(value);
  if (numeric === undefined) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    return undefined;
  }
  const rounded = Math.round(numeric * 10) / 10;
  return `f/${rounded}`;
};

const formatFocalLength = (value: unknown): string | undefined => {
  const numeric = toNumber(value);
  if (numeric === undefined) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    return undefined;
  }
  const rounded = Math.round(numeric * 10) / 10;
  return `${rounded}mm`;
};

const isExifrMetadata = (value: unknown): value is ExifrMetadata => {
  return typeof value === "object" && value !== null;
};

const extractImageMetadata = async (
  filePath: string,
): Promise<ExifrMetadata | null> => {
  try {
    const parsed = await exifr.parse(filePath, {
      exif: true,
      gps: true,
      iptc: true,
      xmp: true,
      tiff: true,
      reviveValues: true,
      translateKeys: true,
    });
    if (isExifrMetadata(parsed)) {
      return parsed;
    }
    return null;
  } catch (error) {
    console.warn(`[indexer] Failed to parse metadata for ${filePath}`, error);
    return null;
  }
};

const enrichImageMetadata = async (
  metadata: IndexedFileRecord["metadata"],
  filePath: string,
): Promise<void> => {
  const parsed = await extractImageMetadata(filePath);

  if (!parsed) {
    // Fallback for files without EXIF data
    const fallback = await safeImageSize(filePath);
    if (fallback) {
      metadata.dimensions = fallback;
    }
    return;
  }

  // Extract date taken
  metadata.dateTaken =
    toDateISO(parsed.DateTimeOriginal) ??
    toDateISO(parsed.CreateDate) ??
    metadata.dateTaken;

  // Extract dimensions
  const width =
    toNumber(parsed.ExifImageWidth) ??
    toNumber(parsed.ImageWidth) ??
    toNumber(parsed.PixelXDimension);
  const height =
    toNumber(parsed.ExifImageHeight) ??
    toNumber(parsed.ImageHeight) ??
    toNumber(parsed.PixelYDimension);
  if (width && height) {
    metadata.dimensions = { width, height };
  }

  // Extract location
  const latitude = toNumber(parsed.latitude ?? parsed.GPSLatitude ?? parsed.Latitude);
  const longitude = toNumber(parsed.longitude ?? parsed.GPSLongitude ?? parsed.Longitude);
  if (latitude !== undefined && longitude !== undefined) {
    metadata.location = { latitude, longitude };
  }

  // Extract camera information
  metadata.cameraMake = typeof parsed.Make === "string" ? parsed.Make : undefined;
  metadata.cameraModel = typeof parsed.Model === "string" ? parsed.Model : undefined;
  metadata.exposureTime = formatExposure(parsed.ExposureTime ?? parsed.ShutterSpeedValue);
  metadata.aperture = formatAperture(parsed.FNumber ?? parsed.ApertureValue);
  metadata.iso = toNumber(parsed.ISO ?? parsed.ISOSpeedRatings);
  metadata.focalLength = formatFocalLength(parsed.FocalLength);
  metadata.lens = typeof parsed.LensModel === "string" ? parsed.LensModel : undefined;

  // Extract rating
  const rating = toNumber(parsed.Rating ?? parsed.XPSubject ?? parsed.xmp?.Rating);
  if (rating !== undefined) {
    metadata.rating = rating;
  }

  // Extract tags
  const tagSources = [parsed.Keywords, parsed.Subject, parsed.Categories];
  const tags = tagSources
    .flatMap((source) => (Array.isArray(source) ? source : source ? [source] : []))
    .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    .map((tag) => tag.trim());

  if (tags.length > 0) {
    metadata.tags = Array.from(new Set(tags));
  }

  // Fallback for dimensions if not found in EXIF
  if (!metadata.dimensions) {
    const fallback = await safeImageSize(filePath);
    if (fallback) {
      metadata.dimensions = fallback;
    }
  }
};

const enrichVideoMetadata = async (
  metadata: IndexedFileRecord["metadata"],
  filePath: string,
): Promise<void> => {
  const probe = await videoMetadataProbe.probe(filePath);
  if (!probe) {
    return;
  }

  const { width, height, duration, framerate, videoCodec, audioCodec } = probe;

  if (width !== undefined && height !== undefined) {
    metadata.dimensions = { width, height };
  }

  if (duration !== undefined) {
    metadata.duration = duration;
  }

  if (framerate !== undefined) {
    metadata.framerate = framerate;
  }

  if (videoCodec) {
    metadata.videoCodec = videoCodec;
  }

  if (audioCodec) {
    metadata.audioCodec = audioCodec;
  }
};

export async function buildIndexedRecord(
  rootDir: string,
  filePath: string,
): Promise<IndexedFileRecord> {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Cannot index non-file path: ${filePath}`);
  }

  const absoluteRoot = path.resolve(rootDir);
  const absoluteFile = path.resolve(filePath);
  if (!absoluteFile.startsWith(absoluteRoot)) {
    throw new Error(`File ${filePath} is outside of root ${rootDir}`);
  }

  const relativePathRaw = path.relative(absoluteRoot, absoluteFile);
  const relativePath = toPosixPath(relativePathRaw);
  const directoryRaw = path.dirname(relativePathRaw);
  const directory = directoryRaw === "." ? "" : toPosixPath(directoryRaw);
  const name = path.basename(filePath);

  const mimeType = mimeTypeForFilename(name);
  const dateCreated = stats.birthtime ? stats.birthtime.toISOString() : undefined;
  const dateModified = stats.mtime ? stats.mtime.toISOString() : undefined;

  const metadata: IndexedFileRecord["metadata"] = {
    size: stats.size,
    mimeType: mimeType ?? undefined,
    dateCreated,
  };

  if (mimeType?.startsWith("image/")) {
    await enrichImageMetadata(metadata, filePath);
  }

  if (isVideoFile(mimeType, name)) {
    await enrichVideoMetadata(metadata, filePath);
  }

  if (!metadata.dateTaken) {
    metadata.dateTaken = dateModified ?? dateCreated;
  }

  return {
    path: relativePath,
    directory,
    name,
    size: stats.size,
    mimeType,
    dateCreated,
    dateModified,
    metadata,
    lastIndexedAt: new Date().toISOString(),
  };
}

type FfprobeStream = {
  codec_type?: string;
  width?: unknown;
  height?: unknown;
  codec_name?: unknown;
  duration?: unknown;
  avg_frame_rate?: unknown;
  r_frame_rate?: unknown;
};

type FfprobeFormat = {
  duration?: unknown;
};

type FfprobeResult = {
  streams?: unknown;
  format?: FfprobeFormat;
};

export type VideoProbeMetadata = {
  width?: number;
  height?: number;
  duration?: number;
  framerate?: number;
  videoCodec?: string;
  audioCodec?: string;
};

const probeVideoMetadata = async (
  filePath: string,
): Promise<VideoProbeMetadata | null> => {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      filePath,
    ]);

    const parsed = JSON.parse(stdout) as FfprobeResult;
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videoStream = streams.find(
      (stream): stream is FfprobeStream =>
        typeof stream === "object" &&
        stream !== null &&
        (stream as FfprobeStream).codec_type === "video",
    );
    const audioStream = streams.find(
      (stream): stream is FfprobeStream =>
        typeof stream === "object" &&
        stream !== null &&
        (stream as FfprobeStream).codec_type === "audio",
    );

    const width = toNumber(videoStream?.width);
    const height = toNumber(videoStream?.height);
    const duration =
      toNumber(videoStream?.duration) ?? toNumber(parsed.format?.duration) ?? undefined;

    const frameRate = parseFrameRate(
      videoStream?.avg_frame_rate ?? videoStream?.r_frame_rate,
    );

    const videoCodec =
      typeof videoStream?.codec_name === "string" ? videoStream.codec_name : undefined;
    const audioCodec =
      typeof audioStream?.codec_name === "string" ? audioStream.codec_name : undefined;

    return {
      width: width ?? undefined,
      height: height ?? undefined,
      duration,
      framerate: frameRate,
      videoCodec,
      audioCodec,
    };
  } catch (error) {
    console.warn(`[indexer] Failed to probe video metadata for ${filePath}`, error);
    return null;
  }
};

export const videoMetadataProbe = {
  probe: probeVideoMetadata,
};

const parseFrameRate = (value: unknown): number | undefined => {
  if (typeof value === "string") {
    const parts = value.split("/");
    if (parts.length === 2) {
      const numerator = Number(parts[0]);
      const denominator = Number(parts[1]);
      if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
        return numerator / denominator;
      }
    }
    return toNumber(value);
  }
  return toNumber(value);
};

const isVideoFile = (mimeType: string | null, name: string): boolean => {
  const lowerMime = mimeType?.toLowerCase() ?? "";
  if (lowerMime.startsWith("video/")) {
    return true;
  }
  const lowerName = name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
};

const VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".m4v",
  ".mkv",
  ".webm",
  ".avi",
  ".wmv",
  ".mpg",
  ".mpeg",
];
