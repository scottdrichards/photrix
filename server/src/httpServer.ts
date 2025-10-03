import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { lookup as lookupMimeType } from "mime-types";
import type { Filter, AllMetadata, Representation } from "../apiSpecification.js";
import { FolderIndexer } from "./folderIndexer.js";
import { FileService } from "./fileService.js";
import type { QueryOptions } from "./indexDatabase.js";

const DEFAULT_PORT = 3000;
const DEFAULT_UPLOAD_PREFIX = "/uploads";

const METADATA_FIELDS = [
  "name",
  "size",
  "mimeType",
  "dateCreated",
  "dateTaken",
  "dimensions",
  "location",
  "rating",
  "tags",
  "cameraMake",
  "cameraModel",
  "exposureTime",
  "aperture",
  "iso",
  "focalLength",
  "lens",
  "duration",
  "framerate",
  "videoCodec",
  "audioCodec",
] as const satisfies ReadonlyArray<keyof AllMetadata>;

const METADATA_KEY_SET = new Set<keyof AllMetadata>(METADATA_FIELDS);

type MetadataKeyList = Array<keyof AllMetadata>;

type QueryOptionsType = QueryOptions<MetadataKeyList | undefined>;

type FileRepresentation = Representation<"photo">;

const SORT_FIELDS = ["name", "dateTaken", "dateCreated", "rating"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const isSortField = (value: string): value is SortField => {
  return (SORT_FIELDS as ReadonlyArray<string>).includes(value);
};

class BadRequestError extends Error {}
class NotFoundError extends Error {}

export interface PhotrixHttpServerOptions {
  mediaRoot: string;
  indexDatabaseFile?: string;
  indexer?: {
    watch?: boolean;
    awaitWriteFinish?: boolean;
  };
  cors?: {
    origin?: string;
    allowCredentials?: boolean;
  };
  uploadPrefix?: string;
}

export class PhotrixHttpServer {
  private readonly indexer: FolderIndexer;
  private readonly fileService: FileService;
  private readonly corsOrigin: string;
  private readonly corsAllowCredentials: boolean;
  private readonly uploadPrefix: string;
  private server: http.Server | null = null;
  private currentHost: string | null = null;
  private currentPort: number | null = null;

  constructor(private readonly options: PhotrixHttpServerOptions) {
    this.indexer = new FolderIndexer(options.mediaRoot, {
      dbFile: options.indexDatabaseFile,
      watch: options.indexer?.watch,
      awaitWriteFinish: options.indexer?.awaitWriteFinish,
    });
    this.fileService = new FileService(this.indexer);
    this.corsOrigin = options.cors?.origin ?? "*";
    this.corsAllowCredentials = options.cors?.allowCredentials ?? false;
    this.uploadPrefix = normalizePrefix(options.uploadPrefix ?? DEFAULT_UPLOAD_PREFIX);
  }

  async start(
    port = DEFAULT_PORT,
    host = "0.0.0.0",
  ): Promise<{ port: number; host: string }> {
    if (this.server) {
      throw new Error("Server is already running");
    }

    await this.indexer.start();

    const actualPort = await new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.on("error", (error) => {
        reject(error);
      });

      server.listen(port, host, () => {
        const address = server.address();
        if (address && typeof address === "object") {
          resolve(address.port);
        } else if (typeof address === "string") {
          const parsed = Number.parseInt(address.split(":").pop() ?? "", 10);
          resolve(Number.isFinite(parsed) ? parsed : port);
        } else {
          resolve(port);
        }
      });

      this.server = server;
    });

    this.currentPort = actualPort;
    this.currentHost = host;

    return { port: actualPort, host };
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      this.server = null;
    }

    await this.indexer.stop(true);
    this.currentPort = null;
    this.currentHost = null;
  }

  getAddress(): { host: string | null; port: number | null } {
    return {
      host: this.currentHost,
      port: this.currentPort,
    };
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let parsedUrl: URL | null = null;
    try {
      if (!req.url) {
        throw new BadRequestError("Invalid request URL");
      }

      this.applyCors(res);

      const method = (req.method ?? "GET").toUpperCase();
      if (method === "OPTIONS") {
        this.handleOptions(req, res);
        return;
      }

      parsedUrl = buildRequestUrl(
        req.url,
        this.currentHost ?? req.headers.host ?? "localhost",
      );
      const pathname = parsedUrl.pathname;

      if (method === "GET" && pathname === "/api/files") {
        await this.handleQueryFiles(parsedUrl, res);
        return;
      }

      if (method === "GET" && pathname === "/api/file") {
        await this.handleGetFile(parsedUrl, res);
        return;
      }

      if (method === "GET" && pathname.startsWith(`${this.uploadPrefix}/`)) {
        await this.handleStaticFile(parsedUrl, res);
        return;
      }

      this.sendError(res, 404, "Not found");
    } catch (error) {
      this.handleError(req, res, error, parsedUrl);
    }
  }

  private applyCors(res: http.ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", this.corsOrigin);
    if (this.corsAllowCredentials) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }

  private handleOptions(req: http.IncomingMessage, res: http.ServerResponse): void {
    const requestedHeaders = req.headers["access-control-request-headers"];
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    if (requestedHeaders) {
      res.setHeader("Access-Control-Allow-Headers", requestedHeaders as string);
    }
    res.statusCode = 204;
    res.end();
  }

  private async handleQueryFiles(url: URL, res: http.ServerResponse): Promise<void> {
    const { filter, options } = buildQueryParameters(url.searchParams);
    const result = await this.indexer.queryFiles(filter, options);
    this.sendJson(res, 200, result);
  }

  private async handleGetFile(url: URL, res: http.ServerResponse): Promise<void> {
    const params = url.searchParams;
    const representation = parseRepresentation(params);
    const pathParam = params.get("path");
    const filenameParam = params.get("filename");

    if (!pathParam && !filenameParam) {
      throw new BadRequestError('Query parameter "path" or "filename" is required');
    }

    try {
      if (pathParam) {
        const relativePath = sanitizeRelativePath(pathParam);
        const record = this.indexer.getIndexedFile(relativePath);
        if (!record) {
          throw new NotFoundError(`File ${relativePath} is not indexed`);
        }
        const result = await this.fileService.getFile(relativePath, { representation });
        this.sendFile(res, result.data, result.contentType);
        return;
      }

      if (filenameParam) {
        const result = await this.fileService.getFileByFilename(filenameParam, {
          representation,
        });
        this.sendFile(res, result.data, result.contentType);
        return;
      }
    } catch (error) {
      if (error instanceof NotFoundError || isFileMissingError(error)) {
        throw new NotFoundError("File not found");
      }
      throw error;
    }

    throw new BadRequestError("Unable to resolve file request");
  }

  private async handleStaticFile(url: URL, res: http.ServerResponse): Promise<void> {
    const relative = url.pathname.slice(this.uploadPrefix.length + 1);
    if (!relative) {
      throw new NotFoundError("File not found");
    }

    const normalized = sanitizeRelativePath(relative);
    const absolute = this.resolveAbsolutePath(normalized);
    try {
      const data = await fs.readFile(absolute);
      const contentType =
        lookupMimeType(path.basename(normalized)) || "application/octet-stream";
      this.sendFile(res, data, contentType);
    } catch (error) {
      if (
        error &&
        typeof (error as NodeJS.ErrnoException).code === "string" &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new NotFoundError("File not found");
      }
      throw error;
    }
  }

  private resolveAbsolutePath(relativePath: string): string {
    const root = this.indexer.getRootDirectory();
    const normalized = relativePath.split("/").join(path.sep);
    const absolute = path.resolve(root, normalized);
    if (!absolute.startsWith(root)) {
      throw new BadRequestError("Resolved path escaped media root");
    }
    return absolute;
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
  }

  private sendFile(
    res: http.ServerResponse,
    data: ArrayBuffer | Buffer,
    contentType: string,
  ): void {
    const buffer = Buffer.isBuffer(data) ? data : arrayBufferToBuffer(data);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length.toString());
    res.setHeader(
      "Cache-Control",
      contentType === "application/json" ? "no-store" : "public, max-age=3600",
    );
    res.end(buffer);
  }

  private sendError(res: http.ServerResponse, status: number, message: string): void {
    this.sendJson(res, status, { error: message });
  }

  private handleError(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    error: unknown,
    url: URL | null,
  ): void {
    const method = (req.method ?? "GET").toUpperCase();
    const requestUrl = url?.toString() ?? req.url ?? "";

    if (error instanceof BadRequestError) {
      console.warn(`[photrix] 400 ${method} ${requestUrl}: ${error.message}`);
      this.sendError(res, 400, error.message);
      return;
    }
    if (error instanceof NotFoundError) {
      console.info(`[photrix] 404 ${method} ${requestUrl}: ${error.message}`);
      this.sendError(res, 404, error.message);
      return;
    }
    console.error(`[photrix] 500 ${method} ${requestUrl}`, error);
    this.sendError(res, 500, "Internal server error");
  }
}

