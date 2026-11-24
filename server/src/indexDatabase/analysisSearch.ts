import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { type FileRecord } from "./fileRecord.type.ts";
import { filterToSQL } from "./filterToSQL.ts";
import { type FilterElement } from "./indexDatabase.type.ts";
import { rowToFileRecord } from "./rowFileRecordConversionFunctions.ts";
import { escapeLikeLiteral } from "./utils/sqlUtils.ts";
import { VectorIndex } from "./vectorIndex/vectorIndex.ts";
import type { EmbeddingKind } from "./vectorIndex/vectorIndexProtocol.ts";
import { clamp01 } from "../common/clamp01.ts";
import { encodeEmbedding } from "./embeddingCodec.ts";

const normalizeTranscriptSearchText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokenizeTranscriptSearchText = (value: string): string[] => [
  ...new Set(normalizeTranscriptSearchText(value).split(" ").filter(Boolean)),
];

const countWholeWordOccurrences = (text: string, term: string): number => {
  if (!text || !term) return 0;

  let matches = 0;
  let fromIndex = 0;
  while (true) {
    const index = text.indexOf(term, fromIndex);
    if (index === -1) return matches;

    const beforeOk = index === 0 || text[index - 1] === " ";
    const afterIndex = index + term.length;
    const afterOk = afterIndex === text.length || text[afterIndex] === " ";
    if (beforeOk && afterOk) {
      matches += 1;
    }
    fromIndex = index + term.length;
  }
};

const scoreTranscriptMatch = (query: string, transcript: string): number => {
  const normalizedQuery = normalizeTranscriptSearchText(query);
  const normalizedTranscript = normalizeTranscriptSearchText(transcript);
  const terms = tokenizeTranscriptSearchText(normalizedQuery);
  if (!normalizedQuery || !normalizedTranscript || terms.length === 0) return 0;

  const termOccurrences = terms.map((term) =>
    countWholeWordOccurrences(normalizedTranscript, term),
  );
  const matchedTerms = termOccurrences.filter((count) => count > 0).length;
  if (matchedTerms === 0) return 0;
  if (terms.length > 1 && matchedTerms < terms.length) return 0;

  const phraseOccurrences = countWholeWordOccurrences(
    normalizedTranscript,
    normalizedQuery,
  );
  const extraOccurrences = Math.max(
    0,
    termOccurrences.reduce((sum, count) => sum + count, 0) - matchedTerms,
  );

  return clamp01(
    0.55 +
      (0.25 * matchedTerms) / terms.length +
      Math.min(0.12, phraseOccurrences * 0.12) +
      Math.min(0.08, extraOccurrences * 0.04),
  );
};

/** Semantic, transcript and metadata search over the analysis results. */
export class AnalysisSearch {
  constructor(
    private readonly db: AsyncSqlite,
    private readonly vectorIndex: VectorIndex,
  ) {}

  async audioSemanticSearch(
    queryVector: Float32Array,
    filter: FilterElement,
    limit: number,
  ): Promise<Array<FileRecord & { similarity: number }>> {
    return this.vectorSearch(
      "audio",
      queryVector,
      "((mimeType LIKE 'video/%' AND audioCodec IS NOT NULL) OR mimeType LIKE 'audio/%')",
      filter,
      limit,
    );
  }

