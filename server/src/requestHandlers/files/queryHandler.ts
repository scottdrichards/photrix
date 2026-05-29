import type * as http from "http";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import type { QueryOptions } from "../../indexDatabase/indexDatabase.type.ts";
import { writeJson } from "../../utils.ts";

export const queryHandler = async (
  url: URL,
  directoryPath: string,
  database: IndexDatabase,
  res: http.ServerResponse,
) => {
  const filterParam = url.searchParams.get("filter");
  const metadataParam = url.searchParams.get("metadata");
  const pageSize = url.searchParams.get("pageSize");
  const page = url.searchParams.get("page");
  const countOnly = url.searchParams.get("count") === "true";
  const includeSubfolders = url.searchParams.get("includeSubfolders") === "true";
  const cluster = url.searchParams.get("cluster") === "true";
  const clusterSizeParam = url.searchParams.get("clusterSize");
  const westParam = url.searchParams.get("west");
  const eastParam = url.searchParams.get("east");
  const northParam = url.searchParams.get("north");
  const southParam = url.searchParams.get("south");
  const aggregate = url.searchParams.get("aggregate");

  const filter = {
    operation: "and" as const,
    conditions: [
      ...(directoryPath || includeSubfolders
        ? [
            {
              folder: {
                folder: directoryPath ?? "/",
                recursive: includeSubfolders,
              },
            },
          ]
        : []),
      ...(filterParam ? [JSON.parse(filterParam) as QueryOptions["filter"]] : []),
    ],
  };

  // Parse metadata (comma-separated list or JSON array)
  let metadata: Array<string> = [];
  if (metadataParam) {
    try {
      // Try parsing as JSON array first
      const parsed = JSON.parse(metadataParam) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        metadata = parsed;
      } else {
        throw new Error("Invalid metadata format");
      }
    } catch {
      // Fall back to comma-separated string
      metadata = metadataParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const queryOptions = {
    filter,
    metadata: metadata as QueryOptions["metadata"],
    ...(pageSize && { pageSize: parseInt(pageSize, 10) }),
    ...(page && { page: parseInt(page, 10) }),
  };

  if (aggregate === "dateRange") {
    const { minDate, maxDate } = await (() => database.getDateRange(filter))();
    writeJson(res, 200, {
      minDate: minDate ? minDate.getTime() : null,
      maxDate: maxDate ? maxDate.getTime() : null,
    });
    return;
  }

  if (aggregate === "dateHistogram") {
    const histogram = await (() => database.getDateHistogram(filter))();
    writeJson(res, 200, histogram);
    return;
  }

  if (aggregate === "people") {
    const people = await (() =>
      database.queryFaceClusters({
        filter,
      }))();
    writeJson(res, 200, people);
    return;
  }

  if (aggregate === "peopleClusterDetail") {
    const clusterId = url.searchParams.get("clusterId");
    if (!clusterId) {
      writeJson(res, 400, { error: "Missing clusterId parameter" });
      return;
    }
    const detail = await (() =>
      database.getFaceClusterDetail({
        filter,
        clusterId,
      }))();
    writeJson(res, 200, detail);
    return;
  }

  if (cluster) {
    const parsedClusterSize = clusterSizeParam
      ? Number.parseFloat(clusterSizeParam)
      : NaN;
    const clusterSize =
      Number.isFinite(parsedClusterSize) && parsedClusterSize > 0
        ? parsedClusterSize
        : 0.00002;
    const bounds = [westParam, eastParam, northParam, southParam].every((v) => v !== null)
      ? {
          west: Number.parseFloat(westParam ?? ""),
          east: Number.parseFloat(eastParam ?? ""),
          north: Number.parseFloat(northParam ?? ""),
          south: Number.parseFloat(southParam ?? ""),
        }
      : null;
    const { clusters, total } = await (() =>
      database.queryGeoClusters({
        filter,
        clusterSize,
        bounds,
      }))();
    writeJson(res, 200, { clusters, total });
    return;
  }

  const result = await (() => database.queryFiles(queryOptions))();

  const responseBody = countOnly ? { count: result.total } : result;
  try {
    writeJson(res, 200, responseBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("invalid string length")) {
      writeJson(res, 413, {
        error: "Response too large",
        message:
          "The query result was too large to serialize. Try requesting fewer metadata fields or a smaller pageSize.",
      });
      return;
    }
    throw error;
  }
};
