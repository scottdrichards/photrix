import { access } from "node:fs/promises";
import path from "node:path";
import { FACE_CROP_HEIGHT, faceCropRegion } from "../../../shared/face-crop/src/index.ts";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { FaceClusterFace } from "../indexDatabase/indexDatabase.type.ts";
import { generateVideoFrameCrop, getVideoFrameCropCachePath } from "../videoProcessing/videoUtils.ts";
import { convertImageCrop, getImageCropCachePath } from "./convertImage.ts";

// ---------------------------------------------------------------------------
// Face crops for the People list, made ahead of time.
//
// A face crop is cut from the original, so one that isn't cached costs a full
// decode off the media share. The People tab and the face filter ask for one
// per person, a hundred at a time, two decoding at once: 1.3–1.9 s each
// (measured 2026-11-12). These are the faces everyone sees first, there are at
// most a thousand of them, and a crop is ~10 KB, so they are worth having ready.
//
// Only the list's own faces: a person's page can show thousands more, and all
// of them together are ~400k crops.
// ---------------------------------------------------------------------------

/** Read estimate for one crop. The index row a face comes with carries no file size. */
const FACE_CROP_READ_ESTIMATE_BYTES = 5 * 1024 * 1024;

const exists = (filePath: string): Promise<boolean> =>
  access(filePath).then(
    () => true,
    () => false,
  );

/**
 * The faces the People list shows by default, biggest person first: the same
 * query the People tab makes, so it also leaves that list cached.
 */
export const listPeopleFaces = async (database: IndexDatabase): Promise<FaceClusterFace[]> => {
  const hidden = await database.getDefaultExclusionFilter();
  const people = await database.faceClusters.queryFaceClusters({
    filter: hidden ? { operation: "not", conditions: [hidden] } : {},
  });
  return people.clusters.map((cluster) => cluster.representative);
};

/**
 * What it takes to make a face's crop, or null when it is already cached.
 * Checks only the local cache, never the share.
 */
export const planFaceCropWork = async (
  storagePath: string,
  face: FaceClusterFace,
): Promise<{ readBytes: number; run: () => Promise<unknown> } | null> => {
  const { x, y, w, h } = faceCropRegion(face.box);
  const crop = { x, y, width: w, height: h };
  const fullPath = path.join(storagePath, stripLeadingSlash(face.path));

  if (face.mimeType?.startsWith("video/")) {
    // A face found in a video is on one frame of it; without the frame there is nothing to cut.
    const { frameTimeMs } = face;
    if (frameTimeMs === undefined) return null;
    if (await exists(getVideoFrameCropCachePath(fullPath, frameTimeMs, crop, FACE_CROP_HEIGHT)))
      return null;
    return {
      readBytes: FACE_CROP_READ_ESTIMATE_BYTES,
      run: () => generateVideoFrameCrop(fullPath, frameTimeMs, crop, FACE_CROP_HEIGHT),
    };
  }

  if (await exists(getImageCropCachePath(fullPath, crop, FACE_CROP_HEIGHT))) return null;
  return {
    readBytes: FACE_CROP_READ_ESTIMATE_BYTES,
    run: () => convertImageCrop(fullPath, crop, FACE_CROP_HEIGHT, { priority: "background" }),
  };
};
