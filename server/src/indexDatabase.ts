import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import type { AllMetadata, Filter } from "../apiSpecification.js";
import type { IndexedFileRecord } from "./models.js";

const MINIMATCH_OPTIONS = { nocase: true, dot: true, nocomment: true } as const;
const DEFAULT_PAGE_SIZE = 50;

type MetadataKeys = Array<keyof AllMetadata>;

export type QuerySort = {
  sortBy: "name" | "dateTaken" | "dateCreated" | "rating";
  order: "asc" | "desc";
};

export type QueryOptions<T extends MetadataKeys | undefined = undefined> = {
  sort?: QuerySort;
  metadata?: T;
  page?: number;
  pageSize?: number;
};

export type QueryResult<T extends MetadataKeys | undefined = undefined> = {
  items: Array<{
    path: string;
    metadata?: T extends MetadataKeys
      ? Pick<AllMetadata, T[number]>
      : Partial<AllMetadata>;
  }>;
  total: number;
  page: number;
};

export class IndexDatabase {
  private readonly storagePath?: string;
  private readonly records = new Map<string, IndexedFileRecord>();

  constructor(dbFile?: string) {
    this.storagePath = dbFile;
    if (dbFile && existsSync(dbFile)) {
      try {
        const raw = readFileSync(dbFile, "utf8");
        const parsed = JSON.parse(raw) as IndexedFileRecord[];
        for (const record of parsed) {
          this.records.set(record.path, record);
        }
      } catch (error) {
        console.warn(`[indexer] Failed to load existing index at ${dbFile}`, error);
      }
    }
  }

  upsertFile(record: IndexedFileRecord): void {
    this.records.set(record.path, record);
    this.persist();
  }

  removeFile(pathRelative: string): void {
    if (this.records.delete(pathRelative)) {
      this.persist();
    }
  }

  listFiles(): IndexedFileRecord[] {
    return Array.from(this.records.values()).sort((a, b) => a.path.localeCompare(b.path));
  }

  getFile(pathRelative: string): IndexedFileRecord | undefined {
    return this.records.get(pathRelative);
  }

  queryFiles<T extends MetadataKeys | undefined = undefined>(
    filter?: Filter,
    options?: QueryOptions<T>,
  ): QueryResult<T> {
    const metadataKeys = options?.metadata;
    const page = Math.max(options?.page ?? 1, 1);
    const pageSize = Math.max(options?.pageSize ?? DEFAULT_PAGE_SIZE, 1);
    const normalizedFilter = filter ?? {};

    let records = Array.from(this.records.values());

    records = records.filter((record) => matchesRecord(record, normalizedFilter));

    records = sortRecords(records, options?.sort);

    const total = records.length;
    const start = (page - 1) * pageSize;
    const paged = records.slice(start, start + pageSize);

    const items = paged.map((record) => {
      const fullMetadata = buildFullMetadata(record);
      if (metadataKeys !== undefined) {
        if (metadataKeys.length === 0) {
          return { path: record.path } as QueryResult<T>["items"][number];
        }
        const picked = pickMetadata(fullMetadata, metadataKeys);
        const hasValues = metadataKeys.some((key) => picked[key] !== undefined);
        if (!hasValues) {
          return { path: record.path } as QueryResult<T>["items"][number];
        }
        return {
          path: record.path,
          metadata: picked,
        } as QueryResult<T>["items"][number];
      }

      return {
        path: record.path,
        metadata: fullMetadata,
      } as QueryResult<T>["items"][number];
    });

    return {
      items,
      total,
      page,
    };
  }

  close(): void {
    this.persist();
  }

  private persist(): void {
    if (!this.storagePath) {
      return;
    }

    const directory = path.dirname(this.storagePath);
    mkdirSync(directory, { recursive: true });
    const serialized = JSON.stringify(this.listFiles(), null, 2);
    writeFileSync(this.storagePath, serialized, "utf8");
  }
}

