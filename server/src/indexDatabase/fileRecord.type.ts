import { AssertNever, UnionXOR } from "../utils.ts";
import { FileRecord } from "./indexDatabase.type.ts";

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

export const MetadataGroups = {
  info: ["sizeInBytes", "created", "modified"],
  exifMetadata: [
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
} as const satisfies Record<string, readonly (keyof FileRecord)[]>;

/**
 * Determines which metadata group a given field belongs to.
 */
export const whichMetadataGroup = (field: keyof FileRecord) => 
  Object.keys(MetadataGroups).find(groupKey => 
    (MetadataGroups as Record<string, readonly string[]>)[groupKey].includes(field)
  ) as keyof typeof MetadataGroups;


/** DB row. Undefined means "I don't know", null means "I know there is no value*/
export type DatabaseEntry = BaseFileRecord & FileInfo & ExifMetadata & AIMetadata & FaceMetadata;

/////////////////////////
// This section is just to do some extra static type checking.
/////////////////////////

/**
 * This will verify that all metadata keys are assigned a group if necessary.
 */
type MissingKeys = UnionXOR<MetadataKeysThatRequireWork, AllMetadataKeysInGroups>;
type _EnsureAllMetadataKeysListed = AssertNever<MissingKeys>;

type MetadataKeysThatRequireWork = Exclude<keyof FileRecord, keyof BaseFileRecord>;

type AllMetadataKeysInGroups = {
  [K in keyof typeof MetadataGroups]: (typeof MetadataGroups)[K][number];
}[keyof typeof MetadataGroups];

