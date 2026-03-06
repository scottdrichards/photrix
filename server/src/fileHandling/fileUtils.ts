/* eslint-disable @typescript-eslint/no-explicit-any */
import exifr from "exifr";
import sharp from "sharp";
import { readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ExifMetadata, FileInfo } from "../indexDatabase/fileRecord.type.ts";
import { getVideoMetadata } from "../videoProcessing/getVideoMetadata.ts";
import { mimeTypeForFilename } from "./mimeTypes.ts";

export const getFileInfo = async (fullPath: string): Promise<FileInfo> => {
  const stats = await stat(fullPath);

  if (!stats.isFile()) {
    throw new Error(`Path ${fullPath} is not a file`);
  }

  return {
    sizeInBytes: stats.size,
    created: new Date(stats.birthtimeMs),
    modified: new Date(stats.mtimeMs),
  };
};

/**
 * Normalizes EXIF GPS input into signed decimal degrees.
 * @param input Raw coordinate value from EXIF (decimal number or DMS array [deg, min, sec]).
 * @param ref Direction reference from EXIF (typically N/S for latitude, E/W for longitude).
 * @param negativeDirection The direction letter that should produce a negative value ("S" or "W").
 * @returns Signed decimal degrees, or undefined when input cannot be parsed.
 */
const normalizeGPS = (
  input: unknown,
  ref: unknown,
  negativeDirection: string,
): number | undefined => {
  const value = (() => {
    if (typeof input === "number") {
      return input;
    }
    if (Array.isArray(input) && input.length >= 2) {
      const [degrees, minutes, seconds = 0] = input;
      if (
        typeof degrees === "number" &&
        typeof minutes === "number" &&
        typeof seconds === "number"
      ) {
        return degrees + minutes / 60 + seconds / 3600;
      }
    }
    return undefined;
  })();

  if (typeof value !== "number" || typeof ref !== "string") {
    return value;
  }

  const initial = ref.trim().toUpperCase()[0];
  return negativeDirection === initial && value > 0 ? -value : value;
};

const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeDimensions = (
  width: number | undefined,
  height: number | undefined,
  orientation: unknown,
) => {
  const normalizedOrientation = toFiniteNumber(orientation);
  const needsSwap =
    normalizedOrientation !== undefined && [5, 6, 7, 8].includes(normalizedOrientation);
  return {
    width: needsSwap ? height : width,
    height: needsSwap ? width : height,
  };
};

const getNormalizedExifDimensions = (rawData: Record<string, unknown>) => {
  const imageWidth =
    toFiniteNumber(rawData.ImageWidth) ?? toFiniteNumber(rawData.ExifImageWidth);
  const imageHeight =
    toFiniteNumber(rawData.ImageHeight) ?? toFiniteNumber(rawData.ExifImageHeight);
  return normalizeDimensions(imageWidth, imageHeight, rawData.Orientation);
};

const getNormalizedDecodedDimensions = async (fullPath: string) => {
  try {
    const imageMetadata = await sharp(fullPath).metadata();
    const width = toFiniteNumber(imageMetadata.width);
    const height = toFiniteNumber(imageMetadata.height);
    return normalizeDimensions(width, height, imageMetadata.orientation);
  } catch {
    return { width: undefined, height: undefined };
  }
};

const normalizeRegionArea = (area: unknown) => {
  if (!area || typeof area !== "object") {
    return undefined;
  }

  const areaRecord = area as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
  if (
    typeof areaRecord.x !== "number" ||
    typeof areaRecord.y !== "number" ||
    typeof areaRecord.w !== "number" ||
    typeof areaRecord.h !== "number"
  ) {
    return undefined;
  }

  return {
    x: areaRecord.x,
    y: areaRecord.y,
    width: areaRecord.w,
    height: areaRecord.h,
  };
};

const extractRegions = (regionsSource: unknown) => {
  const regionListValue =
    regionsSource && typeof regionsSource === "object"
      ? (regionsSource as { RegionList?: unknown }).RegionList
      : undefined;

  if (!Array.isArray(regionListValue)) {
    return [];
  }

  return regionListValue
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object",
    )
    .map((entry) => {
      const normalizedArea = normalizeRegionArea(entry.Area);

      const name = typeof entry.Name === "string" ? entry.Name.trim() : undefined;
      const type = typeof entry.Type === "string" ? entry.Type.trim() : undefined;
      const rotation = typeof entry.Rotation === "number" ? entry.Rotation : undefined;

      return {
        ...(name ? { name } : {}),
        ...(type ? { type } : {}),
        ...(normalizedArea ? { area: normalizedArea } : {}),
        ...(rotation !== undefined ? { rotation } : {}),
      };
    });
};

type ExifSource<K extends keyof ExifMetadata> =
  | string
  | {
      exifField: string | string[];
      conversionFn: (val: any, rawData: Record<string, unknown>) => ExifMetadata[K];
    };

type ExifFieldMapping = {
  [K in keyof ExifMetadata]?: ExifSource<K> | ExifSource<K>[];
};

