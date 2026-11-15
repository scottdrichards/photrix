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
  /** Byte length of the MP4 video embedded at the tail of a HEIC motion photo (Google/Samsung format). */
  embeddedVideoLength?: number;
};
