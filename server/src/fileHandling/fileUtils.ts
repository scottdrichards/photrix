/* eslint-disable @typescript-eslint/no-explicit-any */
import exifr from "exifr";
import { readdirSync } from "node:fs";
import { access, open } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ExifMetadata } from "../indexDatabase/fileRecord.type.ts";
import { getVideoMetadata } from "../videoProcessing/getVideoMetadata.ts";
import { mimeTypeForFilename } from "./mimeTypes.ts";

export const getFastMediaDimensions = async (
  fullPath: string,
): Promise<Pick<ExifMetadata, "dimensionWidth" | "dimensionHeight">> => {
  const mimeType = mimeTypeForFilename(fullPath);
  if (!mimeType) {
    return {};
  }

  if (mimeType.startsWith("image/")) {
    const { width, height } = await getNormalizedDecodedDimensions(fullPath);
    return {
      ...(width !== undefined ? { dimensionWidth: width } : {}),
      ...(height !== undefined ? { dimensionHeight: height } : {}),
    };
  }

  if (mimeType.startsWith("video/")) {
    const metadata = await getVideoMetadata(fullPath);
    return {
      ...(metadata.dimensionWidth !== undefined
        ? { dimensionWidth: metadata.dimensionWidth }
        : {}),
      ...(metadata.dimensionHeight !== undefined
        ? { dimensionHeight: metadata.dimensionHeight }
        : {}),
    };
  }

  return {};
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

  const areaRecord = area as {
    x?: unknown;
    y?: unknown;
    w?: unknown;
    h?: unknown;
    width?: unknown;
    height?: unknown;
  };
  const width =
    typeof areaRecord.w === "number"
      ? areaRecord.w
      : typeof areaRecord.width === "number"
        ? areaRecord.width
        : undefined;
  const height =
    typeof areaRecord.h === "number"
      ? areaRecord.h
      : typeof areaRecord.height === "number"
        ? areaRecord.height
        : undefined;
  if (
    typeof areaRecord.x !== "number" ||
    typeof areaRecord.y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return undefined;
  }

  return {
    x: areaRecord.x,
    y: areaRecord.y,
    width,
    height,
  };
};

const clampToUnit = (value: number) => Math.min(Math.max(value, 0), 1);

const transformRegionByOrientation = (
  area: { x: number; y: number; width: number; height: number },
  orientation: number,
) => {
  const { x, y, width, height } = area;

  switch (orientation) {
    case 2:
      return { x: 1 - x, y, width, height };
    case 3:
      return { x: 1 - x, y: 1 - y, width, height };
    case 4:
      return { x, y: 1 - y, width, height };
    case 5:
      return { x: y, y: x, width: height, height: width };
    case 6:
      return { x: 1 - y, y: x, width: height, height: width };
    case 7:
      return { x: 1 - y, y: 1 - x, width: height, height: width };
    case 8:
      return { x: y, y: 1 - x, width: height, height: width };
    case 1:
    default:
      return { x, y, width, height };
  }
};

const unwrapJsonString = (value: unknown): unknown => {
  let current = value;
  while (typeof current === "string") {
    try {
      current = JSON.parse(current);
    } catch {
      return current;
    }
  }
  return current;
};

const toRegionList = (regionsSource: unknown): unknown[] => {
  const unwrapped = unwrapJsonString(regionsSource);
  if (Array.isArray(unwrapped)) {
    return unwrapped;
  }

  if (!unwrapped || typeof unwrapped !== "object") {
    return [];
  }

  const regionList = (unwrapped as { RegionList?: unknown }).RegionList;
  const regionListUnwrapped = unwrapJsonString(regionList);
  return Array.isArray(regionListUnwrapped) ? regionListUnwrapped : [];
};

const extractRegions = (regionsSource: unknown, rawData: Record<string, unknown>) => {
  const orientation = toFiniteNumber(rawData.Orientation) ?? 1;
  return toRegionList(regionsSource)
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object",
    )
    .map((entry) => {
      const normalizedArea = normalizeRegionArea(entry.Area);
      const transformedArea = normalizedArea
        ? transformRegionByOrientation(normalizedArea, orientation)
        : undefined;

      const name = typeof entry.Name === "string" ? entry.Name.trim() : undefined;
      const type = typeof entry.Type === "string" ? entry.Type.trim() : undefined;
      const rotation = typeof entry.Rotation === "number" ? entry.Rotation : undefined;

      return {
        ...(name ? { name } : {}),
        ...(type ? { type } : {}),
        ...(transformedArea
          ? {
              area: {
                x: clampToUnit(transformedArea.x),
                y: clampToUnit(transformedArea.y),
                width: clampToUnit(transformedArea.width),
                height: clampToUnit(transformedArea.height),
              },
            }
          : {}),
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
  Object.entries(exifFieldMapping).reduce((acc, [fileField, sourceOrSources]) => {
    const sources = Array.isArray(sourceOrSources) ? sourceOrSources : [sourceOrSources];

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
  }, {} as Partial<ExifMetadata>);

const parseRawExifData = async (
  fullPath: string,
): Promise<{ rawData: Record<string, unknown>; quicktimeBrand: boolean }> => {
  try {
    const rawData: unknown = await exifr.parse(fullPath, {
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

    const fileHandle = await open(fullPath, "r");
    try {
      const header = Buffer.alloc(12);
      await fileHandle.read(header, 0, header.length, 0);
      const brand = header.subarray(8, 12).toString("ascii").trim().toLowerCase();
      const quicktimeBrand = brand === "qt" || brand === "moov";
      return { rawData: {}, quicktimeBrand };
    } finally {
      await fileHandle.close();
    }
  }
};

export const getExifMetadataFromFile = async (
  fullPath: string,
): Promise<ExifMetadata> => {
  const mimeType = mimeTypeForFilename(fullPath);
  if (!mimeType) {
    return {};
  }

  if (mimeType.startsWith("video/")) {
    return (await getVideoMetadata(fullPath)) as ExifMetadata;
  }

  if (!mimeType.startsWith("image/")) {
    return {};
  }

  const { rawData, quicktimeBrand } = await parseRawExifData(fullPath);
  if (quicktimeBrand) {
    try {
      return (await getVideoMetadata(fullPath)) as ExifMetadata;
    } catch {
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

  const livePhotoVideoFileName = await findSiblingLivePhotoVideo(fullPath);
  if (livePhotoVideoFileName) {
    metadata.livePhotoVideoFileName = livePhotoVideoFileName;
  }

  return metadata as ExifMetadata;
};

const LIVE_PHOTO_VIDEO_EXTENSIONS = [".mov", ".MOV", ".mp4", ".MP4"];

/** Checks for a sibling video file (same stem, video extension) — used to detect Apple Live Photos. */
const findSiblingLivePhotoVideo = async (
  fullPath: string,
): Promise<string | undefined> => {
  const dir = path.dirname(fullPath);
  const stem = path.basename(fullPath, path.extname(fullPath));
  for (const ext of LIVE_PHOTO_VIDEO_EXTENSIONS) {
    const exists = await access(path.join(dir, stem + ext)).then(
      () => true,
      () => false,
    );
    if (exists) return stem + ext;
  }
  return undefined;
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
