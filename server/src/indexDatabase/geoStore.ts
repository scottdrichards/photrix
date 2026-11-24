import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { filterToSQL } from "./filterToSQL.ts";
import type { GeoClusterResult, QueryOptions } from "./indexDatabase.type.ts";

// Ceiling on map pins returned by one queryGeoClusters call. The caller picks a
// bucket size for the current viewport, so a well-behaved request lands far
// under this; the limit exists so a pathological bucket size cannot serialize an
// unbounded result set. Buckets are ordered by count, so the densest — the ones
// worth seeing — survive the cut, and the response's `total` still reflects
// every matching item so the client can say the view is limited.
const GEO_CLUSTER_LIMIT = 10_000;

// Separator joining folder and fileName inside queryGeoClusters' MIN() sample
// key. Must sort below every character a path can contain and never appear in
// one; see the query for why both properties matter.
const SAMPLE_KEY_SEPARATOR = "\u0001";

/** Map pins: geotagged files bucketed by viewport-sized cells. */
export class GeoStore {
  constructor(private readonly db: AsyncSqlite) {}

  async queryGeoClusters(options: {
    filter: QueryOptions["filter"];
    clusterSize: number;
    bounds?: { west: number; east: number; north: number; south: number } | null;
    limit?: number;
  }): Promise<GeoClusterResult> {
    const { filter, clusterSize, bounds, limit = GEO_CLUSTER_LIMIT } = options;
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const bucket = Math.max(clusterSize, 0.00000001);
    const latOrigin = Math.floor((bounds?.south ?? 0) / bucket) * bucket;
    const lonOrigin = Math.floor((bounds?.west ?? 0) / bucket) * bucket;

    const rows = await this.db.all<{
      latitude: number;
      longitude: number;
      count: number;
      sampleKey: string | null;
      minDate: number | null;
      maxDate: number | null;
      totalCount: number | null;
    }>(
      // One pass: bucket, aggregate, done. An earlier version added a second
      // ROW_NUMBER() pass over every geotagged row and joined it back just to
      // pick each bucket's sample file; a MIN() over the joined columns picks
      // the same row directly, for half the time on the 191k-row library.
      //
      // The CHAR(1) separator is what makes that substitution exact. Plain
      // `folder || fileName` compares the two as one string, which disagrees
      // with ORDER BY folder, fileName whenever one folder is a prefix of
      // another ("/IMG.JPG" vs "/2014/.../x.jpg"). CHAR(1) sorts below every
      // character that can appear in a path, so the concatenation orders exactly
      // as the column pair did — and since no path contains it, splitting on it
      // recovers folder and fileName unambiguously. They are split here rather
      // than selected as bare columns because SQLite only pins bare columns to
      // the min/max row when the query has exactly one min()/max() aggregate;
      // this one has three.
      //
      // `sortDate` mirrors the library's default ordering (dateTaken, falling
      // back to created/modified). The typeof(...) = 'integer' guards keep rows
      // whose date was ingested as a TEXT/ISO string out of MIN/MAX — SQLite
      // sorts TEXT above every INTEGER, so one stray string poisons the max
      // (same hazard getDateRange guards against).
      //
      // totalCount is a window function, so it sums every bucket's count before
      // LIMIT trims the result — that is what lets the caller tell a complete
      // answer from a truncated one.
      `SELECT
         (latBucket + 0.5) * ? + ? AS latitude,
         (lonBucket + 0.5) * ? + ? AS longitude,
         count,
         minDate,
         maxDate,
         sampleKey,
         SUM(count) OVER () AS totalCount
       FROM (
         SELECT
           CAST(FLOOR((locationLatitude - ?) / ?) AS INTEGER) AS latBucket,
           CAST(FLOOR((locationLongitude - ?) / ?) AS INTEGER) AS lonBucket,
           COUNT(*) AS count,
           MIN(CASE
             WHEN typeof(dateTaken) = 'integer' THEN dateTaken
             WHEN typeof(created) = 'integer' THEN created
             WHEN typeof(modified) = 'integer' THEN modified
           END) AS minDate,
           MAX(CASE
             WHEN typeof(dateTaken) = 'integer' THEN dateTaken
             WHEN typeof(created) = 'integer' THEN created
             WHEN typeof(modified) = 'integer' THEN modified
           END) AS maxDate,
           MIN(folder || CHAR(1) || fileName) AS sampleKey
         FROM files
         WHERE locationLatitude IS NOT NULL
           AND locationLongitude IS NOT NULL
           ${whereClause ? `AND ${whereClause}` : ""}
         GROUP BY latBucket, lonBucket
       )
       ORDER BY count DESC
       LIMIT ?`,
      bucket,
      latOrigin,
      bucket,
      lonOrigin,
      latOrigin,
      bucket,
      lonOrigin,
      bucket,
      ...whereParams,
      limit,
    );

    // Every row carries the same window-function total; with no rows there is
    // nothing to count.
    const total = rows[0]?.totalCount ?? 0;

    return {
      clusters: rows.map(({ totalCount: _totalCount, sampleKey, ...row }) => {
        const separator = sampleKey?.indexOf(SAMPLE_KEY_SEPARATOR) ?? -1;
        return {
          ...row,
          samplePath:
            separator === -1 ? null : sampleKey!.replace(SAMPLE_KEY_SEPARATOR, ""),
          sampleName: separator === -1 ? null : sampleKey!.slice(separator + 1),
        };
      }),
      total,
    };
  }
}
