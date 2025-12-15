import { minimatch } from "minimatch";
import type { FilterCondition, FilterElement, Range } from "./indexDatabase.type.ts";

type SQLPart = {
  where: string;
  params: unknown[];
};

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
  const where = parts.map(p => p.where).join(" AND ");
  const params = parts.flatMap(p => p.params);
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
    const where = subParts.map(p => `(${p.where})`).join(operator);
    const params = subParts.flatMap(p => p.params);
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
    
    const sql = constraintToSQL(key, constraint);
    if (sql) {
      results.push(sql);
    }
  }
};

const constraintToSQL = (
  field: string,
  constraint: unknown
): SQLPart | null => {
  // null means field must be NULL
  if (constraint === null) {
    return {
      where: `${field} IS NULL`,
      params: [],
    };
  }

  if (typeof constraint === "string") {
    // Exact match
    return {
      where: `${field} = ?`,
      params: [constraint],
    };
  }

  if (typeof constraint === "number") {
    // Exact match
    return {
      where: `${field} = ?`,
      params: [constraint],
    };
  }

  if (typeof constraint === "boolean") {
    // Boolean match
    return {
      where: `${field} = ?`,
      params: [constraint ? 1 : 0],
    };
  }

  if (constraint instanceof Date) {
    // Exact date match (as timestamp)
    return {
      where: `${field} = ?`,
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
      // Multiple string constraints - check if they're glob patterns
      const conditions = constraint.map((value: string) => {
        // For now, treat as exact matches. Could be enhanced for glob/regex
        return `${field} = ?`;
      });
      return {
        where: `(${conditions.join(" OR ")})`,
        params: constraint,
      };
    }
    
    // Number array - IN clause
    const placeholders = constraint.map(() => "?").join(", ");
    return {
      where: `${field} IN (${placeholders})`,
      params: constraint,
    };
  }

  if (typeof constraint === "object" && constraint !== null) {
    // Could be Range, StringSearch, or complex object
    
    // Check for Range (has min/max)
    if ("min" in constraint || "max" in constraint) {
      return rangeToSQL(field, constraint as Range<any>);
    }
    
    // Check for StringSearch (has includes, glob, regex)
    if ("includes" in constraint || "glob" in constraint || "regex" in constraint) {
      return stringSearchToSQL(field, constraint as any);
    }
    
    // Complex nested object (like dimensions.width) - not directly supported in this simple version
    // Would need more sophisticated handling
    return null;
  }

  return null;
};

const rangeToSQL = (field: string, range: Range<any>): SQLPart => {
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
  search: { includes?: string; glob?: string; regex?: string }
): SQLPart => {
  if (search.includes) {
    // LIKE search
    return {
      where: `${field} LIKE ?`,
      params: [`%${search.includes}%`],
    };
  }

  if (search.glob) {
    // For glob patterns, we'd need a custom function or do it in memory
    // For now, approximate with LIKE
    const likePattern = globToLike(search.glob);
    return {
      where: `${field} LIKE ?`,
      params: [likePattern],
    };
  }

  if (search.regex) {
    // Use custom REGEXP function (registered in IndexDatabase constructor)
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
  return glob
    .replace(/\./g, "[.]") // Escape dots
    .replace(/\*/g, "%")
    .replace(/\?/g, "_");
};
