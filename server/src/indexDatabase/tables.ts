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
      // indexExpression on cameraMake/cameraModel/lens: the filter panel's
      // suggestions dropdown runs SELECT DISTINCT .../GROUP BY over these
      // columns, and without an index that's a full `files` scan — every row
      // fetched drags its ~4-32 KB imageEmbedding/audioEmbedding BLOB pages
      // along (same drag pattern as dateTaken_range/by_file_v4). Measured
      // ~29s -> a few ms over 191k rows. A single-column index still lets
      // SQLite answer the DISTINCT/GROUP BY as an index-only scan even though
      // the `LIKE '%term%'` predicate itself can't seek the index (leading
      // wildcard) — it just avoids ever touching the main table row.
      { name: "cameraMake", type: "TEXT", indexExpression: true },
      { name: "cameraModel", type: "TEXT", indexExpression: true },
      { name: "exposureTime", type: "REAL" },
      { name: "aperture", type: "REAL" },
      { name: "iso", type: "INTEGER" },
      { name: "focalLength", type: "TEXT" },
      { name: "lens", type: "TEXT", indexExpression: true },
      // Decoded from the EXIF Flash bitmask's low bit: 1 = flash fired, 0 = did not.
      { name: "flash", type: "INTEGER" },
      // Decoded EXIF WhiteBalance enum, e.g. "Auto" / "Manual".
      { name: "whiteBalance", type: "TEXT" },
      // EXIF SubjectDistance in meters.
      { name: "subjectDistance", type: "REAL" },
      { name: "duration", type: "REAL" },
      { name: "framerate", type: "REAL" },
      { name: "videoCodec", type: "TEXT" },
      { name: "audioCodec", type: "TEXT" },
      { name: "rating", type: "INTEGER", indexExpression: true },
      { name: "tags", type: "TEXT" },
      { name: "editAdj", type: "TEXT" },
      // Set to a timestamp when the user edits rating/tags in-app (DB-only; the
      // original files stay read-only). A future writeback task can find these
      // rows (userMetadataDirtyAt IS NOT NULL) and, if ever desired, persist the
      // edits into the file's own metadata, then clear this back to NULL.
      { name: "userMetadataDirtyAt", type: "INTEGER", indexExpression: true },
      { name: "personInImage", type: "TEXT" },
      { name: "regions", type: "TEXT" },
      { name: "orientation", type: "INTEGER" },
      { name: "livePhotoVideoFileName", type: "TEXT" },
      // Human-authored caption. Seeded from the file's embedded caption (EXIF
      // ImageDescription / IPTC Caption-Abstract / XMP dc:description) on first
      // EXIF scan; editable in-app thereafter via PATCH /api/files (same
      // DB-only-overlay pattern as `rating`/`tags` — the file itself is never
      // written). Distinct from the AI-generated `aiDescription`.
      { name: "description", type: "TEXT" },
      { name: "aiDescription", type: "TEXT" },
      { name: "aiTags", type: "TEXT" },
      // Whole-photo quality aggregate, 0..1, derived from this file's *scored*
      // faces' smileScore/eyesOpenScore/focusScore/exposureScore (see
      // faceDetection/photoQuality.ts — worst-face-wins, not an average, so a
      // group photo with one bad face reads as a bad photo). Recomputed
      // in-place whenever face attributes for this file are written (initial
      // detection or the attribute backfill), so it never needs its own
      // pipeline pass. NULL means "no signal yet" (no faces detected, or none
      // scored) — never treat NULL as "bad quality". Photos with no faces at
      // all are intentionally left NULL rather than scored from whole-frame
      // sharpness/exposure, which no part of this codebase currently derives
      // (see photoQuality.ts's doc comment for why that was scoped out).
      { name: "photoQualityScore", type: "REAL", indexExpression: true },
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
      // "Photo ready" attributes, each 0..1, all derived per face during image
      // analysis (see python/face_attributes.py). NULL means *unknown* — the
      // face predates the feature, or the attribute could not be judged (a
      // profile view tells you nothing about eye openness, a 30-pixel face
      // nothing about sharpness). Filters must never silently read NULL as a
      // failing score.
      { name: "smileScore", type: "REAL" },
      { name: "eyesOpenScore", type: "REAL" },
      { name: "focusScore", type: "REAL" },
      { name: "exposureScore", type: "REAL" },
      // Version of the attribute derivation that produced the four scores
      // above, or NULL for "never scored". This column *is* the backfill queue:
      // the attribute task claims NULL rows, and improving the algorithm is a
      // constant bump plus a one-time reset of rows below it (see
      // resetStaleFaceAttributes). Stamped even when every score came back
      // unknown, so an unjudgeable face is not retried forever.
      { name: "faceAttrVersion", type: "INTEGER" },
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
        // The four attribute scores are appended for the same reason: the
        // "photo ready" filter adds predicates on them *inside* the correlated
        // EXISTS, and any column it reads that isn't in the index turns the
        // index-only probe back into a row fetch — which is precisely the
        // embedding-BLOB drag this index exists to avoid. They cost ~1 byte per
        // face while NULL and 8 once scored.
        //
        // Renamed from `by_file_v3` (itself from `by_file_v2`) so prepareTables
        // drops the old index and rebuilds this wider one — CREATE INDEX IF NOT
        // EXISTS won't widen an index that already exists under the same name.
        name: "by_file_v4",
        expression:
          "folder, fileName, clusterId, clusterSimilarity, id, smileScore, eyesOpenScore, focusScore, exposureScore",
      },
      {
        // Drives the attribute backfill's "next files with unscored faces"
        // query. Partial, so it covers only outstanding work and shrinks to
        // nothing as the backfill completes; ordered by (folder, fileName) so
        // `SELECT DISTINCT folder, fileName ... LIMIT n` is an index walk that
        // stops at n rather than grouping the whole table.
        name: "needing_attributes",
        expression: "folder, fileName",
        where: "faceAttrVersion IS NULL",
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
      // The `weight` value at the last time member faces' stored
      // `clusterSimilarity` was recomputed against this centroid. Assignment
      // writes each similarity relative to the centroid *as it was when the
      // face joined*, so the seed (stored as 1.0) and early joiners keep
      // inflated scores as the running mean drifts. The background refresh
      // (see faceClusterEngine.refreshStaleClusterSimilarities) rescoring
      // members against the current centroid advances this so the People tab's
      // MAX(clusterSimilarity) representative tracks the real centroid. Default
      // 0 makes every pre-existing cluster eligible on first pass.
      { name: "similarityRefreshedWeight", type: "INTEGER", default: 0 },
      // User-assigned display name for this cluster.
      { name: "name", type: "TEXT" },
      // When set, this centroid belongs to the named/merged person rooted at
      // `personId`. Unadopted centroids keep this NULL.
      { name: "personId", type: "INTEGER", indexExpression: true },
    ],
    compositeIndexes: [],
  },
  faceClusterMerges: {
    columns: [
      { name: "sourceClusterId", type: "INTEGER", isPrimaryKey: true },
      { name: "targetClusterId", type: "INTEGER" },
      { name: "sourceCount", type: "INTEGER" },
      { name: "sourceName", type: "TEXT" },
      { name: "mergedAt", type: "INTEGER" },
    ],
    compositeIndexes: [
      {
        name: "by_target",
        expression: "targetClusterId, mergedAt DESC",
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
  auth_sessions: {
    columns: [
      { name: "token", type: "TEXT", isPrimaryKey: true },
      { name: "username", type: "TEXT" },
      { name: "createdAt", type: "INTEGER" },
      // Best-effort client address at login time (X-Forwarded-For's first hop
      // behind a reverse proxy, else the raw socket address). Used to show a
      // coarse "local network vs internet" hint per session in account settings.
      { name: "ip", type: "TEXT" },
      // Refreshed (throttled) whenever the session authenticates a request, so
      // stale-but-never-revoked sessions can be told apart from active ones.
      { name: "lastSeenAt", type: "INTEGER" },
    ],
    compositeIndexes: [],
  },
  webauthn_credentials: {
    columns: [
      { name: "credentialId", type: "TEXT", isPrimaryKey: true },
      { name: "username", type: "TEXT", indexExpression: true },
      { name: "publicKey", type: "TEXT" },
      { name: "counter", type: "INTEGER" },
      { name: "transports", type: "TEXT" },
      { name: "name", type: "TEXT" },
      { name: "createdAt", type: "INTEGER" },
    ],
    compositeIndexes: [],
  },
  // Personal, long-lived API tokens ("MCP keys") a user mints to authenticate
  // remote agents. Distinct from short-lived interactive auth_sessions.
  api_tokens: {
    columns: [
      { name: "token", type: "TEXT", isPrimaryKey: true },
      { name: "username", type: "TEXT", indexExpression: true },
      { name: "name", type: "TEXT" },
      { name: "createdAt", type: "INTEGER" },
      { name: "lastUsedAt", type: "INTEGER" },
    ],
    compositeIndexes: [],
  },
  // Tracks issued stateless share tokens so the owner can list and revoke them.
  // The full token is stored so the panel can re-copy the link; revokedAt marks
  // a revoked link (its digest is also loaded into the in-memory revocation set).
  share_links: {
    columns: [
      { name: "token", type: "TEXT", isPrimaryKey: true },
      { name: "username", type: "TEXT", indexExpression: true },
      { name: "label", type: "TEXT" },
      { name: "createdAt", type: "INTEGER" },
      { name: "revokedAt", type: "INTEGER" },
    ],
    compositeIndexes: [],
  },
  feedback: {
    columns: [
      { name: "id", type: "INTEGER", isPrimaryKey: true },
      { name: "text", type: "TEXT" },
      { name: "createdAt", type: "INTEGER", indexExpression: true },
    ],
    compositeIndexes: [],
  },
} as const satisfies Record<string, TableDefinition>;
