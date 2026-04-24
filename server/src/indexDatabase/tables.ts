export type TableColumn = {
  name: string;
  type: string;
  mustHaveValue?: boolean;
  default?: string | number | boolean | null;
  isPrimaryKey?: boolean;
  indexExpression?: true | string;
};

export type TableDefinition = {
  columns: TableColumn[];
  compositeIndexes: Array<{
    name: string;
    expression: string;
    unique?: boolean;
    where?: string;
  }>;
};

export const tables = {
  files: {
    columns: [
      { name: "folder", type: "TEXT", mustHaveValue: false, indexExpression: true },
      { name: "fileName", type: "TEXT", mustHaveValue: false },
      { name: "mimeType", type: "TEXT", indexExpression: true },
      { name: "sizeInBytes", type: "INTEGER" },
      { name: "created", type: "TEXT" },
      { name: "modified", type: "TEXT" },
      { name: "dateTaken", type: "TEXT", indexExpression: "dateTaken DESC" },
      { name: "dimensionsWidth", type: "INTEGER" },
      { name: "dimensionsHeight", type: "INTEGER" },
      { name: "locationLatitude", type: "REAL" },
      { name: "locationLongitude", type: "REAL" },
      { name: "cameraMake", type: "TEXT" },
      { name: "cameraModel", type: "TEXT" },
      { name: "exposureTime", type: "TEXT" },
      { name: "aperture", type: "TEXT" },
      { name: "iso", type: "INTEGER" },
      { name: "focalLength", type: "TEXT" },
      { name: "lens", type: "TEXT" },
      { name: "duration", type: "REAL" },
      { name: "framerate", type: "REAL" },
      { name: "videoCodec", type: "TEXT" },
      { name: "audioCodec", type: "TEXT" },
      { name: "rating", type: "INTEGER", indexExpression: true },
      { name: "tags", type: "TEXT" },
      { name: "personInImage", type: "TEXT" },
      { name: "regions", type: "TEXT" },
      { name: "orientation", type: "INTEGER" },
      { name: "livePhotoVideoFileName", type: "TEXT" },
      { name: "aiDescription", type: "TEXT" },
      { name: "aiTags", type: "TEXT" },
      { name: "fileHash", type: "TEXT" },
      { name: "infoProcessedAt", type: "TEXT", indexExpression: true },
      { name: "exifProcessedAt", type: "TEXT", indexExpression: true },
      { name: "imageVariantsGeneratedAt", type: "TEXT", indexExpression: true },
      { name: "hlsGeneratedAt", type: "TEXT", indexExpression: true },
    ],
    compositeIndexes: [
      {
        name: "idx_files_path",
        expression: "folder, fileName",
        unique: true,
      },
      {
        name: "idx_images_needing_conversion",
        expression: "mimeType, imageVariantsGeneratedAt, infoProcessedAt",
        where:
          "mimeType LIKE 'image/%' AND imageVariantsGeneratedAt IS NULL AND infoProcessedAt IS NOT NULL",
      },
      {
        name: "idx_videos_needing_hls",
        expression: "mimeType, hlsGeneratedAt, exifProcessedAt",
        where:
          "mimeType LIKE 'video/%' AND hlsGeneratedAt IS NULL AND exifProcessedAt IS NOT NULL",
      },
      {
        name: "sort_date",
        expression:
          "COALESCE(dateTaken, created, modified) DESC, folder ASC, fileName ASC",
      },
    ],
  },
} as const satisfies Record<string, TableDefinition>;
