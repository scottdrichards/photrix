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
      { name: "created", type: "INTEGER" },
      { name: "modified", type: "INTEGER" },
      { name: "dateTaken", type: "INTEGER", indexExpression: "dateTaken DESC" },
      { name: "dimensionsWidth", type: "INTEGER" },
      { name: "dimensionsHeight", type: "INTEGER" },
      { name: "locationLatitude", type: "REAL" },
      { name: "locationLongitude", type: "REAL" },
      { name: "cameraMake", type: "TEXT" },
      { name: "cameraModel", type: "TEXT" },
      { name: "exposureTime", type: "REAL" },
      { name: "aperture", type: "REAL" },
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
      { name: "infoProcessedAt", type: "INTEGER", indexExpression: true },
      { name: "exifProcessedAt", type: "INTEGER", indexExpression: true },
      { name: "imageVariantsGeneratedAt", type: "INTEGER", indexExpression: true },
      { name: "hlsGeneratedAt", type: "INTEGER", indexExpression: true },
      { name: "facesProcessedAt", type: "INTEGER", indexExpression: true },
      { name: "facesLastErrorAt", type: "INTEGER", indexExpression: true },
      { name: "imageEmbedding", type: "BLOB" },
      { name: "embeddingProcessedAt", type: "INTEGER", indexExpression: true },
      { name: "embeddingErrorAt", type: "INTEGER", indexExpression: true },
      { name: "analysisDecodeErrorAt", type: "INTEGER", indexExpression: true },
      { name: "audioTranscript", type: "TEXT" },
      { name: "audioTranscribedAt", type: "INTEGER", indexExpression: true },
      { name: "audioTranscribeErrorAt", type: "INTEGER", indexExpression: true },
      { name: "audioEmbedding", type: "BLOB" },
      { name: "audioEmbeddingProcessedAt", type: "INTEGER", indexExpression: true },
      { name: "audioEmbeddingErrorAt", type: "INTEGER", indexExpression: true },
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
        // Renamed from idx_images_needing_faces to add the analysisDecodeErrorAt
        // exclusion — prepareTables drops the old index and creates this one.
        name: "idx_images_needing_faces_v2",
        expression: "mimeType, facesProcessedAt",
        where:
          "mimeType LIKE 'image/%' AND facesProcessedAt IS NULL AND analysisDecodeErrorAt IS NULL",
      },
      {
        // Serves the default library ordering. The folder/fileName tiebreakers are
        // part of the index so `ORDER BY COALESCE(...) DESC, folder, fileName LIMIT N`
        // is satisfied by an index walk — no full scan + temp B-tree sort.
        //
        // Renamed from `sort_date` (which was a single-expression index): the index
        // names are stable keys, so bumping the name lets prepareTables drop the old
        // index and build this wider one. Plain `CREATE INDEX IF NOT EXISTS` under
        // the same name would have left the old definition in place.
        name: "sort_date_v2",
        expression: "COALESCE(dateTaken, created, modified) DESC, folder, fileName",
      },
    ],
  },
  faces: {
    columns: [
      { name: "id", type: "INTEGER", isPrimaryKey: true },
      { name: "folder", type: "TEXT" },
      { name: "fileName", type: "TEXT" },
      { name: "boxX", type: "REAL" },
      { name: "boxY", type: "REAL" },
      { name: "boxWidth", type: "REAL" },
      { name: "boxHeight", type: "REAL" },
      { name: "confidence", type: "REAL" },
      { name: "embedding", type: "BLOB" },
      { name: "personId", type: "INTEGER", indexExpression: true },
      { name: "detectedAt", type: "INTEGER" },
    ],
    compositeIndexes: [
      {
        name: "by_file",
        expression: "folder, fileName",
      },
    ],
  },
  audioSegments: {
    columns: [
      { name: "id", type: "INTEGER", isPrimaryKey: true },
      { name: "folder", type: "TEXT" },
      { name: "fileName", type: "TEXT" },
      { name: "startTime", type: "REAL" },
      { name: "endTime", type: "REAL" },
      { name: "text", type: "TEXT" },
    ],
    compositeIndexes: [
      {
        name: "by_file",
        expression: "folder, fileName",
      },
    ],
  },
} as const satisfies Record<string, TableDefinition>;