const matchesRecord = (record: IndexedFileRecord, filter: Filter): boolean => {
  if (filter.path?.length && !matchesPath(record, filter.path)) {
    return false;
  }

  if (filter.filename?.length && !matchesFilename(record, filter.filename)) {
    return false;
  }

  if (filter.directory?.length && !matchesDirectory(record, filter.directory)) {
    return false;
  }

  if (filter.mimeType?.length && !matchesMimeType(record, filter.mimeType)) {
    return false;
  }

  if (filter.cameraMake?.length && !matchesCameraMake(record, filter.cameraMake)) {
    return false;
  }

  if (filter.cameraModel?.length && !matchesCameraModel(record, filter.cameraModel)) {
    return false;
  }

  if (filter.location && !matchesLocation(record, filter.location)) {
    return false;
  }

  if (filter.dateRange && !matchesDateRange(record, filter.dateRange)) {
    return false;
  }

  if (filter.rating && !matchesRating(record, filter.rating)) {
    return false;
  }

  if (
    filter.tags?.length &&
    !matchesTags(record, filter.tags, filter.tagsMatchAll ?? false)
  ) {
    return false;
  }

  if (filter.q?.trim().length && !matchesQuery(record, filter.q)) {
    return false;
  }

  return true;
};

const matchesPath = (record: IndexedFileRecord, patterns: string[]): boolean => {
  const pathLower = record.path.toLowerCase();
  return patterns.some((pattern) => {
    const normalized = normalizePattern(pattern);
    if (!hasGlob(normalized)) {
      return pathLower === normalized.toLowerCase();
    }
    return minimatch(record.path, normalized, MINIMATCH_OPTIONS);
  });
};

const matchesFilename = (record: IndexedFileRecord, patterns: string[]): boolean => {
  const nameLower = record.name.toLowerCase();
  return patterns.some((pattern) => {
    const normalized = normalizePattern(pattern);
    if (!hasGlob(normalized) && !normalized.includes("/")) {
      return nameLower === normalized.toLowerCase();
    }
    if (normalized.includes("/")) {
      return minimatch(record.path, normalized, MINIMATCH_OPTIONS);
    }
    return minimatch(record.name, normalized, MINIMATCH_OPTIONS);
  });
};

const matchesDirectory = (record: IndexedFileRecord, patterns: string[]): boolean => {
  const directoryLower = record.directory.toLowerCase();
  return patterns.some((pattern) => {
    const normalized = stripTrailingSlash(normalizePattern(pattern));
    if (!hasGlob(normalized)) {
      if (normalized === "") {
        return directoryLower === "";
      }
      const target = normalized.toLowerCase();
      return directoryLower === target || directoryLower.startsWith(`${target}/`);
    }
    return minimatch(record.directory, normalized, MINIMATCH_OPTIONS);
  });
};

const matchesMimeType = (record: IndexedFileRecord, mimeTypes: string[]): boolean => {
  if (!record.mimeType) {
    return false;
  }
  const value = record.mimeType.toLowerCase();
  return mimeTypes.some((pattern) => {
    const normalized = pattern.trim().toLowerCase();
    if (!hasGlob(normalized) && !normalized.includes("*")) {
      return value === normalized;
    }
    return minimatch(value, normalized, MINIMATCH_OPTIONS);
  });
};

const matchesCameraMake = (record: IndexedFileRecord, makes: string[]): boolean => {
  const cameraMake = record.metadata.cameraMake;
  if (!cameraMake) {
    return false;
  }
  const value = cameraMake.toLowerCase();
  return makes.some((make) => value === make.trim().toLowerCase());
};

const matchesCameraModel = (record: IndexedFileRecord, models: string[]): boolean => {
  const cameraModel = record.metadata.cameraModel;
  if (!cameraModel) {
    return false;
  }
  const value = cameraModel.toLowerCase();
  return models.some((model) => value === model.trim().toLowerCase());
};