const buildRequestUrl = (requestUrl: string, hostHeader: string): URL => {
  const base = hostHeader.startsWith("http") ? hostHeader : `http://${hostHeader}`;
  return new URL(requestUrl, base);
};

const normalizePrefix = (value: string): string => {
  if (!value.startsWith("/")) {
    return `/${value}`;
  }
  return value.replace(/\/+$/, "");
};

const buildQueryParameters = (
  params: URLSearchParams,
): {
  filter?: Filter;
  options: QueryOptionsType;
} => {
  const filter: Filter = {};
  let hasFilter = false;

  const pathValues = getStringList(params, "path");
  if (pathValues.length > 0) {
    filter.path = pathValues;
    hasFilter = true;
  }

  const filenameValues = getStringList(params, "filename");
  if (filenameValues.length > 0) {
    filter.filename = filenameValues;
    hasFilter = true;
  }

  const directoryValues = getStringList(params, "directory");
  if (directoryValues.length > 0) {
    filter.directory = directoryValues;
    hasFilter = true;
  }

  const mimeValues = getStringList(params, "mimeType");
  if (mimeValues.length > 0) {
    filter.mimeType = mimeValues;
    hasFilter = true;
  }

  const cameraMake = getStringList(params, "cameraMake");
  if (cameraMake.length > 0) {
    filter.cameraMake = cameraMake;
    hasFilter = true;
  }

  const cameraModel = getStringList(params, "cameraModel");
  if (cameraModel.length > 0) {
    filter.cameraModel = cameraModel;
    hasFilter = true;
  }

  const tags = getStringList(params, "tags");
  if (tags.length > 0) {
    filter.tags = tags;
    hasFilter = true;
  }

  const tagsMatchAll = params.get("tagsMatchAll");
  if (tagsMatchAll !== null) {
    filter.tagsMatchAll = parseBoolean(tagsMatchAll);
    hasFilter = true;
  }

  const query = params.get("q");
  if (query && query.trim().length > 0) {
    filter.q = query.trim();
    hasFilter = true;
  }

  const location = buildLocationFilter(params);
  if (location) {
    filter.location = location;
    hasFilter = true;
  }

  const dateRange = buildDateRangeFilter(params);
  if (dateRange) {
    filter.dateRange = dateRange;
    hasFilter = true;
  }

  const ratingFilter = buildRatingFilter(params);
  if (ratingFilter) {
    filter.rating = ratingFilter;
    hasFilter = true;
  }

  const metadataKeys = parseMetadataKeys(params);
  const options: QueryOptionsType = {
    metadata: metadataKeys.length > 0 ? metadataKeys : undefined,
  };

  const sortBy = params.get("sortBy");
  if (sortBy) {
    const sort = parseSort(sortBy, params.get("order"));
    if (sort) {
      options.sort = sort;
    }
  }

  const page = params.get("page");
  if (page) {
    options.page = parsePositiveInteger("page", page);
  }

  const pageSize = params.get("pageSize");
  if (pageSize) {
    options.pageSize = parsePositiveInteger("pageSize", pageSize);
  }

  return {
    filter: hasFilter ? filter : undefined,
    options,
  };
};

