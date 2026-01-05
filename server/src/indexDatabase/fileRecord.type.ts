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
};

export type AIMetadata = {
  aiDescription?: string;
  aiTags?: string[];
};

type Person = {
  id: string;
  name?: string;
};

export type FaceTag = {
  dimensions: { x: number; y: number; width: number; height: number };
  /** The output of a face detection algorithm */
  featureDescription: unknown;
  person: Person | null;
  status?: "unverified" | "confirmed";
};

export type FaceMetadata = {
  faceTags?: FaceTag[];
};

export type AllMetaData = FileInfo & ExifMetadata & AIMetadata & FaceMetadata;

/**
 * Indicates how to acquire metadata for a file
 */
export const MetadataGroups = {
  info: ["sizeInBytes", "created", "modified"],
  exif: [
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
    "orientation"
  ],
  aiMetadata: ["aiDescription", "aiTags"],
  faceMetadata: ["faceTags"],
} as const satisfies Record<string, AllMetaData[keyof AllMetaData][]>;
/**
 * This will verify that all metadata keys are assigned a group
 */
type AllMetadataKeysInGroups = UnionXOR<
  {
    [K in keyof typeof MetadataGroups]: (typeof MetadataGroups)[K][number];
  }[keyof typeof MetadataGroups],
  keyof ExifMetadata | keyof AIMetadata | keyof FaceMetadata | keyof FileInfo
>;
type _ErrorsIfUnassignedMetadataKeys = AssertNever<AllMetadataKeysInGroups>;

/** Undefined means "I don't know", null means "I know there is no value
 * Generally, it is best to look at the presence of the `${MetadataGroup}ProcessedAt` fields to see if metadata has been processed
*/
export type FileRecord = BaseFileRecord & Partial<AllMetaData> & {
  [key in `${keyof typeof MetadataGroups}ProcessedAt`]?: string | null;
};