const exifFieldMapping = {
  dateTaken: [
    "DateTimeOriginal",
    {
      exifField: ["photoshop:DateCreated", "xmp:CreateDate"],
      conversionFn: (d) => new Date(d),
    },
  ],
  dimensionWidth: {
    exifField: ["ImageWidth", "ExifImageWidth"],
    conversionFn: (_value, rawData) => getNormalizedExifDimensions(rawData).width,
  },
  dimensionHeight: {
    exifField: ["ImageHeight", "ExifImageHeight"],
    conversionFn: (_value, rawData) => getNormalizedExifDimensions(rawData).height,
  },
  locationLatitude: {
    exifField: "GPSLatitude",
    conversionFn: (value, rawData) => normalizeGPS(value, rawData.GPSLatitudeRef, "S"),
  },
  locationLongitude: {
    exifField: "GPSLongitude",
    conversionFn: (value, rawData) => normalizeGPS(value, rawData.GPSLongitudeRef, "W"),
  },
  cameraMake: "Make",
  cameraModel: "Model",
  exposureTime: "ExposureTime",
  aperture: "Aperture",
  iso: "ISO",
  focalLength: "FocalLength",
  lens: ["aux:Lens", "exifEX:LensModel", "Lens"],
  duration: "Duration",
  framerate: "FrameRate",
  videoCodec: "VideoCodec",
  audioCodec: "AudioCodec",
  rating: [
    { exifField: "RatingPercent", conversionFn: (v) => Math.round(v / 20) },
    "Rating",
    "xmp:Rating",
  ],
  regions: { exifField: "Regions", conversionFn: extractRegions },
  personInImage: ["PersonInImage", "xmp:PersonInImage"],
  tags: ["Keywords", "dc:subject", "lr:hierarchicalSubject"],
  orientation: {
    exifField: "Orientation",
    conversionFn: (value) => toFiniteNumber(value),
  },
} as const satisfies ExifFieldMapping;

const mapRawExifToMetadata = (rawData: Record<string, unknown>) =>
  Object.entries(exifFieldMapping).reduce(
    (acc, [fileField, sourceOrSources]) => {
      const sources = Array.isArray(sourceOrSources)
        ? sourceOrSources
        : [sourceOrSources];

      const fields = sources
        .map((source) => {
          const { exifField, conversionFn } =
            typeof source === "string" ? { exifField: source } : source;
          const fieldArray = Array.isArray(exifField) ? exifField : [exifField];
          const exifValue = fieldArray
            .map((f) => rawData[f as keyof Record<string, unknown>])
            .find((v) => v !== undefined);
          if (exifValue === undefined) {
            return null;
          }
          return [
            fileField,
            conversionFn ? conversionFn(exifValue, rawData) : exifValue,
          ] as [string, ExifMetadata[keyof ExifMetadata]];
        })
        .filter((v): v is [string, ExifMetadata[keyof ExifMetadata]] => v !== null);

      return { ...acc, ...Object.fromEntries(fields) };
    },
    {} as Partial<ExifMetadata>,
  );

const parseRawExifData = async (
  fullPath: string,
): Promise<{ rawData: Record<string, unknown>; quicktimeBrand: boolean }> => {
  try {
    const rawData = await exifr.parse(fullPath, {
      translateValues: false,
      xmp: true,
      ifd0: {},
      exif: {},
      gps: {},
    });
    return {
      rawData:
        rawData && typeof rawData === "object"
          ? (rawData as Record<string, unknown>)
          : {},
      quicktimeBrand: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("unknown file format")) {
      throw error;
    }

    const fileBuffer = await readFile(fullPath);
    const brand = fileBuffer.subarray(8, 12).toString("ascii").trim().toLowerCase();
    const quicktimeBrand = brand === "qt" || brand === "moov";
    return { rawData: {}, quicktimeBrand };
  }
};

export const getExifMetadataFromFile = async (
  fullPath: string,
): Promise<ExifMetadata> => {
  const mimeType = mimeTypeForFilename(fullPath);
  if (!mimeType) {
    // console.log(`[exif] No mime type for file ${fullPath}`);
    return {};
  }

  if (mimeType.startsWith("video/")) {
    return (await getVideoMetadata(fullPath)) as ExifMetadata;
  }

  if (!mimeType.startsWith("image/")) {
    // console.log(`[exif] Skipping non-image file for EXIF: ${fullPath} (${mimeType})`);
    return {};
  }

  const { rawData, quicktimeBrand } = await parseRawExifData(fullPath);
  if (quicktimeBrand) {
    try {
      return (await getVideoMetadata(fullPath)) as ExifMetadata;
    } catch (videoError) {
      const msg = videoError instanceof Error ? videoError.message : String(videoError);
      console.warn(
        `[exif] QuickTime-branded file failed video metadata for ${fullPath}: ${msg}. Ensure ffprobe is installed and on PATH.`,
      );
      return {};
    }
  }

  const metadata = mapRawExifToMetadata(rawData);

  const decodedDimensions = await getNormalizedDecodedDimensions(fullPath);
  if (decodedDimensions.width !== undefined) {
    metadata.dimensionWidth = decodedDimensions.width;
  }
  if (decodedDimensions.height !== undefined) {
    metadata.dimensionHeight = decodedDimensions.height;
  }

  return metadata as ExifMetadata;
};

/**
 * Returns a generator of absolute paths of files
 */
export function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(absolutePath);
    } else if (entry.isFile()) {
      yield absolutePath;
    }
  }
}
