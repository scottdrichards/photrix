import type { AsyncSqlite } from "../../common/asyncSqlite.ts";
import { faceClusterIdToString } from "./faceClusterId.ts";

/** Who has a name: the named-people lists and per-file counts behind autocomplete, search and share previews. */
export class NamedPeopleQueries {
  constructor(private readonly db: AsyncSqlite) {}

  /**
   * Every currently-named person, for the face-assign panel's "type an
   * existing name" autocomplete. Only a canonical/root cluster row ever
   * carries a name: `renameCluster` always writes it onto the effective
   * root, and `mergeClusters` immediately nulls it off any row it merges
   * away — so a plain `name IS NOT NULL` is sufficient (no need to also
   * check `personId`, which points at the row's *own* id for a named,
   * never-merged root rather than staying NULL — see renameCluster). This
   * stays a small result set (dozens, not the library's full cluster count)
   * regardless of how many total face clusters exist.
   */
  async listNamedPeople(): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.db.all<{ id: number; name: string }>(
      `SELECT id, name FROM faceClusters
       WHERE name IS NOT NULL
       ORDER BY name COLLATE NOCASE`,
    );
    return rows.map((row) => ({ id: faceClusterIdToString(row.id), name: row.name }));
  }

  /** The named people with the most faces, most first: the ones a search is likeliest to mean. */
  async listMostSeenNamedPeople(limit: number): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.db.all<{ id: number; name: string }>(
      `SELECT id, name FROM faceClusters
        WHERE name IS NOT NULL AND TRIM(name) != ''
        ORDER BY weight DESC
        LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({ id: faceClusterIdToString(row.id), name: row.name }));
  }

  /**
   * Display names for the given face-cluster ids, resolved through merges the
   * same way `getPeopleFacesForFile` does. Unnamed clusters are omitted.
   */
  async getFaceClusterNames(clusterIds: number[]): Promise<Map<number, string>> {
    if (clusterIds.length === 0) return new Map();
    const rows = await this.db.all<{ id: number; name: string | null }>(
      `SELECT cluster.id AS id, person.name AS name
         FROM faceClusters AS cluster
         LEFT JOIN faceClusters AS person
           ON person.id = COALESCE(cluster.personId, cluster.id)
        WHERE cluster.id IN (${clusterIds.map(() => "?").join(", ")})`,
      ...clusterIds,
    );
    return new Map(
      rows.flatMap((row) =>
        row.name ? ([[row.id, row.name]] as [number, string][]) : [],
      ),
    );
  }

  /**
   * Distinct *named* people per file, keyed by `folder + fileName`. Ranks
   * share-preview candidates: among equally-rated photos, one with several
   * recognized people makes a better link thumbnail than a landscape.
   */
  async countNamedPeopleForFiles(
    files: Array<{ folder: string; fileName: string }>,
  ): Promise<Map<string, number>> {
    if (files.length === 0) return new Map();
    const rows = await this.db.all<{ folder: string; fileName: string; count: number }>(
      `SELECT faces.folder AS folder,
              faces.fileName AS fileName,
              COUNT(DISTINCT COALESCE(cluster.personId, faces.clusterId)) AS count
         FROM faces
         JOIN faceClusters AS cluster ON cluster.id = faces.clusterId
         JOIN faceClusters AS person
           ON person.id = COALESCE(cluster.personId, faces.clusterId)
        WHERE person.name IS NOT NULL
          AND (${files.map(() => "(faces.folder = ? AND faces.fileName = ?)").join(" OR ")})
        GROUP BY faces.folder, faces.fileName`,
      ...files.flatMap(({ folder, fileName }) => [folder, fileName]),
    );
    return new Map(rows.map((row) => [row.folder + row.fileName, row.count]));
  }
}
