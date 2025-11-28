import exifr from "exifr";
import { stat } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { AIMetadata, ExifMetadata, FaceMetadata, FileInfo } from "../indexDatabase/fileRecord.type.ts";
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
    Orientation: "orientation",
  } as const satisfies {
    [key: string]: keyof ExifMetadata | `${keyof ExifMetadata}.${string}`;
  };

  // Only read the specific fields we need - exifr will only parse those sections
  // We also need Orientation to correctly determine dimensions
  const fieldsToRequest = [...Object.keys(exifRMetadataToFileField), "Orientation"];
  const rawData = await exifr.parse(fullPath, {
    pick: fieldsToRequest,
    translateValues: false,
  });

  const metadata = Object.entries(exifRMetadataToFileField).reduce((acc, [key, value]) => {
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

  // Orientation 5-8 means the image is rotated 90 or 270 degrees, so width and height are swapped
  if (metadata.dimensions && [5, 6, 7, 8].includes(rawData?.Orientation)) {
      const { width, height } = metadata.dimensions;
      metadata.dimensions = { width: height, height: width };
  }

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
  return relative.split(path.sep).join("/");
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
