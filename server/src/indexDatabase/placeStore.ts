import { AsyncSqlite } from "../common/asyncSqlite.ts";

/** The `files.placeText` column: where a geotagged photo was taken, as searchable words. */
export class PlaceStore {
  constructor(private readonly db: AsyncSqlite) {}

  /**
   * Geotagged files that have no place text yet. `placeText` is NULL until the
   * backfill looks at a file and "" once it has looked and found no city
   * nearby, so a file is never offered twice.
   */
  async getPlaceBackfillBatch(
    limit: number,
  ): Promise<Array<{ folder: string; fileName: string; lat: number; lon: number }>> {
    const rows = await this.db.all<{
      folder: string;
      fileName: string;
      locationLatitude: number;
      locationLongitude: number;
    }>(
      `SELECT folder, fileName, locationLatitude, locationLongitude
       FROM files
       WHERE placeText IS NULL
         AND locationLatitude IS NOT NULL AND locationLongitude IS NOT NULL
       LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({
      folder: row.folder,
      fileName: row.fileName,
      lat: row.locationLatitude,
      lon: row.locationLongitude,
    }));
  }

  async setPlaceTexts(
    updates: ReadonlyArray<{ folder: string; fileName: string; placeText: string }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    await this.db.transaction(
      updates.map((update) => ({
        sql: "UPDATE files SET placeText = ? WHERE folder = ? AND fileName = ?",
        params: [update.placeText, update.folder, update.fileName],
      })),
    );
  }

  async getPlaceProgress(): Promise<{ processed: number; pending: number }> {
    const row = await this.db.get<{ processed: number | null; pending: number | null }>(
      `SELECT
         SUM(placeText IS NOT NULL) AS processed,
         SUM(placeText IS NULL) AS pending
       FROM files
       WHERE locationLatitude IS NOT NULL AND locationLongitude IS NOT NULL`,
    );
    return { processed: row?.processed ?? 0, pending: row?.pending ?? 0 };
  }
}
