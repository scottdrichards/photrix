import type {
  FilterCondition,
  FilterElement,
  FilterField,
  Range,
} from "./indexDatabase.type.ts";
import type { FileRecord } from "./fileRecord.type.ts";
import { normalizeFolderPath } from "./utils/pathUtils.ts";

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

const constraintToSQL = (
  field: FilterField,
  constraint: FilterCondition[FilterField],
): SQLPart | null => {
  const fieldName = String(field);
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
      return null;
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
        // Special case: root recursive matches every row. Returning a WHERE
        // clause makes SQLite prefer the folder index and full-set sort, which
        // freezes the read worker on large libraries. Returning no WHERE lets
        // the planner walk `sort_date` in order and stop at LIMIT.
        if (normalizedFolder === "/") {
          return { where: "", params: [] };
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

/**
 * Escape special characters for SQL LIKE literal (%, _, \)
 */
const escapeLikeLiteral = (value: string) => value.replace(/[\\%_]/g, (m) => `\\${m}`);

const globToLike = (glob: string): string => {
  // Convert glob pattern to SQL LIKE pattern
  // ? -> _ (single char), * -> % (any chars)
  return glob
    .replace(/\./g, "[.]") // Escape dots
    .replace(/\*/g, "%")
    .replace(/\?/g, "_");
};
