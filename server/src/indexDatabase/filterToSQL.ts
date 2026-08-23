import type {
  FilterCondition,
  FilterElement,
  FilterField,
  Range,
} from "./indexDatabase.type.ts";
import { encodeEmbedding } from "./embeddingCodec.ts";
import { normalizeFolderPath } from "./utils/pathUtils.ts";
import { escapeLikeLiteral } from "./utils/sqlUtils.ts";
import {
  faceAttributeConditions,
  isFaceAttributeKey,
  type FaceAttributeKey,
} from "../faceDetection/faceAttributes.ts";

type SQLPart = {
  where: string;
  params: unknown[];
};

const stringArrayJsonFields = new Set(["tags", "aiTags", "personInImage"]);

/**
 * Converts a FilterElement to SQL WHERE clause and parameters.
 * Returns empty string for no filter.
 */
export const filterToSQL = (filter: FilterElement): SQLPart => {
  const parts: SQLPart[] = [];
  buildFilterSQL(filter, parts);

  if (parts.length === 0) {
    return { where: "", params: [] };
  }

  if (parts.length === 1) {
    return parts[0];
  }

  // Join multiple parts (should only happen with logical operators)
  const where = parts.map((p) => p.where).join(" AND ");
  const params = parts.flatMap((p) => p.params);
  return { where, params };
};

const buildFilterSQL = (filter: FilterElement, results: SQLPart[]): void => {
  if ("operation" in filter) {
    // Logical filter (AND/OR)
    const subParts: SQLPart[] = [];
    for (const condition of filter.conditions) {
      buildFilterSQL(condition, subParts);
    }

    if (subParts.length === 0) return;

    const operator = filter.operation === "and" ? " AND " : " OR ";
    const where = subParts.map((p) => `(${p.where})`).join(operator);
    const params = subParts.flatMap((p) => p.params);
    results.push({ where, params });
    return;
  }

  // Filter condition - one or more field constraints
  const conditions = filter as FilterCondition;

  for (const [key, constraint] of Object.entries(conditions)) {
    if (constraint === undefined) {
      // No constraint on this field
      continue;
    }

    const sql = constraintToSQL(key as FilterField, constraint);
    if (sql) {
      results.push(sql);
    }
  }
};

const toClusterIds = (constraint: unknown): number[] =>
  (Array.isArray(constraint) ? constraint : [constraint]).filter(
    (id): id is number => typeof id === "number" && Number.isFinite(id),
  );

/**
 * Builds the correlated-EXISTS face predicate.
 *
 * Two properties matter here and are easy to lose:
 *
 * 1. The attribute conditions go *inside* the same EXISTS as the person match,
 *    not alongside it. "These people, smiling" means the selected person's own
 *    face is smiling — not that the photo contains that person and, separately,
 *    somebody who happens to be smiling.
 * 2. Every column referenced (folder, fileName, clusterId, and the four score
 *    columns) is carried by the `by_file_v4` index, so each EXISTS stays an
 *    index-only probe. Referencing any other face column would make SQLite fetch
 *    the face row and drag its ~4 KB embedding BLOB page along — the difference
 *    between sub-second and tens of seconds across the library.
 */
const faceMatchToSQL = (
  clusterIds: number[],
  attributes: readonly FaceAttributeKey[],
  includeUnknown: boolean,
): SQLPart | null => {
  const { conditions: attributeConditions, params: attributeParams } =
    faceAttributeConditions(attributes, { includeUnknown });

  if (clusterIds.length === 0) {
    if (attributeConditions.length === 0) return null;
    // No person selected: any one face in the photo has to satisfy the
    // attributes.
    return {
      where: `EXISTS (SELECT 1 FROM faces WHERE faces.folder = files.folder AND faces.fileName = files.fileName AND ${attributeConditions.join(" AND ")})`,
      params: [...attributeParams],
    };
  }

  // AND semantics across people: the file must contain a matching face from
  // *every* selected person. A person can span multiple adopted clusters, so
  // match the effective person id rather than the raw face cluster id.
  const clauses = clusterIds.map(
    () =>
      `EXISTS (SELECT 1 FROM faces JOIN faceClusters ON faceClusters.id = faces.clusterId WHERE faces.folder = files.folder AND faces.fileName = files.fileName AND COALESCE(faceClusters.personId, faces.clusterId) = ?${attributeConditions.map((condition) => ` AND ${condition}`).join("")})`,
  );

  return {
    where: clauses.join(" AND "),
    params: clusterIds.flatMap((clusterId) => [clusterId, ...attributeParams]),
  };
};

