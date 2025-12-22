import { minimatch } from "minimatch";
import type { FaceTag } from "./fileRecord.type.ts";
import type {
  FileRecord,
  FilterCondition,
  FilterElement,
  Range
} from "./indexDatabase.type.ts";

export const matchesFilter = (record: FileRecord, filter: FilterElement): boolean => {
  if ("operation" in filter) {
    const results = filter.conditions.map((condition) =>
      matchesFilter(record, condition),
    );
    return filter.operation === "and" ? results.every(Boolean) : results.some(Boolean);
  }

  const conditions = filter;
  return Object.entries(conditions).every(([key, constraint]) =>
    matchesCondition(record[key as keyof FileRecord], constraint),
  );
};

const matchesCondition = (
  value: FileRecord[keyof FileRecord],
  constraint: FilterCondition[keyof FilterCondition],
): boolean => {
  if (constraint === undefined) {
    return true;
  }

  // We can request that the field has no value (e.g., "give me all files with no tags")
  if (constraint === null) {
    return value === null;
  }

  if (value === undefined || value === null) {
    return false;
  }

  if (typeof constraint !== "object") {
    return constraint === value;
  }

  const satisfiesRange = <T extends Date | number>(
    value: T,
    range: Range<T>,
  ): boolean => {
    if (range.min !== undefined && value < range.min) {
      return false;
    }
    if (range.max !== undefined && value > range.max) {
      return false;
    }
    return true;
  };

  if (isRange(constraint)) {
    if (typeof value !== "number" && !(value instanceof Date)) {
      return false;
    }
    return satisfiesRange(value, constraint);
  }

  if (isGeoLocation(constraint)) {
    if (!isGeoLocation(value)) {
      return false;
    }
    if ("latitude" in constraint) {
      return matchesCondition(value["latitude"], constraint["latitude"]);
    }
    if ("longitude" in constraint) {
      return matchesCondition(value["longitude"], constraint["longitude"]);
    }
    throw new Error("Should not reach here");
  }

  if (isDimensions(constraint)) {
    if (!isDimensions(value)) {
      return false;
    }
    if ("width" in constraint) {
      if (!matchesCondition(value["width"], constraint["width"])) {
        return false;
      }
    }
    if ("height" in constraint) {
      if (!matchesCondition(value["height"], constraint["height"])) {
        return false;
      }
    }
    throw new Error("Should not reach here");
  }

  if (isFaceTags(constraint)) {
    if (constraint.length === 0 && (!Array.isArray(value) || value.length === 0)) {
      // We have analyzed for faces but found none
      return true;
    }
    if (!isFaceTags(value)) {
      return false;
    }
    return constraint.some((searchTag) =>
      value.some((valueTag) => {
        if (searchTag.person) {
          return searchTag.person.id === valueTag.person?.id;
        }
        if (searchTag.status) {
          return valueTag.status === searchTag.status;
        }
        if (searchTag.featureDescription) {
          // TODO: Implement feature description matching
          throw new Error("Feature description matching not implemented");
        }
        return false;
      }),
    );
  }
  if (Array.isArray(constraint)) {
    if (isFaceTags(value)) {
      // That is handled above
      return false;
    }
    if (Array.isArray(value)) {
      return constraint.every((c) => value.some((v) => v === c));
    }
    if (typeof value === "object") {
      return false;
    }
    return constraint.every((c) => c === value);
  }

  const values = Array.isArray(value) ? value : [value];
  return values.some((v) => {
    if (typeof v !== "string") {
      return false;
    }
    if ("rootOnly" in constraint && constraint.rootOnly) {
      if (v.includes("/")) {
        return false;
      }
    }
    if ("directChildOf" in constraint && constraint.directChildOf) {
      const prefixWithSlash = `${constraint.directChildOf}/`;
      if (!v.startsWith(prefixWithSlash)) {
        return false;
      }
      if (v.slice(prefixWithSlash.length).includes("/")) {
        return false;
      }
    }
    if ("startsWith" in constraint && constraint.startsWith) {
      if (!v.startsWith(constraint.startsWith)) {
        return false;
      }
    }
    if ("includes" in constraint && constraint.includes) {
      if (!v.includes(constraint.includes)) {
        return false;
      }
    }
    if ("glob" in constraint && constraint.glob) {
      if (!minimatch(v, constraint.glob)) {
        return false;
      }
    }
    if ("regex" in constraint && constraint.regex) {
      const regex = new RegExp(constraint.regex);
      if (!regex.test(v)) {
        return false;
      }
    }
    return true;
  });
};

const isPlainObject = (obj: unknown): obj is Record<string, unknown> =>
  typeof obj === "object" && obj !== null && !Array.isArray(obj);
const isRange = (obj: unknown): obj is Range<Date | number> =>
  isPlainObject(obj) && ("min" in obj || "max" in obj);
const isGeoLocation = (
  obj: unknown,
): obj is { latitude?: unknown; longitude?: unknown } =>
  isPlainObject(obj) && ("latitude" in obj || "longitude" in obj);
const isDimensions = (obj: unknown): obj is { width?: unknown; height?: unknown } =>
  isPlainObject(obj) && ("width" in obj || "height" in obj);
const isFaceTag = (obj: unknown): obj is FaceTag =>
  isPlainObject(obj) &&
  "dimensions" in obj &&
  "featureDescription" in obj &&
  "person" in obj;
const isFaceTags = (obj: unknown): obj is FaceTag[] =>
  Array.isArray(obj) && obj.every((tag) => isFaceTag(tag));
