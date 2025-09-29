type Filter = {
  /** Path matchers (glob or exact). */
  path?: string[];

  /** Geographic bounding box filter (inclusive). Use decimal degrees. */
  location?: {
    minLatitude?: number;
    maxLatitude?: number;
    minLongitude?: number;
    maxLongitude?: number;
  };

  /** Date range for when media was taken/created. ISO 8601 strings recommended. */
  dateRange?: {
    start?: string;
    end?: string;
  };

  rating?: number[] | { min?: number; max?: number };

  /** Tags to match. By default match any; server may support `matchAll` option. */
  tags?: string[];

  /** Free-text search over filename, description, etc. */
  q?: string;
};

type FileMetadata = {
  name: string;
  size: number; // bytes
  mimeType: string;
  // Use ISO string on the wire (e.g. 2025-09-29T12:00:00Z)
  dateCreated?: string;
};

type Location = {
  latitude: number;
  longitude: number;
};

type Dimensions = {
  width: number;
  height: number;
};

type MediaMetadata = {
  dimensions?: Dimensions;
  // ISO 8601 on the wire
  dateTaken?: string | null;
  location?: Location | null;
  rating?: number;
  tags?: string[];
};

type PhotoMetadata = MediaMetadata & {
  cameraMake?: string;
  cameraModel?: string;
  exposureTime?: string;
  aperture?: string;
  iso?: number;
  focalLength?: string;
  lens?: string;
};

type VideoMetadata = MediaMetadata & {
  duration?: number; // seconds
  framerate?: number;
  videoCodec?: string;
  audioCodec?: string;
};

// AllMetadata describes fields that may be available for a media item. Some
// fields are specific to photos vs videos; clients should request the
// metadata keys they need rather than relying on a large combined object.
type AllMetadata = FileMetadata & Partial<PhotoMetadata & VideoMetadata>;

// Representation describes the desired format for the returned file data.
// It's generic over the media type so certain options can be photo- or
// video-specific.
type Representation<T extends "photo" | "video"> =
  | { type: "resize"; maxWidth?: number; maxHeight?: number }
  | { type: "webSafe" }
  | { type: "original" }
  | { type: "metadata"; metadataKeys: Array<keyof AllMetadata> }
  | (T extends "photo" ? { type: "embedded-live-video" } : never)
  | (T extends "video" ? { type: "dash-manifest" } : never);

export type ApiSpecification = {
  /**
   * Find files matching the filter. The response is paginated and includes
   * a total count so clients can render simple pagination UIs.
   */
  findFiles: <T extends Array<keyof AllMetadata> | undefined = undefined>(
    filter?: Filter,
    options?: {
      sort?: {
        sortBy: "name" | "dateTaken" | "dateCreated" | "rating";
        order: "asc" | "desc";
      };
      metadata?: T; // list of metadata keys to include per item
      page?: number;
    }
  ) => Promise<{
    items: Array<{
      path: string;
      metadata?: T extends Array<keyof AllMetadata>
        ? Pick<AllMetadata, T[number]>
        : Partial<AllMetadata>;
    }>;
    total: number;
    page: number;
  }>;

  /**
   * Retrieve the raw file (or a representation). `representation` should be
   * chosen according to the media type for the path. For large videos the
   * implementation may support ranged requests or streaming.
   */
  file: <T extends "photo" | "video" = "photo">(
    path: string,
    options?: {
      representation?: Representation<T>;
      range?: { start?: number; end?: number };
    }
  ) => Promise<ArrayBuffer>;
};
