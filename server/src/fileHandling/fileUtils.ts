import exifr from "exifr";
import { stat } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { AIMetadata, ExifMetadata, FaceMetadata, FileInfo } from "../indexDatabase/fileRecord.type.ts";
import path from "node:path";
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

export const getExifMetadataFromFile = async (
  fullPath: string,
): Promise<ExifMetadata> => {
  const mimeType = mimeTypeForFilename(fullPath);
  if (mimeType?.startsWith("video/")) {
    return (await getVideoMetadata(fullPath)) as ExifMetadata;
  }

  const exifRMetadataToFileField = {
    // Standard EXIF fields
    DateTimeOriginal: "dateTaken",
    ImageWidth: "dimensionWidth",
    ImageHeight: "dimensionHeight",
    ExifImageWidth: "dimensionWidth",
    ExifImageHeight: "dimensionHeight",
    GPSLatitude: "locationLatitude",
    GPSLongitude: "locationLongitude",
    Make: "cameraMake",
    Model: "cameraModel",
    ExposureTime: "exposureTime",
    Aperture: "aperture",
    ISO: "iso",
    FocalLength: "focalLength",
    Lens: "lens",
    Duration: "duration",
    FrameRate: "framerate",
    VideoCodec: "videoCodec",
    AudioCodec: "audioCodec",
    Rating: "rating",
    Keywords: "tags",
    Orientation: "orientation",
    
    // Lightroom XMP fields
    "xmp:Rating": "rating",
    "xmp:CreateDate": "dateTaken",
    "photoshop:DateCreated": "dateTaken",
    "dc:subject": "tags",
    "lr:hierarchicalSubject": "tags",
  } as const satisfies {
    [key: string]: keyof ExifMetadata;
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

  const metadata = Object.entries(exifRMetadataToFileField).reduce((acc, [key, value]) => {
    const rawValue = rawData?.[key as keyof typeof rawData];

    if (rawValue === undefined) {
      return acc;
    }

    return {
      ...acc,
      [value]: rawValue,
    };
  }, {} as ExifMetadata);

  // Convert GPS coordinates from DMS array to decimal degrees
  const convertDMSToDecimal = (dms: unknown): number | undefined => {
    if (typeof dms === 'number') {
      return dms; // Already in decimal format
    }
    if (Array.isArray(dms) && dms.length >= 2) {
      const [degrees, minutes, seconds = 0] = dms;
      if (typeof degrees === 'number' && typeof minutes === 'number' && typeof seconds === 'number') {
        return degrees + minutes / 60 + seconds / 3600;
      }
    }
    return undefined;
  };

  if (metadata.locationLatitude !== undefined) {
    const latitude = convertDMSToDecimal(metadata.locationLatitude);
    if (latitude !== undefined) {
      metadata.locationLatitude = latitude;
    } else {
      delete metadata.locationLatitude;
    }
  }

  if (metadata.locationLongitude !== undefined) {
    const longitude = convertDMSToDecimal(metadata.locationLongitude);
    if (longitude !== undefined) {
      metadata.locationLongitude = longitude;
    } else {
      delete metadata.locationLongitude;
    }
  }

  // Additional Lightroom XMP field conversions
  if (rawData) {
    // Rating: Check for RatingPercent (0-100 scale)
    if (!metadata.rating) {
      const ratingPercent = rawData['RatingPercent'];
      if (typeof ratingPercent === 'number') {
        metadata.rating = Math.round(ratingPercent / 20);
      }
    }
    
    // Tags: Merge all tag sources
    const allTags = new Set<string>(metadata.tags || []);
    
    // Lightroom hierarchical subjects (pipe-separated paths like "Nature|Landscapes")
    const hierarchicalSubjects = rawData['lr:hierarchicalSubject'];
    if (hierarchicalSubjects) {
      const subjects = Array.isArray(hierarchicalSubjects) ? hierarchicalSubjects : [hierarchicalSubjects];
      subjects.forEach((subject: string) => {
        // Split hierarchical tags and add both full path and leaf
        const parts = subject.split('|');
        allTags.add(subject); // Full hierarchical path
        allTags.add(parts[parts.length - 1]); // Leaf tag
      });
    }
    
    // IPTC keywords
    const iptcKeywords = rawData['Iptc4xmpCore:Keywords'];
    if (iptcKeywords) {
      const keywords = Array.isArray(iptcKeywords) ? iptcKeywords : [iptcKeywords];
      keywords.forEach((kw: string) => allTags.add(kw));
    }
    
    if (allTags.size > 0) {
      metadata.tags = Array.from(allTags);
    }
    
    // Camera info: Check for Lightroom lens info
    if (!metadata.lens) {
      metadata.lens = rawData['aux:Lens'] || rawData['exifEX:LensModel'];
    }
    
    // Date taken: Prefer XMP dates if EXIF missing
    if (!metadata.dateTaken) {
      const xmpDate = rawData['xmp:CreateDate'] || rawData['photoshop:DateCreated'];
      if (xmpDate) {
        metadata.dateTaken = new Date(xmpDate);
      }
    }
  }

  // Note: Orientation-based dimension swapping is handled in rowToFileRecord when reading from DB
  // This keeps the raw EXIF dimensions in the database for accuracy

  return metadata;
};

export const getAIMetadataFromFile = async (_fullPath: string): Promise<AIMetadata> => {
  // not implemented yet
  return {};
};

export const getFaceMetadataFromFile = async (
  _fullPath: string,
): Promise<FaceMetadata> => {
  // not implemented yet
  return {};
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
