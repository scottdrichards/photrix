import { promises as fs } from "fs";
import path from "path";
import { lookup as lookupMimeType } from "mime-types";
import imageSize from "image-size";
import exifr from "exifr";
import type { IndexedFileRecord } from "./models.js";

function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

async function safeImageSize(filePath: string): Promise<{ width: number; height: number } | undefined> {
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
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  if (typeof value === "object" && value !== null && typeof (value as any).valueOf === "function") {
    const numeric = Number((value as any).valueOf());
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return undefined;
}

function toDateISO(value: unknown): string | undefined {
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
}

function formatExposure(value: unknown): string | undefined {
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
}

function formatAperture(value: unknown): string | undefined {
  const numeric = toNumber(value);
  if (numeric === undefined) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    return undefined;
  }
  const rounded = Math.round(numeric * 10) / 10;
  return `f/${rounded}`;
}

function formatFocalLength(value: unknown): string | undefined {
  const numeric = toNumber(value);
  if (numeric === undefined) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    return undefined;
  }
  const rounded = Math.round(numeric * 10) / 10;
  return `${rounded}mm`;
}

async function extractImageMetadata(filePath: string): Promise<Record<string, any> | null> {
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
    return parsed ?? null;
  } catch (error) {
    console.warn(`[indexer] Failed to parse metadata for ${filePath}`, error);
    return null;
  }
}

export async function buildIndexedRecord(rootDir: string, filePath: string): Promise<IndexedFileRecord> {
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

  const mimeType = lookupMimeType(name) || null;
  const dateCreated = stats.birthtime ? stats.birthtime.toISOString() : undefined;
  const dateModified = stats.mtime ? stats.mtime.toISOString() : undefined;

  const metadata: IndexedFileRecord["metadata"] = {
    name,
    size: stats.size,
    mimeType: mimeType ?? undefined,
    dateCreated,
    dateTaken: dateCreated ?? dateModified,
  };

  if (mimeType && mimeType.startsWith("image/")) {
    const parsed = await extractImageMetadata(filePath);

    if (parsed) {
      metadata.dateTaken = toDateISO(parsed.DateTimeOriginal) ??
        toDateISO(parsed.CreateDate) ??
        metadata.dateTaken;

      const width = toNumber(parsed.ExifImageWidth) ??
        toNumber(parsed.ImageWidth) ??
        toNumber(parsed.PixelXDimension);
      const height = toNumber(parsed.ExifImageHeight) ??
        toNumber(parsed.ImageHeight) ??
        toNumber(parsed.PixelYDimension);
      if (width && height) {
        metadata.dimensions = { width, height };
      }

  const latitude = toNumber(parsed.latitude ?? parsed.GPSLatitude ?? parsed.Latitude);
  const longitude = toNumber(parsed.longitude ?? parsed.GPSLongitude ?? parsed.Longitude);
      if (latitude !== undefined && longitude !== undefined) {
        metadata.location = { latitude, longitude };
      }

      metadata.cameraMake = typeof parsed.Make === "string" ? parsed.Make : undefined;
      metadata.cameraModel = typeof parsed.Model === "string" ? parsed.Model : undefined;
      metadata.exposureTime = formatExposure(parsed.ExposureTime ?? parsed.ShutterSpeedValue);
      metadata.aperture = formatAperture(parsed.FNumber ?? parsed.ApertureValue);
      metadata.iso = toNumber(parsed.ISO ?? parsed.ISOSpeedRatings);
      metadata.focalLength = formatFocalLength(parsed.FocalLength);
      metadata.lens = typeof parsed.LensModel === "string" ? parsed.LensModel : undefined;

      const rating = toNumber(parsed.Rating ?? parsed.XPSubject ?? parsed.xmp?.Rating);
      if (rating !== undefined) {
        metadata.rating = rating;
      }

      const tagSources = [parsed.Keywords, parsed.Subject, parsed.Categories];
      const tags = new Set<string>();
      for (const source of tagSources) {
        if (Array.isArray(source)) {
          for (const entry of source) {
            if (typeof entry === "string" && entry.trim().length > 0) {
              tags.add(entry.trim());
            }
          }
        } else if (typeof source === "string" && source.trim().length > 0) {
          tags.add(source.trim());
        }
      }
      if (tags.size > 0) {
        metadata.tags = Array.from(tags);
      }
    }

    if (!metadata.dimensions) {
      // Some files omit width/height in EXIF entirely (screenshots, scans, stripped metadata).
      // Fall back to inspecting the binary header so we still index dimensions when possible.
      const fallback = await safeImageSize(filePath);
      if (fallback) {
        metadata.dimensions = fallback;
      }
    }
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