const parseSort = (sortBy: string, orderRaw: string | null): QueryOptionsType["sort"] => {
  if (!isSortField(sortBy)) {
    return undefined;
  }

  const order = orderRaw?.toLowerCase() === "desc" ? "desc" : "asc";
  return {
    sortBy,
    order,
  };
};

const buildLocationFilter = (params: URLSearchParams): Filter["location"] | undefined => {
  const minLatitude = parseOptionalFloat("minLatitude", params.get("minLatitude"));
  const maxLatitude = parseOptionalFloat("maxLatitude", params.get("maxLatitude"));
  const minLongitude = parseOptionalFloat("minLongitude", params.get("minLongitude"));
  const maxLongitude = parseOptionalFloat("maxLongitude", params.get("maxLongitude"));

  const hasValue = [minLatitude, maxLatitude, minLongitude, maxLongitude].some(
    (value) => value !== undefined,
  );

  if (!hasValue) {
    return undefined;
  }

  return {
    minLatitude,
    maxLatitude,
    minLongitude,
    maxLongitude,
  };
};

const buildDateRangeFilter = (
  params: URLSearchParams,
): Filter["dateRange"] | undefined => {
  const start = params.get("dateStart") ?? params.get("startDate");
  const end = params.get("dateEnd") ?? params.get("endDate");

  if (!start && !end) {
    return undefined;
  }

  return {
    start: start ?? undefined,
    end: end ?? undefined,
  };
};

