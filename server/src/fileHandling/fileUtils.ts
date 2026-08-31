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

// exifr may hand back date fields as strings (e.g. non-standard EXIF timestamps
// it can't revive) or even corrupt bytes. Coerce to a valid Date, or drop the
// value — never let a raw string reach the DB, or MIN/MAX(dateTaken) breaks.
const toExifDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value === "number") {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? undefined : fromNumber;
  }
  if (typeof value === "string") {
    // EXIF timestamps use "YYYY:MM:DD HH:MM:SS"; JS Date needs dashes in the date.
    const normalized = value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
};

// Human-authored captions arrive in several shapes: a plain string (EXIF
// ImageDescription / IPTC Caption-Abstract), or an XMP language-alternative that
// exifr surfaces as `{ value, lang }` or a bare string. Coerce to a trimmed
// string; drop empty/whitespace-only values so blank captions never render.
const toDescriptionString = (value: unknown): string | undefined => {
  const raw =
    typeof value === "object" && value !== null && "value" in value
      ? (value as { value?: unknown }).value
      : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

// EXIF `Flash` is a bitmask (e.g. 0x0 "No Flash", 0x1 "Fired", 0x19 "Auto,
// Fired", 0x18 "Auto, Did not fire"); bit 0 alone means "flash fired",
// regardless of mode/return-light bits above it.
const toFlashFired = (value: unknown): boolean | undefined => {
  const num = toFiniteNumber(value);
  if (num === undefined) return undefined;
  return (num & 0x1) === 1;
};

// EXIF `WhiteBalance` is a small enum: 0 = Auto, 1 = Manual. translateValues is
// off for the rest of this parse (see parseRawExifData), so decode it here.
const WHITE_BALANCE_LABELS: Record<number, string> = {
  0: "Auto",
  1: "Manual",
};
const toWhiteBalanceLabel = (value: unknown): string | undefined => {
  const num = toFiniteNumber(value);
  if (num === undefined) return undefined;
  return WHITE_BALANCE_LABELS[num] ?? `Unknown (${num})`;
};

const exifFieldMapping = {
  description: {
    exifField: [
      "ImageDescription",
      "Caption-Abstract",
      "dc:description",
      "description",
    ],
    conversionFn: toDescriptionString,
  },
  dateTaken: [
    { exifField: "DateTimeOriginal", conversionFn: toExifDate },
    {
      exifField: ["photoshop:DateCreated", "xmp:CreateDate"],
      conversionFn: toExifDate,
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
  flash: { exifField: "Flash", conversionFn: toFlashFired },
  whiteBalance: { exifField: "WhiteBalance", conversionFn: toWhiteBalanceLabel },
  subjectDistance: {
    exifField: "SubjectDistance",
    conversionFn: (value) => toFiniteNumber(value),
  },
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
  // exifr strips the XMP namespace prefix from tags it doesn't recognize as a
  // known EXIF/IPTC field, so dc:subject / lr:hierarchicalSubject surface
  // unprefixed (subject / hierarchicalSubject) in practice — keep both forms.
  tags: ["Keywords", "dc:subject", "subject", "lr:hierarchicalSubject", "hierarchicalSubject"],
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
      // Some tools (older Windows Photo Gallery/Picasa-style taggers, some
      // IPTC-only workflows) write freeform tags/keywords to the IPTC IIM
      // "Keywords" (2:25) field rather than XMP dc:subject. exifr's `iptc`
      // segment parser defaults to `false` and was never enabled here, so
      // the "Keywords" alias in the `tags` field mapping below was dead —
      // it could never match anything. XMP dc:subject/hierarchicalSubject
      // (the common case) worked without this.
      iptc: true,
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

  if (mimeType === "image/heic" || mimeType === "image/heif") {
    const embeddedVideoLength = await findEmbeddedMotionPhotoLength(fullPath);
    if (embeddedVideoLength !== undefined) {
      metadata.embeddedVideoLength = embeddedVideoLength;
    }
  }

  return metadata as ExifMetadata;
};

/**
 * Detects a Google/Samsung Motion Photo embedded in a HEIC/HEIF file by
 * inspecting the ISOBMFF (HEIF) top-level box structure. Samsung wraps the
 * embedded MP4 in a custom `mpvd` box; reading only the 8-byte box headers
 * (size + type) lets us locate it without loading any media data into memory.
 *
 * The video is the raw MP4 starting immediately after the `mpvd` box header,
 * so videoLength = fileSize − (mpvdOffset + 8).
 *
 * Returns the byte length of the embedded video, or undefined if the file is
 * not a Samsung motion photo.
 */
const findEmbeddedMotionPhotoLength = async (
  fullPath: string,
): Promise<number | undefined> => {
  const fh = await open(fullPath, "r");
  try {
    const { size } = await fh.stat();
    const hdr = Buffer.alloc(8);
    let offset = 0;
    while (offset + 8 <= size) {
      await fh.read(hdr, 0, 8, offset);
      const boxSize = hdr.readUInt32BE(0);
      const boxType = hdr.slice(4, 8).toString("ascii");
      if (boxType === "mpvd") {
        const videoLength = size - (offset + 8);
        return videoLength > 0 ? videoLength : undefined;
      }
      if (boxSize < 8 || boxSize > size - offset) break;
      offset += boxSize;
    }
    return undefined;
  } finally {
    await fh.close();
  }
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
