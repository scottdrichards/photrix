import { parse } from "exifr";
import { stat } from "node:fs/promises";
import { AIMetadata, ExifMetadata, FaceMetadata, FileInfo } from "./fileRecord.type.js";
import path from "node:path";

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
  const exifRMetadataToFileField = {
    DateTimeOriginal: "dateTaken",
    ImageWidth: "dimensions.width",
    ImageHeight: "dimensions.height",
    GPSLatitude: "location.latitude",
    GPSLongitude: "location.longitude",
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
  } as const satisfies {
    [key: string]: keyof ExifMetadata | `${keyof ExifMetadata}.${string}`;
  };

  const rawData = await parse(fullPath, Object.keys(exifRMetadataToFileField));

  return Object.entries(exifRMetadataToFileField).reduce((acc, [key, value]) => {
    const [mainKey, subkey] = value.split(".") as [keyof ExifMetadata, string?];

    const rawValue = rawData?.[key as keyof typeof rawData];

    if (subkey) {
      // Handle nested properties like 'dimensions.width'
      return {
        ...acc,
        [mainKey]: {
          ...(acc[mainKey] as Record<string, unknown> | undefined),
          [subkey]: rawValue,
        },
      };
    }

    // Handle direct properties
    return {
      ...acc,
      [mainKey]: rawValue,
    };
  }, {} as ExifMetadata);
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
export const toRelative = (root: string, absolute: string): string=> {
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..")) {
      throw new Error(`Path ${absolute} is outside of root ${root}`);
  }
  return relative.split(path.sep).join("/");
};