const buildRatingFilter = (params: URLSearchParams): Filter["rating"] | undefined => {
  const ratingValues = getStringList(params, "rating").map((value) =>
    parseFloatStrict("rating", value),
  );
  if (ratingValues.length > 0) {
    return ratingValues;
  }

  const min = parseOptionalFloat("ratingMin", params.get("ratingMin"));
  const max = parseOptionalFloat("ratingMax", params.get("ratingMax"));

  if (min === undefined && max === undefined) {
    return undefined;
  }

  return { min, max };
};

const parseRepresentation = (params: URLSearchParams): FileRepresentation => {
  const type = (params.get("representation") ?? "original").toLowerCase();

  switch (type) {
    case "websafe":
    case "web-safe":
      return { type: "webSafe" };
    case "resize": {
      const maxWidth = parseOptionalPositiveInteger("maxWidth", params.get("maxWidth"));
      const maxHeight = parseOptionalPositiveInteger(
        "maxHeight",
        params.get("maxHeight"),
      );
      return {
        type: "resize",
        maxWidth,
        maxHeight,
      };
    }
    case "metadata": {
      const metadataKeys = parseMetadataKeys(params);
      const keys = metadataKeys.length > 0 ? metadataKeys : [...METADATA_FIELDS];
      return { type: "metadata", metadataKeys: keys };
    }
    case "original":
    default:
      return { type: "original" };
  }
};

const parseMetadataKeys = (params: URLSearchParams): MetadataKeyList => {
  const values = getStringList(params, "metadata");
  const result: MetadataKeyList = [];
  for (const value of values) {
    const key = value as keyof AllMetadata;
    if (METADATA_KEY_SET.has(key)) {
      result.push(key);
    }
  }
  return result;
};

const getStringList = (params: URLSearchParams, key: string): string[] => {
  const values = params
    .get(key)
    ?.split(",")
    .map((v) => v.trim());
  // Deduplicate values
  return Array.from(new Set(values));
};

const sanitizeRelativePath = (raw: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new BadRequestError("Invalid path encoding");
  }
  const normalized = decoded.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const safeSegments: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new BadRequestError("Path traversal is not allowed");
    }
    safeSegments.push(segment);
  }
  if (safeSegments.length === 0) {
    throw new BadRequestError("Path cannot be empty");
  }
  return safeSegments.join("/");
};

const parseBoolean = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
};

const parsePositiveInteger = (name: string, value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new BadRequestError(`Query parameter "${name}" must be a positive integer`);
  }
  return parsed;
};

const parseOptionalPositiveInteger = (
  name: string,
  value: string | null,
): number | undefined => {
  if (value === null) {
    return undefined;
  }
  if (value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadRequestError(`Query parameter "${name}" must be a positive integer`);
  }
  return parsed;
};

const parseOptionalFloat = (name: string, value: string | null): number | undefined => {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestError(`Query parameter "${name}" must be a valid number`);
  }
  return parsed;
};

const parseFloatStrict = (name: string, value: string): number => {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestError(`Query parameter "${name}" must be a valid number`);
  }
  return parsed;
};

const arrayBufferToBuffer = (data: ArrayBuffer): Buffer => {
  return Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data));
};

const isFileMissingError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("not currently indexed") || message.includes("not found");
};
