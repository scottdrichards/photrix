export type TableColumn = {
  name: string;
  type: string;
  mustHaveValue?: boolean;
  default?: unknown;
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
    ],
    compositeIndexes: [
      {
        name: "idx_files_path",
        expression: "folder, fileName",
        unique: true,
      },
    ],
  },
  conversion_tasks: {
    columns: [
      { name: "folder", type: "TEXT", isPrimaryKey: true },
      { name: "fileName", type: "TEXT", isPrimaryKey: true },
      { name: "taskType", type: "TEXT", isPrimaryKey: true },
      { name: "priority", type: "INTEGER" },
      { name: "prioritySetAt", type: "TEXT" },
    ],
    compositeIndexes: [
      {
        name: "idx_conversion_tasks_queue",
        expression: "taskType, priority ASC, prioritySetAt ASC, folder, fileName",
        where: "priority >= 0",
      },
    ],
  },
} as const satisfies Record<string, TableDefinition>;
