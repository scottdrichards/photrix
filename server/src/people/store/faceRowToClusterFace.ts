import type { FaceClusterFace } from "./indexDatabase.type.ts";
import { joinPath } from "./utils/pathUtils.ts";

export const faceRowToClusterFace = (row: {
  id: number;
  folder: string;
  fileName: string;
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
  mimeType: string | null;
  dimensionWidth: number | null;
  dimensionHeight: number | null;
  regions: string | null;
  dateTaken?: number | null;
  // Every query feeding this mapper must SELECT faces.frameTimeMs: without it a
  // video face's crop has no frame to come from (videoFaces.spec.ts).
  frameTimeMs: number | null;
}): FaceClusterFace => ({
  path: joinPath(row.folder, row.fileName),
  fileName: row.fileName,
  box: {
    x: row.boxX,
    y: row.boxY,
    width: row.boxWidth,
    height: row.boxHeight,
  },
  mimeType: row.mimeType,
  dimensionWidth: row.dimensionWidth,
  dimensionHeight: row.dimensionHeight,
  regions: row.regions,
  faceId: row.id,
  ...(typeof row.frameTimeMs === "number" ? { frameTimeMs: row.frameTimeMs } : {}),
  ...(row.dateTaken !== undefined
    ? { dateTaken: row.dateTaken === null ? null : new Date(row.dateTaken).toISOString() }
    : {}),
});