const faceMatchConstraintToSQL = (constraint: unknown): SQLPart | null => {
  if (!constraint || typeof constraint !== "object" || Array.isArray(constraint)) {
    return null;
  }
  const source = constraint as {
    clusterIds?: unknown;
    attributes?: unknown;
    includeUnknown?: unknown;
  };
  const clusterIds = toClusterIds(source.clusterIds);
  const attributes = (Array.isArray(source.attributes) ? source.attributes : []).filter(
    isFaceAttributeKey,
  );
  // Unknown counts as a match unless the caller explicitly says otherwise, so a
  // half-backfilled library does not silently look empty.
  const includeUnknown = source.includeUnknown !== false;
  return faceMatchToSQL(clusterIds, attributes, includeUnknown);
};

const constraintToSQL = (
  field: FilterField,
  constraint: FilterCondition[FilterField],
): SQLPart | null => {
  const fieldName = String(field);

  if (fieldName === "hasFaces") {
    if (constraint === true) {
      return {
        where:
          "EXISTS (SELECT 1 FROM faces WHERE faces.folder = files.folder AND faces.fileName = files.fileName)",
        params: [],
      };
    }

    if (constraint === false) {
      return {
        where:
          "NOT EXISTS (SELECT 1 FROM faces WHERE faces.folder = files.folder AND faces.fileName = files.fileName)",
        params: [],
      };
    }

    return null;
  }

  if (fieldName === "faceCluster") {
    const clusterIds = toClusterIds(constraint);
    if (clusterIds.length === 0) {
      return null;
    }
    return faceMatchToSQL(clusterIds, [], true);
  }

  if (fieldName === "faceMatch") {
    return faceMatchConstraintToSQL(constraint);
  }

  if (fieldName === "personTag") {
    if (typeof constraint !== "string" || !constraint) return null;
    // Tags live on the person root row (faceClusters.tags, JSON array — see
    // tables.ts), so this walks the same personId-resolution join as
    // faceMatchToSQL/personInImage rather than reading faces.clusterId's own
    // row directly.
    return {
      where: `EXISTS (
        SELECT 1 FROM faces
        JOIN faceClusters AS cluster ON cluster.id = faces.clusterId
        JOIN faceClusters AS person ON person.id = COALESCE(cluster.personId, faces.clusterId)
        WHERE faces.folder = files.folder AND faces.fileName = files.fileName
          AND EXISTS (SELECT 1 FROM json_each(person.tags) WHERE value = ?)
      )`,
      params: [constraint],
    };
  }

  if (fieldName === "semanticImage") {
    if (
      !constraint ||
      typeof constraint !== "object" ||
      !("queryVector" in constraint) ||
      !("minSimilarity" in constraint) ||
      !Array.isArray(constraint.queryVector)
    ) {
      return null;
    }

    const queryVector = Float32Array.from(
      constraint.queryVector.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      ),
    );
    if (queryVector.length === 0 || !Number.isFinite(constraint.minSimilarity)) {
      return null;
    }

    // Vectors live in fileEmbeddings now, so the predicate reaches them through
    // a correlated EXISTS on the primary key rather than reading a column of
    // `files`. Every call site embeds this fragment into an unaliased
    // `FROM files`, which is what makes `files.folder` resolvable here.
    const encoded = encodeEmbedding(queryVector);
    if (!encoded) return null;

    return {
      where:
        `mimeType LIKE 'image/%' AND EXISTS (
           SELECT 1 FROM fileEmbeddings fe
           WHERE fe.folder = files.folder AND fe.fileName = files.fileName
             AND fe.imageEmbedding IS NOT NULL
             AND cosine_similarity_i8(fe.imageEmbedding, ?) >= ?
         )`,
      params: [encoded, constraint.minSimilarity],
    };
  }

  if (fieldName === "semanticAudio") {
    if (
      !constraint ||
      typeof constraint !== "object" ||
      !("queryVector" in constraint) ||
      !("minSimilarity" in constraint) ||
      !Array.isArray(constraint.queryVector)
    ) {
      return null;
    }

    const queryVector = Float32Array.from(
      constraint.queryVector.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      ),
    );
    if (queryVector.length === 0 || !Number.isFinite(constraint.minSimilarity)) {
      return null;
    }

    const encoded = encodeEmbedding(queryVector);
    if (!encoded) return null;

    return {
      where:
        `(((mimeType LIKE 'video/%' AND audioCodec IS NOT NULL) OR mimeType LIKE 'audio/%')) AND EXISTS (
           SELECT 1 FROM fileEmbeddings fe
           WHERE fe.folder = files.folder AND fe.fileName = files.fileName
             AND fe.audioEmbedding IS NOT NULL
             AND cosine_similarity_i8(fe.audioEmbedding, ?) >= ?
         )`,
      params: [encoded, constraint.minSimilarity],
    };
  }

  if (fieldName === "transcriptSearch") {
    if (typeof constraint === "string") {
      return stringSearchToSQL("audioTranscript", { includes: constraint });
    }

    if (
      constraint &&
      typeof constraint === "object" &&
      ("includes" in constraint ||
        "glob" in constraint ||
        "regex" in constraint ||
        "startsWith" in constraint ||
        "notStartsWith" in constraint)
    ) {
      return stringSearchToSQL(
        "audioTranscript",
        constraint as {
          includes?: string;
          glob?: string;
          regex?: string;
          startsWith?: string;
          notStartsWith?: string;
        },
      );
    }

    return null;
  }

  const sqlField = fieldName === "relativePath" ? "(folder || fileName)" : fieldName;
  const isStringArrayJsonField = stringArrayJsonFields.has(fieldName);

  // null means field must be NULL
  if (constraint === null) {
    return {
      where: `${sqlField} IS NULL`,
      params: [],
    };
  }

  if (typeof constraint === "string") {
    if (isStringArrayJsonField) {
      return {
        where: `EXISTS (SELECT 1 FROM json_each(${fieldName}) WHERE value = ?)`,
        params: [constraint],
      };
    }
    // Exact match
    return {
      where: `${sqlField} = ?`,
      params: [constraint],
    };
  }

  if (typeof constraint === "number") {
    // Exact match
    return {
      where: `${sqlField} = ?`,
      params: [constraint],
    };
  }

  if (typeof constraint === "boolean") {
    // Boolean match
    return {
      where: `${sqlField} = ?`,
      params: [constraint ? 1 : 0],
    };
  }

  if (constraint instanceof Date) {
    // Exact date match (as timestamp)
    return {
      where: `${sqlField} = ?`,
      params: [constraint.getTime()],
    };
  }

  if (Array.isArray(constraint)) {
    // Array of values - could be strings or numbers
    if (constraint.length === 0) {
      return { where: "1 = 0", params: [] };
    }

    // Check if array contains strings (for glob/regex matching) or primitives
    if (typeof constraint[0] === "string") {
      if (isStringArrayJsonField) {
        const allValuesMustMatch = constraint
          .map(() => `EXISTS (SELECT 1 FROM json_each(${fieldName}) WHERE value = ?)`)
          .join(" AND ");
        return {
          where: allValuesMustMatch,
          params: constraint,
        };
      }
      // Multiple string constraints
      const conditions = constraint.map(() => {
        // For now, treat as exact matches. Could be enhanced for glob/regex
        return `${sqlField} = ?`;
      });
      return {
        where: `(${conditions.join(" OR ")})`,
        params: constraint, // NOTE: Should this be string[] if multiple conditions??
      };
    }

    // Number array - IN clause
    const placeholders = constraint.map(() => "?").join(", ");
    return {
      where: `${sqlField} IN (${placeholders})`,
      params: constraint,
    };
  }

  if (typeof constraint === "object" && constraint !== null) {
    // Could be Range, StringSearch, or complex object

    // Check for Range (has min/max)
    if ("min" in constraint || "max" in constraint) {
      return rangeToSQL(sqlField, constraint);
    }

    // Check for StringSearch (has includes, glob, regex, startsWith, notStartsWith)
    if (
      "includes" in constraint ||
      "glob" in constraint ||
      "regex" in constraint ||
      "startsWith" in constraint ||
      "notStartsWith" in constraint
    ) {
      return stringSearchToSQL(sqlField, constraint, isStringArrayJsonField);
    }

    if (
      fieldName === "folder" &&
      typeof constraint === "object" &&
      constraint !== null &&
      "folder" in constraint
    ) {
      const folderConstraint = constraint as { folder: string; recursive?: boolean };
      const normalizedFolder = normalizeFolderPath(folderConstraint.folder);
      const escapedFolder = escapeLikeLiteral(normalizedFolder);

      if (folderConstraint.recursive) {
        if (normalizedFolder === "/") {
          return null;
        }

        return {
          where: `folder LIKE ? ESCAPE '\\'`,
          params: [`${escapedFolder}%`],
        };
      }

      return {
        where: `folder = ?`,
        params: [normalizedFolder],
      };
    }

    // Complex nested object - not directly supported
    return null;
  }

  return null;
};

