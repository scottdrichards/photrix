import type * as http from "http";
import path from "path";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import type { QueryOptions } from "../../indexDatabase/indexDatabase.type.ts";
import { parseSort } from "../../../../shared/filter-contract/src/index.ts";
import { getFastMediaDimensions } from "../../fileHandling/fileUtils.ts";
import { stripLeadingSlash } from "../../common/stripLeadingSlash.ts";
import { writeJson } from "../../utils.ts";

export const queryHandler = async (
  url: URL,
  directoryPath: string,
  database: IndexDatabase,
  res: http.ServerResponse,
  shareFilter: unknown = null,
) => {
  const filterParam = url.searchParams.get("filter");
  const metadataParam = url.searchParams.get("metadata");
  const pageSize = url.searchParams.get("pageSize");
  const page = url.searchParams.get("page");
  const countOnly = url.searchParams.get("count") === "true";
  const includeSubfolders = url.searchParams.get("includeSubfolders") === "true";
  const expandToFolder = url.searchParams.get("expandToFolder") === "true";
  const cluster = url.searchParams.get("cluster") === "true";
  const collapseMomentClustersParam = url.searchParams.get("collapseMomentClusters");
  const clusterSizeParam = url.searchParams.get("clusterSize");
  const westParam = url.searchParams.get("west");
  const eastParam = url.searchParams.get("east");
  const northParam = url.searchParams.get("north");
  const southParam = url.searchParams.get("south");
  const aggregate = url.searchParams.get("aggregate");
  // Feedback #95: a standing "hide these by default" filter the user sets
  // once (see peopleRequestHandler's /api/settings/default-exclusion) and
  // that then applies to every view funneling through this one handler —
  // grid, map, people, date histograms — without being re-selected each
  // time. `includeExcluded=true` is the per-request opt-out.
  const includeExcluded = url.searchParams.get("includeExcluded") === "true";
  const defaultExclusionFilter = includeExcluded
    ? null
    : await database.getDefaultExclusionFilter();

  const filter = {
    operation: "and" as const,
    conditions: [
      ...(shareFilter ? [shareFilter as QueryOptions["filter"]] : []),
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
      ...(defaultExclusionFilter
        ? [{ operation: "not" as const, conditions: [defaultExclusionFilter] }]
        : []),
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
    // A count-only request discards `items`, so cap the page to 0 rows: the count
    // query runs regardless, but this avoids materializing (and serializing) a
    // full page of records only to throw them away.
    ...(countOnly
      ? { pageSize: 0 }
      : pageSize
        ? { pageSize: parseInt(pageSize, 10) }
        : {}),
    ...(page && { page: parseInt(page, 10) }),
    ...(expandToFolder && { expandToFolder: true }),
    ...(collapseMomentClustersParam === "false" && { collapseMomentClusters: false }),
    ...(() => {
      const sort = parseSort(url.searchParams.get("sort"));
      return sort ? { sort } : {};
    })(),
  };

  if (aggregate === "dateRange") {
    const { minDate, maxDate } = await database.getDateRange(filter);
    writeJson(res, 200, {
      minDate: minDate ? minDate.getTime() : null,
      maxDate: maxDate ? maxDate.getTime() : null,
    });
    return;
  }

  if (aggregate === "dateHistogram") {
    const bucketsParam = url.searchParams.get("buckets");
    const parsedBuckets = bucketsParam ? Number.parseInt(bucketsParam, 10) : NaN;
    const histogram = await database.getDateHistogram(
      filter,
      Number.isFinite(parsedBuckets) ? parsedBuckets : undefined,
    );
    writeJson(res, 200, histogram);
    return;
  }

  if (aggregate === "people") {
    const people = await database.queryFaceClusters({ filter });
    writeJson(res, 200, people);
    return;
  }

  if (aggregate === "faceCentroidsPCA") {
    const result = await database.getFaceClustersPCA(
      url.searchParams.get("clusterId") ?? undefined,
    );
    writeJson(res, 200, result);
    return;
  }

  if (aggregate === "facesForFile") {
    const filePath = url.searchParams.get("path");
    if (!filePath) {
      writeJson(res, 400, { error: "Missing path parameter" });
      return;
    }
    const faces = await database.getPeopleFacesForFile(stripLeadingSlash(filePath));
    writeJson(res, 200, { faces });
    return;
  }

  if (aggregate === "peopleClusterDetail") {
    const clusterId = url.searchParams.get("clusterId");
    if (!clusterId) {
      writeJson(res, 400, { error: "Missing clusterId parameter" });
      return;
    }
    // Feedback #105: "View" on a Match Group needs the literal sub-cluster's
    // faces, not the merged person it belongs to — see the comment on
    // getFaceClusterDetail's `exactCluster` option.
    const exactCluster = url.searchParams.get("exactCluster") === "true";
    const detail = await database.getFaceClusterDetail({ filter, clusterId, exactCluster });
    writeJson(res, 200, detail);
    return;
  }

  if (aggregate === "momentClusterDetail") {
    const clusterId = url.searchParams.get("clusterId");
    if (!clusterId) {
      writeJson(res, 400, { error: "Missing clusterId parameter" });
      return;
    }
    const detail = await database.getMomentClusterDetail(clusterId);
    writeJson(res, 200, { cluster: detail });
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
    const { clusters, total } = await database.queryGeoClusters({
      filter,
      clusterSize,
      bounds,
    });
    writeJson(res, 200, { clusters, total });
    return;
  }

  const result = await database.queryFiles(queryOptions);

  if (!countOnly) {
    const itemsMissingDims = result.items.filter(
      (item) => !("dimensionWidth" in item) && item.mimeType?.startsWith("image/"),
    );
    if (itemsMissingDims.length > 0) {
      const reads = Promise.allSettled(
        itemsMissingDims.map(async (item) => {
          const relativePath = item.folder + item.fileName;
          const fullPath = path.join(
            database.storagePath,
            stripLeadingSlash(relativePath),
          );
          const dims = await getFastMediaDimensions(fullPath);
          if (dims.dimensionWidth !== undefined) {
            (item as Record<string, unknown>).dimensionWidth = dims.dimensionWidth;
          }
          if (dims.dimensionHeight !== undefined) {
            (item as Record<string, unknown>).dimensionHeight = dims.dimensionHeight;
          }
        }),
      );
      // Cap how long we wait: if the filesystem is slow (NFS/SMB), don't let
      // dimension lookups add more than 200 ms to the response. Any reads that
      // finish within the window contribute their dimensions; the rest are left
      // for the background fill-in task.
      await Promise.race([reads, new Promise<void>((r) => setTimeout(r, 200))]);
    }
  }

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
