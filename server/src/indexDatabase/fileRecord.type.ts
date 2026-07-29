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
  /** Human-authored caption. Seeded from the file's EXIF/IPTC/XMP on first
   * scan; also user-editable in-app thereafter (DB-only overlay, like
   * `rating`/`tags`). See `aiDescription` on {@link AIMetadata} for the
   * machine-generated counterpart. */
  description?: string;
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
  /** Whether the flash fired (decoded from the EXIF `Flash` bitmask's low bit). */
  flash?: boolean;
  /** e.g. "Auto" / "Manual" (decoded from the EXIF `WhiteBalance` enum). */
  whiteBalance?: string;
  /** Subject distance in meters, from the EXIF `SubjectDistance` tag. */
  subjectDistance?: number;
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
  /** Derived whole-photo quality aggregate, 0..1; see photoQuality.ts. Absent
   * until at least one detected face has been scored for "photo ready"
   * attributes. */
  photoQualityScore?: number;
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
    "description",
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
    "flash",
    "whiteBalance",
    "subjectDistance",
    "duration",
    "framerate",
    "videoCodec",
    "audioCodec",
    "rating",
    "tags",
    "orientation",
    "livePhotoVideoFileName",
  ],
  aiMetadata: ["aiDescription", "aiTags", "photoQualityScore"],
  faces: [],
} as const satisfies Record<string, AllMetaData[keyof AllMetaData][]>;

/** Undefined means "I don't know", null means "I know there is no value
 * Generally, it is best to look at the presence of the `${MetadataGroup}ProcessedAt` fields to see if metadata has been processed
 */
export type FileRecord = BaseFileRecord &
  Partial<AllMetaData> & {
    [key in `${keyof typeof MetadataGroups}ProcessedAt`]?: string | null;
  } & {
    imageVariantsGeneratedAt?: string | null;
    hlsGeneratedAt?: string | null;
    facesLastErrorAt?: string | null;
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