  async audioTranscriptSearch(
    query: string,
    filter: FilterElement,
    limit: number,
  ): Promise<Array<FileRecord & { similarity: number }>> {
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const terms = tokenizeTranscriptSearchText(query);
    if (terms.length === 0) {
      return [];
    }

    const candidateLimit = Math.min(Math.max(limit * 10, limit), 500);
    const transcriptWhere = terms
      .map(() => "LOWER(audioTranscript) LIKE ? ESCAPE '\\'")
      .join(" AND ");
    const transcriptParams = terms.map((term) => `%${escapeLikeLiteral(term)}%`);

    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT *
       FROM files
        WHERE audioTranscript IS NOT NULL
          AND ${transcriptWhere}
          ${whereClause ? `AND (${whereClause})` : ""}
        LIMIT ?`,
      ...transcriptParams,
      ...whereParams,
      candidateLimit,
    );

    return rows
      .map((row) => {
        const record = rowToFileRecord(row as Record<string, string | number>);
        const similarity = scoreTranscriptMatch(query, typeof row.audioTranscript === "string" ? row.audioTranscript : "");
        return similarity > 0 ? { ...record, similarity } : null;
      })
      .filter((row): row is FileRecord & { similarity: number } => row !== null)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * Feedback #183: plain-text search over what people typed or named — the
   * people in the image, tags, AI tags, and the names/tags of the face clusters
   * a file's faces belong to. CLIP only sees pixels, so a photo tagged with
   * someone's name was unfindable by that name. Every term must match
   * somewhere (case-insensitive substring), newest first.
   */
  async metadataSearch(
    query: string,
    filter: FilterElement,
    limit: number,
  ): Promise<Array<FileRecord & { similarity: number }>> {
    const terms = tokenizeTranscriptSearchText(query);
    if (terms.length === 0) return [];
    const { where: whereClause, params: whereParams } = filterToSQL(filter);

    const perTerm = `(
      LOWER(personInImage) LIKE ? ESCAPE '\\'
      OR LOWER(tags) LIKE ? ESCAPE '\\'
      OR LOWER(aiTags) LIKE ? ESCAPE '\\'
      OR LOWER(placeText) LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM faces
        JOIN faceClusters AS cluster ON cluster.id = faces.clusterId
        JOIN faceClusters AS person ON person.id = COALESCE(cluster.personId, faces.clusterId)
        WHERE faces.folder = files.folder AND faces.fileName = files.fileName
          AND (LOWER(person.name) LIKE ? ESCAPE '\\' OR LOWER(person.tags) LIKE ? ESCAPE '\\')
      )
    )`;
    const termParams = terms.flatMap((term) => {
      const like = `%${escapeLikeLiteral(term)}%`;
      return [like, like, like, like, like, like];
    });

    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT *
       FROM files
       WHERE ${terms.map(() => perTerm).join(" AND ")}
         ${whereClause ? `AND (${whereClause})` : ""}
       ORDER BY COALESCE(dateTaken, created, modified) DESC
       LIMIT ?`,
      ...termParams,
      ...whereParams,
      limit,
    );
    return rows.map((row) => ({
      ...rowToFileRecord(row as Record<string, string | number>),
      similarity: 1,
    }));
  }

  /**
   * CLIP search over photos and, since feedback #150, over the sampled frames
   * of videos. Both are scored in the same CLIP space, so they merge by
   * similarity. A video hit carries `matchTimeMs`, the frame that matched, so
   * the viewer can open the video at that moment.
   */
  async semanticSearch(
    queryVector: Float32Array,
    filter: FilterElement,
    limit: number,
  ): Promise<Array<FileRecord & { similarity: number; matchTimeMs?: number }>> {
    const [photos, videos] = await Promise.all([
      this.vectorSearch("image", queryVector, "mimeType LIKE 'image/%'", filter, limit),
      this.videoFrameSearch(queryVector, filter, limit),
    ]);
    return [...photos, ...videos]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * The videos whose best frame matches, best first, filtered through SQL the
   * same way vectorSearch filters photos.
   */
  private async videoFrameSearch(
    queryVector: Float32Array,
    filter: FilterElement,
    limit: number,
  ): Promise<Array<FileRecord & { similarity: number; matchTimeMs: number }>> {
    const query = encodeEmbedding(queryVector);
    if (!query) return [];
    const { where, params } = filterToSQL(filter);
    const mediaCondition = "mimeType LIKE 'video/%'";
    const condition = where ? `${mediaCondition} AND (${where})` : mediaCondition;

    const withTimes = async (
      ranked: Array<{ folder: string; fileName: string; similarity: number; timeMs: number }>,
    ) => {
      const timeOf = new Map(ranked.map((r) => [`${r.folder}\u0000${r.fileName}`, r.timeMs]));
      const rows = await this.fetchRankedFiles(ranked, condition, params);
      return rows.map((row) => ({
        ...row,
        matchTimeMs: timeOf.get(`${row.folder}\u0000${row.fileName}`) ?? 0,
      }));
    };

    const candidateLimit = Math.max(limit * 4, 2_000);
    const candidates = await this.vectorIndex.searchFrames(query, candidateLimit);
    const passing = await withTimes(candidates);
    if (passing.length >= limit || candidates.length < candidateLimit) {
      return passing.slice(0, limit);
    }
    const allowed = await this.db.all<{ folder: string; fileName: string }>(
      `SELECT folder, fileName FROM files WHERE ${condition}`,
      ...params,
    );
    const ranked = await this.vectorIndex.searchFrames(
      query,
      limit,
      allowed.map(({ folder, fileName }) => [folder, fileName]),
    );
    return withTimes(ranked);
  }

  /**
   * Nearest neighbours from the in-memory index, filtered through SQL.
   *
   * The index ranks everything; SQL decides what may be returned, so the share
   * scope, folder and user filters are enforced by the same `filterToSQL` as
   * every other query, on every path. Normally the top few thousand candidates
   * contain enough that pass. When a filter is selective enough that they
   * don't (a small folder, a narrow share), the allowed set is read from SQL
   * once and only those files are ranked.
   */
  private async vectorSearch(
    kind: EmbeddingKind,
    queryVector: Float32Array,
    mediaCondition: string,
    filter: FilterElement,
    limit: number,
  ): Promise<Array<FileRecord & { similarity: number }>> {
    const query = encodeEmbedding(queryVector);
    if (!query) return [];
    const { where, params } = filterToSQL(filter);
    const condition = where ? `${mediaCondition} AND (${where})` : mediaCondition;

    const candidateLimit = Math.max(limit * 4, 2_000);
    const candidates = await this.vectorIndex.search(kind, query, candidateLimit);
    const passing = await this.fetchRankedFiles(candidates, condition, params);
    if (passing.length >= limit || candidates.length < candidateLimit) {
      return passing.slice(0, limit);
    }

    const allowed = await this.db.all<{ folder: string; fileName: string }>(
      `SELECT folder, fileName FROM files WHERE ${condition}`,
      ...params,
    );
    const ranked = await this.vectorIndex.search(
      kind,
      query,
      limit,
      allowed.map(({ folder, fileName }) => [folder, fileName]),
    );
    return this.fetchRankedFiles(ranked, condition, params);
  }

  /** The rows for `ranked` that satisfy `condition`, in the same order. */
  private async fetchRankedFiles(
    ranked: Array<{ folder: string; fileName: string; similarity: number }>,
    condition: string,
    params: unknown[],
  ): Promise<Array<FileRecord & { similarity: number }>> {
    if (ranked.length === 0) return [];
    // The ranking travels as one JSON parameter. Its columns get names no
    // `files` column has, so the caller's unqualified filter SQL stays unambiguous.
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT files.*, ranked.vectorSimilarity
       FROM (
         SELECT key AS vectorRank, value->>0 AS vectorFolder, value->>1 AS vectorFileName,
                value->>2 AS vectorSimilarity
         FROM json_each(?)
       ) AS ranked
       JOIN files ON files.folder = ranked.vectorFolder AND files.fileName = ranked.vectorFileName
       WHERE ${condition}
       ORDER BY ranked.vectorRank`,
      JSON.stringify(ranked.map(({ folder, fileName, similarity }) => [folder, fileName, similarity])),
      ...params,
    );
    return rows.map((row) => ({
      ...rowToFileRecord(row as Record<string, string | number>),
      similarity: row.vectorSimilarity as number,
    }));
  }
}