const matchesLocation = (
  record: IndexedFileRecord,
  bounds: NonNullable<Filter["location"]>,
): boolean => {
  if (!bounds) {
    return true;
  }
  const hasAnyConstraint =
    bounds.minLatitude !== undefined ||
    bounds.maxLatitude !== undefined ||
    bounds.minLongitude !== undefined ||
    bounds.maxLongitude !== undefined;

  if (!hasAnyConstraint) {
    return true;
  }

  const location = record.metadata.location;
  if (!location) {
    return false;
  }

  const minLat = bounds.minLatitude ?? -Infinity;
  const maxLat = bounds.maxLatitude ?? Infinity;
  const minLon = bounds.minLongitude ?? -Infinity;
  const maxLon = bounds.maxLongitude ?? Infinity;

  return (
    location.latitude >= minLat &&
    location.latitude <= maxLat &&
    location.longitude >= minLon &&
    location.longitude <= maxLon
  );
};

const matchesDateRange = (
  record: IndexedFileRecord,
  range: NonNullable<Filter["dateRange"]>,
): boolean => {
  if (!range) {
    return true;
  }
  const hasStart = range.start !== undefined;
  const hasEnd = range.end !== undefined;
  if (!hasStart && !hasEnd) {
    return true;
  }

  const candidate =
    record.metadata.dateTaken ??
    record.metadata.dateCreated ??
    record.dateCreated ??
    record.dateModified;

  if (!candidate) {
    return false;
  }

  const timestamp = toTimestamp(candidate);
  if (timestamp === undefined) {
    return false;
  }

  const startTs = range.start ? toTimestamp(range.start) : undefined;
  const endTs = range.end ? toTimestamp(range.end) : undefined;

  if (startTs !== undefined && timestamp < startTs) {
    return false;
  }
  if (endTs !== undefined && timestamp > endTs) {
    return false;
  }
  return true;
};

const matchesRating = (
  record: IndexedFileRecord,
  ratingFilter: NonNullable<Filter["rating"]>,
): boolean => {
  const rating =
    typeof record.metadata.rating === "number" ? record.metadata.rating : undefined;
  if (rating === undefined) {
    return false;
  }

  if (Array.isArray(ratingFilter)) {
    return ratingFilter.some((value) => value === rating);
  }

  const min = ratingFilter.min ?? -Infinity;
  const max = ratingFilter.max ?? Infinity;
  return rating >= min && rating <= max;
};

const matchesTags = (
  record: IndexedFileRecord,
  tags: string[],
  matchAll: boolean,
): boolean => {
  const recordTags = Array.isArray(record.metadata.tags)
    ? record.metadata.tags.map((tag) => tag.toLowerCase())
    : [];

  if (recordTags.length === 0) {
    return false;
  }

  const desired = tags.map((tag) => tag.toLowerCase());
  if (matchAll) {
    return desired.every((tag) => recordTags.includes(tag));
  }
  return desired.some((tag) => recordTags.includes(tag));
};

const matchesQuery = (record: IndexedFileRecord, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  const tokens = collectSearchTokens(record);
  return tokens.some((token) => token.includes(q));
};

const collectSearchTokens = (record: IndexedFileRecord): string[] => {
  const tokens = new Set<string>();
  tokens.add(record.path.toLowerCase());
  tokens.add(record.name.toLowerCase());
  if (record.directory) {
    tokens.add(record.directory.toLowerCase());
  }
  if (record.mimeType) {
    tokens.add(record.mimeType.toLowerCase());
  }

  const metadata = buildFullMetadata(record);
  for (const value of Object.values(metadata)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string") {
      tokens.add(value.toLowerCase());
    } else if (typeof value === "number") {
      tokens.add(value.toString());
    } else if (Array.isArray(value)) {
      for (const item of value as Array<unknown>) {
        if (typeof item === "string") {
          tokens.add(item.toLowerCase());
        } else if (typeof item === "number") {
          tokens.add(item.toString());
        } else if (item != null) {
          tokens.add(String(item).toLowerCase());
        }
      }
    } else if (typeof value === "object" && "latitude" in value && "longitude" in value) {
      const location = value as { latitude: number; longitude: number };
      tokens.add(location.latitude.toString());
      tokens.add(location.longitude.toString());
    }
  }

  return Array.from(tokens);
};

