export type BaseFileRecord = {
  /** Includes filename and extension. Uses '/' as a separator and does not start with slash */
  relativePath: string;
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

/**
 * This is separate because each of these might be a touch expensive to determine
 * so we have a determinedOn timestamp to know its freshness.
 */
export type MetadataGroups = {
  info: FileInfo;
  exifMetadata: ExifMetadata;
  aiMetadata: AIMetadata;
  faceMetadata: FaceMetadata;
};

export const MetadataGroupKeys = {
  info: ["sizeInBytes", "created", "modified"],
  exifMetadata: [
    "dateTaken",
    "dimensions",
    "location",
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
} as const;
/**
 * This will verify that all metadata keys are included in the respective key lists.
 */
type _EnsureAllMetadataKeysListed = AssertTrue<
  AreUnionsEqual<MetadataPropertyUnion, MetadataGroupKeyUnion>
>;

type EntryProperties = {
  /** Timestamp when EXIF data was last attempted/retrieved */
  exifProcessedAt?: string;
  /** Timestamp when thumbnails were last attempted/generated */
  thumbnailsProcessedAt?: string;
}

type OptionalToNullable<T extends object> = {
  [K in T]: undefined in T[K]
}

/** Flat representation of a DB row. Undefined means "I don't know", null means "I know there is no value*/
export type DatabaseFileEntry = BaseFileRecord & MetadataGroups[keyof MetadataGroups] & EntryProperties;

/////////////////////////
// This section is just to ensure no metadata key collisions occur when creating FileRecord type.
/////////////////////////

type MetadataCollisionKeys<T extends Record<PropertyKey, object>> = {
  [K1 in keyof T]: {
    [K2 in Exclude<keyof T, K1>]: keyof T[K1] & keyof T[K2];
  }[Exclude<keyof T, K1>];
}[keyof T];

type IsNever<T> = [T] extends [never] ? true : false;
type AssertTrue<T extends true> = T;

type _EnsureNoMetadataKeyCollisions = AssertTrue<
  // IF THIS ERRORS, that means you have two keys with the same name in different metadata sections.
  IsNever<MetadataCollisionKeys<MetadataGroups>>
>;

type AreUnionsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;


type MetadataPropertyUnion = {
  [K in keyof MetadataGroups]: keyof MetadataGroups[K];
}[keyof MetadataGroups];

type MetadataGroupKeyUnion = {
  [K in keyof typeof MetadataGroupKeys]: (typeof MetadataGroupKeys)[K][number];
}[keyof typeof MetadataGroupKeys];

