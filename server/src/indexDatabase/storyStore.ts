import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { decodeEmbedding } from "./embeddingCodec.ts";
import { filterToSQL } from "./filterToSQL.ts";
import type { FilterElement } from "./indexDatabase.type.ts";
import { joinPath, splitPath } from "./utils/pathUtils.ts";

export type StoryTimelineRow = {
  path: string;
  time: number;
  lat: number | null;
  lon: number | null;
  isVideo: boolean;
  rating: number | null;
  quality: number | null;
  width: number | null;
  height: number | null;
  burstMember: boolean;
};

export type StoryFaceRow = {
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string | null;
};

/** The reads behind Stories (server/src/stories): every dated item, and the faces and CLIP vectors of a story's photos. */
export class StoryStore {
  constructor(private readonly db: AsyncSqlite) {}

  /**
   * Every dated photo and video outside `exclude` (the owner's default
   * exclusion). Only the columns the detector reads: the embedding BLOBs live
   * in `fileEmbeddings`, so this scan never drags them in.
   */
  async getTimeline(exclude: FilterElement | null): Promise<StoryTimelineRow[]> {
    const { where, params } = exclude
      ? filterToSQL({ operation: "not", conditions: [exclude] })
      : { where: "", params: [] };
    const rows = await this.db.all<{
      folder: string;
      fileName: string;
      dateTaken: number;
      locationLatitude: number | null;
      locationLongitude: number | null;
      mimeType: string;
      rating: number | null;
      photoQualityScore: number | null;
      dimensionsWidth: number | null;
      dimensionsHeight: number | null;
      momentClusterId: number | null;
      momentClusterRepresentative: number | null;
    }>(
      `SELECT folder, fileName, dateTaken, locationLatitude, locationLongitude, mimeType,
              rating, photoQualityScore, dimensionsWidth, dimensionsHeight,
              momentClusterId, momentClusterRepresentative
       FROM files
       WHERE typeof(dateTaken) = 'integer'
         AND (mimeType LIKE 'image/%' OR mimeType LIKE 'video/%')
         ${where ? `AND (${where})` : ""}`,
      ...params,
    );
    return rows.map((row) => ({
      path: joinPath(row.folder, row.fileName),
      time: row.dateTaken,
      lat: row.locationLatitude,
      lon: row.locationLongitude,
      isVideo: row.mimeType.startsWith("video/"),
      rating: row.rating,
      quality: row.photoQualityScore,
      width: row.dimensionsWidth,
      height: row.dimensionsHeight,
      burstMember: row.momentClusterId !== null && !row.momentClusterRepresentative,
    }));
  }

  /**
   * Changes whenever the EXIF stage writes a file, which is what adds a dated
   * item to the timeline. An index-only MAX, so it is cheap to ask per request.
   */
  async getTimelineVersion(): Promise<number> {
    return (
      (
        await this.db.get<{ version: number | null }>(
          "SELECT MAX(exifProcessedAt) AS version FROM files",
        )
      )?.version ?? 0
    );
  }

  /** Faces found in photos (not video frames) taken in [start, end], each with its person's name if named. */
  async getFaces(start: number, end: number): Promise<StoryFaceRow[]> {
    const rows = await this.db.all<{
      folder: string;
      fileName: string;
      boxX: number;
      boxY: number;
      boxWidth: number;
      boxHeight: number;
      name: string | null;
    }>(
      `SELECT faces.folder, faces.fileName, faces.boxX, faces.boxY, faces.boxWidth, faces.boxHeight,
              COALESCE(personRoots.name, faceClusters.name) AS name
       FROM files
       JOIN faces ON faces.folder = files.folder AND faces.fileName = files.fileName
       LEFT JOIN faceClusters ON faceClusters.id = faces.clusterId
       LEFT JOIN faceClusters AS personRoots ON personRoots.id = faceClusters.personId
       WHERE files.dateTaken BETWEEN ? AND ? AND faces.frameTimeMs IS NULL`,
      start,
      end,
    );
    return rows.map((row) => ({
      path: joinPath(row.folder, row.fileName),
      x: row.boxX,
      y: row.boxY,
      width: row.boxWidth,
      height: row.boxHeight,
      name: row.name,
    }));
  }

  /** CLIP image embeddings for `paths`, decoded; photos without one are absent. */
  async getImageEmbeddings(paths: string[]): Promise<Map<string, Float32Array>> {
    const embeddings = new Map<string, Float32Array>();
    for (let offset = 0; offset < paths.length; offset += 400) {
      const batch = paths.slice(offset, offset + 400).map(splitPath);
      const rows = await this.db.all<{
        folder: string;
        fileName: string;
        imageEmbedding: Buffer | null;
      }>(
        `SELECT folder, fileName, imageEmbedding FROM fileEmbeddings
         WHERE (folder, fileName) IN (VALUES ${batch.map(() => "(?, ?)").join(", ")})`,
        ...batch.flatMap(({ folder, fileName }) => [folder, fileName]),
      );
      for (const row of rows) {
        const embedding = decodeEmbedding(row.imageEmbedding);
        if (embedding) embeddings.set(joinPath(row.folder, row.fileName), embedding);
      }
    }
    return embeddings;
  }
}
