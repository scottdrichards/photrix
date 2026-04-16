import { AssertNever, UnionXOR } from "../utils.ts";

export type BaseFileRecord = {
  /** Uses '/' as separator, starts and ends with slash */
  folder: string;
  /** Includes extension */
  fileName: string;
  mimeType: string | null;
};

export type FileInfo = {
  sizeInBytes: number;
  created: Date;
  modified: Date;
};

export type ExifMetadata = {
  regions?: Array<{
    name?: string;
    type?: string;
    area?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    rotation?: number;
  }>;
  personInImage?: string[];
  dateTaken?: Date;
  dimensionWidth?: number;
  dimensionHeight?: number;
  locationLatitude?: number;
  locationLongitude?: number;
  cameraMake?: string;
  cameraModel?: string;
  exposureTime?: string;
  aperture?: string;
  iso?: number;
  focalLength?: string;
  lens?: string;
  duration?: number;
  framerate?: number;
  videoCodec?: string;
  audioCodec?: string;
  rating?: number;
  tags?: string[];
  orientation?: number;
  livePhotoVideoFileName?: string;
};

export type AIMetadata = {
  aiDescription?: string;
  aiTags?: string[];
};

export type AllMetaData = FileInfo & ExifMetadata & AIMetadata;

/**
 * Indicates how to acquire metadata for a file
 */
export const MetadataGroups = {
  info: ["sizeInBytes", "created", "modified"],
  exif: [
    "regions",
    "personInImage",
    "dateTaken",
    "dimensionWidth",
    "dimensionHeight",
    "locationLatitude",
    "locationLongitude",
    "cameraMake",
    "cameraModel",
    "exposureTime",
    "aperture",
    "iso",
    "focalLength",
    "lens",
    "duration",
    "framerate",
    "videoCodec",
    "audioCodec",
    "rating",
    "tags",
    "orientation",
    "livePhotoVideoFileName",
  ],
  aiMetadata: ["aiDescription", "aiTags"],
} as const satisfies Record<string, AllMetaData[keyof AllMetaData][]>;

/** Undefined means "I don't know", null means "I know there is no value
 * Generally, it is best to look at the presence of the `${MetadataGroup}ProcessedAt` fields to see if metadata has been processed
 */
export type FileRecord = BaseFileRecord &
  Partial<AllMetaData> & {
    [key in `${keyof typeof MetadataGroups}ProcessedAt`]?: string | null;
  };

///////////////////////////////////////////
// Validation

/**
 * This will verify that all metadata keys are assigned a group
 */
type AllMetadataKeysInGroups = UnionXOR<
  {
    [K in keyof typeof MetadataGroups]: (typeof MetadataGroups)[K][number];
  }[keyof typeof MetadataGroups],
  keyof ExifMetadata | keyof AIMetadata | keyof FileInfo
>;
type _ErrorsIfUnassignedMetadataKeys = AssertNever<AllMetadataKeysInGroups>;