const rangeToSQL = (field: string, range: Range<number | Date>): SQLPart => {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (range.min !== undefined) {
    conditions.push(`${field} >= ?`);
    params.push(range.min instanceof Date ? range.min.getTime() : range.min);
  }

  if (range.max !== undefined) {
    conditions.push(`${field} <= ?`);
    params.push(range.max instanceof Date ? range.max.getTime() : range.max);
  }

  return {
    where: conditions.join(" AND "),
    params,
  };
};

const stringSearchToSQL = (
  field: string,
  search: {
    includes?: string;
    glob?: string;
    regex?: string;
    startsWith?: string;
    notStartsWith?: string;
  },
  isStringArrayJsonField = false,
): SQLPart => {
  if (search.startsWith) {
    const likePrefix = `${escapeLikeLiteral(search.startsWith)}%`;
    if (isStringArrayJsonField) {
      return {
        where: `EXISTS (SELECT 1 FROM json_each(${field}) WHERE value LIKE ? ESCAPE '\\')`,
        params: [likePrefix],
      };
    }
    return {
      where: `${field} LIKE ? ESCAPE '\\'`,
      params: [likePrefix],
    };
  }

  if (search.notStartsWith) {
    const likePrefix = `${escapeLikeLiteral(search.notStartsWith)}%`;
    if (isStringArrayJsonField) {
      return {
        where: `NOT EXISTS (SELECT 1 FROM json_each(${field}) WHERE value LIKE ? ESCAPE '\\')`,
        params: [likePrefix],
      };
    }
    return {
      where: `${field} NOT LIKE ? ESCAPE '\\'`,
      params: [likePrefix],
    };
  }

  if (search.includes) {
    if (isStringArrayJsonField) {
      return {
        where: `EXISTS (SELECT 1 FROM json_each(${field}) WHERE value LIKE ? ESCAPE '\\')`,
        params: [`%${escapeLikeLiteral(search.includes)}%`],
      };
    }
    return {
      where: `${field} LIKE ? ESCAPE '\\'`,
      params: [`%${escapeLikeLiteral(search.includes)}%`],
    };
  }

  if (search.glob) {
    const likePattern = globToLike(search.glob);
    if (isStringArrayJsonField) {
      return {
        where: `EXISTS (SELECT 1 FROM json_each(${field}) WHERE value LIKE ?)`,
        params: [likePattern],
      };
    }
    return {
      where: `${field} LIKE ?`,
      params: [likePattern],
    };
  }

  if (search.regex) {
    if (isStringArrayJsonField) {
      return {
        where: `EXISTS (SELECT 1 FROM json_each(${field}) WHERE value REGEXP ?)`,
        params: [search.regex],
      };
    }
    return {
      where: `${field} REGEXP ?`,
      params: [search.regex],
    };
  }

  return {
    where: "1=1",
    params: [],
  };
};

const globToLike = (glob: string): string => {
  // Convert glob pattern to SQL LIKE pattern
  // ? -> _ (single char), * -> % (any chars)
  return glob.replace(/\*/g, "%").replace(/\?/g, "_");
};
