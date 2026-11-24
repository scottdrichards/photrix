import { existsSync } from "node:fs";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import { convertImage, IMAGE_OUTPUT_EXTENSION } from "./convertImage.ts";
import { convertEmbeddedThumbnail } from "./embeddedThumbnail.ts";

// Fixed size for the progressive-grid micro thumbnail. Matches the largest
// commonly-available embedded EXIF thumbnail; the grid upgrades to the 320 tile
// lazily on dwell/hover.
const MICRO_THUMBNAIL_HEIGHT = 160;

/**
 * The cached file for an image's `micro` grid tile, made if need be.
 *
 * Instant and I/O-cheap where it can be: a JPEG's embedded EXIF thumbnail (a
 * header-only read) instead of decoding the full source. Files without one
 * (all HEIC, ~11% of JPEGs) fall back to a normal 160 full-decode conversion,
 * so this always resolves to a 160 tile. Throws `ImageConversionError` for an
 * undecodable image.
 */
export const microThumbnailPath = async (sourcePath: string): Promise<string> => {
  // A decoded 160 exists only for files with no usable embedded thumbnail
  // (made on an earlier request or by the overnight backfill). Checking it
  // first skips the header read off the share that would just find none again.
  const decodedPath = getMirroredCachedFilePath(
    sourcePath,
    MICRO_THUMBNAIL_HEIGHT,
    IMAGE_OUTPUT_EXTENSION,
  );
  return (
    (existsSync(decodedPath) ? decodedPath : null) ??
    (await convertEmbeddedThumbnail(sourcePath, MICRO_THUMBNAIL_HEIGHT)) ??
    (await convertImage(sourcePath, MICRO_THUMBNAIL_HEIGHT, { priority: "userBlocked" }))
  );
};