const sortRecords = (
  records: IndexedFileRecord[],
  sort?: QuerySort,
): IndexedFileRecord[] => {
  const sortBy = sort?.sortBy ?? "dateTaken";
  const order = sort?.order ?? (sort ? "asc" : "desc");
  return records.sort((a, b) => compareByField(a, b, sortBy, order));
};

const compareByField = (
  a: IndexedFileRecord,
  b: IndexedFileRecord,
  sortBy: QuerySort["sortBy"],
  order: QuerySort["order"],
): number => {
  switch (sortBy) {
    case "dateTaken":
      return (
        compareNumeric(getDateTakenTimestamp(a), getDateTakenTimestamp(b), order) ||
        compareByNameThenPath(a, b, "asc")
      );
    case "dateCreated":
      return (
        compareNumeric(toTimestamp(a.dateCreated), toTimestamp(b.dateCreated), order) ||
        compareByNameThenPath(a, b, "asc")
      );
    case "rating":
      return (
        compareNumeric(
          typeof a.metadata.rating === "number" ? a.metadata.rating : undefined,
          typeof b.metadata.rating === "number" ? b.metadata.rating : undefined,
          order,
        ) || compareByNameThenPath(a, b, "asc")
      );
    case "name":
    default: {
      return compareByNameThenPath(a, b, order);
    }
  }
};

const compareNumeric = (
  a: number | undefined,
  b: number | undefined,
  order: QuerySort["order"],
): number => {
  if (order === "asc") {
    if (a === undefined && b === undefined) {
      return 0;
    }
    if (a === undefined) {
      return 1;
    }
    if (b === undefined) {
      return -1;
    }
    if (a === b) {
      return 0;
    }
    return a - b;
  }

  // desc
  if (a === undefined && b === undefined) {
    return 0;
  }
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  if (a === b) {
    return 0;
  }
  return b - a;
};

const compareByNameThenPath = (
  a: IndexedFileRecord,
  b: IndexedFileRecord,
  order: QuerySort["order"],
): number => {
  const comparison = a.name.localeCompare(b.name, undefined, {
    sensitivity: "base",
  });
  if (comparison !== 0) {
    return order === "asc" ? comparison : -comparison;
  }
  const pathComparison = a.path.localeCompare(b.path, undefined, {
    sensitivity: "base",
  });
  return order === "asc" ? pathComparison : -pathComparison;
};

const getDateTakenTimestamp = (record: IndexedFileRecord): number | undefined => {
  const candidate =
    record.metadata.dateTaken ??
    record.metadata.dateCreated ??
    record.dateCreated ??
    record.dateModified;

  return toTimestamp(candidate);
};

const toTimestamp = (value: string | Date | undefined | null): number | undefined => {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
};

const buildFullMetadata = (record: IndexedFileRecord): Partial<AllMetadata> => {
  const merged: Partial<AllMetadata> = {
    ...record.metadata,
  };

  if (merged.size === undefined) {
    merged.size = record.size;
  }
  if (merged.mimeType === undefined && record.mimeType) {
    merged.mimeType = record.mimeType;
  }
  if (merged.dateCreated === undefined && record.dateCreated) {
    merged.dateCreated = record.dateCreated;
  }

  return merged;
};

const pickMetadata = <K extends keyof AllMetadata>(
  source: Partial<AllMetadata>,
  keys: K[],
): Pick<AllMetadata, K> => {
  const result: Partial<AllMetadata> = {};
  for (const key of keys) {
    result[key] = source[key];
  }
  return result as Pick<AllMetadata, K>;
};

const normalizePattern = (pattern: string): string => {
  return pattern
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .trim();
};

const stripTrailingSlash = (value: string): string => {
  return value.replace(/\/+$/, "");
};

const hasGlob = (pattern: string): boolean => {
  return ["*", "?", "[", "]", "{", "}"].some((token) => pattern.includes(token));
};
