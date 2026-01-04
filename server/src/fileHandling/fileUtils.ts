/* eslint-disable @typescript-eslint/no-explicit-any */
import exifr from "exifr";
import { readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { ExifMetadata, FileInfo } from "../indexDatabase/fileRecord.type.ts";
import { getVideoMetadata } from "../videoProcessing/videoUtils.ts";
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
 * Convert GPS coordinates from DMS array to decimal degrees
 */
const convertMetadataLocationToDecimalDegrees = (input: unknown): number|undefined => {
  if (typeof input === 'number') {
    return input;
  }
  if (Array.isArray(input) && input.length >= 2) {
    const [degrees, minutes, seconds = 0] = input;
    if (typeof degrees === 'number' && typeof minutes === 'number' && typeof seconds === 'number') {
      return degrees + minutes / 60 + seconds / 3600;
    }
  }
  return undefined;
};

export const getExifMetadataFromFile = async (
  fullPath: string,
): Promise<ExifMetadata> => {
  const mimeType = mimeTypeForFilename(fullPath);
  if (mimeType?.startsWith("video/")) {
    return (await getVideoMetadata(fullPath)) as ExifMetadata;
  }

  /** If multiple exifR metadata points to the same file field,
   * it takes the last field that has a value
   */
  const exifRMetadataToFileField = {
    // Standard EXIF fields
    DateTimeOriginal: "dateTaken", // Prefer file-based date taken
    ImageWidth: "dimensionWidth",
    ImageHeight: "dimensionHeight",
    ExifImageWidth: "dimensionWidth",
    ExifImageHeight: "dimensionHeight",
    GPSLatitude: {fileField:"locationLatitude", conversionFn: convertMetadataLocationToDecimalDegrees},
    GPSLongitude: {fileField:"locationLongitude", conversionFn: convertMetadataLocationToDecimalDegrees},
    Make: "cameraMake",
    Model: "cameraModel",
    ExposureTime: "exposureTime",
    Aperture: "aperture",
    ISO: "iso",
    FocalLength: "focalLength",
    'aux:Lens': 'lens',
    'exifEX:LensModel': 'lens',
    Lens: "lens",
    Duration: "duration",
    FrameRate: "framerate",
    VideoCodec: "videoCodec",
    AudioCodec: "audioCodec",
    RatingPercent: {fileField: 'rating', conversionFn: (v)=>Math.round(v / 20)},
    Rating: "rating",
    Keywords: "tags",
    Orientation: "orientation",
    
    // Lightroom and other fields
    'photoshop:DateCreated':  {fileField:"dateTaken", conversionFn: d=>new Date(d)},
    'xmp:CreateDate': {fileField:"dateTaken", conversionFn: d=>new Date(d)},
    "xmp:Rating": "rating",
    "dc:subject": "tags",
    "lr:hierarchicalSubject": "tags",
  } as const satisfies {
    [key: string]: (keyof ExifMetadata | {fileField: keyof ExifMetadata, conversionFn: (val: any)=>ExifMetadata[keyof ExifMetadata]});
  };

  // Only read the specific fields we need - exifr will only parse those sections
  const fieldsToRequest = Object.keys(exifRMetadataToFileField);
  const rawData = await exifr.parse(fullPath, {
    pick: fieldsToRequest,
    translateValues: false,
    xmp: true,  // Enable XMP parsing for Lightroom ratings
    ifd0: {},
    exif: {},
    gps: {},
  });

  const metadata = Object.fromEntries(Object.entries(exifRMetadataToFileField)
    .map(([exifField, opts])=>({exifField, exifValue: rawData?.[exifField as keyof typeof rawData], opts}))
    .filter(p=>p.exifValue !== undefined)
    .map(({exifField, exifValue, opts})=>{
      const {fileField, conversionFn} = typeof opts === 'object'?opts:{fileField:opts};
      return [fileField,conversionFn && exifField !== undefined ? conversionFn(exifValue):exifValue];
    })
  );

  return metadata;
};


/**
 * Throws if absolute is outside of root.
 */
export const toRelative = (root: string, absolute: string): string => {
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..")) {
    throw new Error(`Path ${absolute} is outside of root ${root}`);
  }
  const normalized = relative.split(path.sep).join("/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
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
