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
      { name: "dateTaken", type: "INTEGER" },
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
        // Covering index for getDateRange/getDateHistogram: MIN/MAX and the
        // per-bucket GROUP BY run over dateTaken while the trailing
        // folder/fileName let filter EXISTS probes (which correlate on those
        // columns) stay inside the index. Without them each of the ~190k rows
        // is fetched to read folder/fileName, dragging the image/audio
        // embedding BLOB pages along (measured 6.8s vs 0.1s for the date-range
        // query under a face filter). Replaces the old single-column
        // idx_files_dateTaken, which prepareTables drops automatically.
        name: "dateTaken_range",
        expression: "dateTaken, folder, fileName",
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
      // Persistent cluster assignment (see faceClusterEngine.ts). NULL means
      // "not yet assigned" — the clustering backfill task picks those up.
      { name: "clusterId", type: "INTEGER" },
      // Cosine similarity to the cluster centroid at assignment time. Lets the
      // People queries pick representatives and order faces without reading
      // embedding BLOBs.
      { name: "clusterSimilarity", type: "REAL" },
    ],
    compositeIndexes: [
      {
        // Trailing clusterId makes the face-cluster filter's correlated EXISTS
        // (folder = ? AND fileName = ? AND clusterId = ?) an index-only probe.
        // Without clusterId in the index SQLite fetches each matching face row
        // to read clusterId, dragging a ~4 KB embedding BLOB page per row — the
        // difference between ~28s and sub-second on the whole library. The
        // (folder, fileName) prefix still serves plain per-file lookups.
        //
        // clusterSimilarity and id make the index cover the filtered People
        // queries too: queryFaceClusters/getFaceClusterDetail join the filtered
        // file set to faces and read those two columns, so with them in the
        // index the whole join is index-only (measured ~14s -> ~0.2s under a
        // face filter; without them every joined face row is fetched, dragging
        // its embedding BLOB pages).
        //
        // Renamed from `by_file_v2` so prepareTables drops the old index and
        // rebuilds this wider one (CREATE INDEX IF NOT EXISTS won't widen an
        // index that already exists under the same name).
        name: "by_file_v3",
        expression: "folder, fileName, clusterId, clusterSimilarity, id",
      },
      {
        // Serves the clustering backfill's "next unassigned faces, best
        // detections first" query without scanning assigned rows.
        name: "needing_cluster",
        expression: "confidence DESC",
        where: "clusterId IS NULL AND LENGTH(embedding) > 0",
      },
      {
        // Covering index for the People queries: the per-cluster COUNT +
        // MAX(clusterSimilarity) aggregation and the similarity-ordered detail
        // listing run entirely inside this index. Without it the aggregation
        // fetches every face row — and each row fetch drags a ~4 KB embedding
        // BLOB page off disk (measured 4.8s vs 0.1s over 316k faces).
        name: "by_cluster",
        expression: "clusterId, clusterSimilarity DESC, id",
        where: "clusterId > 0",
      },
    ],
  },
  faceClusters: {
    columns: [
      { name: "id", type: "INTEGER", isPrimaryKey: true },
      // Unnormalized running mean of the member faces' unit embedding vectors,
      // serialized as Float32 (the face model itself only produces 32-bit
      // precision). Normalizing this gives the cluster centroid.
      { name: "centroid", type: "BLOB" },
      // Number of vectors folded into `centroid` — the divisor for the running
      // mean. Deliberately not reconciled with live face counts (see
      // faceClusterEngine.ts); displayed counts always come from GROUP BY.
      { name: "weight", type: "INTEGER" },
      // The similarity threshold the assignments were computed with. If the
      // code's threshold constant changes, existing assignments are invalid and
      // the engine resets them for the backfill to redo.
      { name: "threshold", type: "REAL" },
      { name: "updatedAt", type: "INTEGER" },
    ],
    compositeIndexes: [],
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
