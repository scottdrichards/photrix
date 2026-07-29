import exifr from "exifr";
import sharp from "sharp";
import { access, mkdir } from "fs/promises";
import { dirname } from "path";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import { IMAGE_OUTPUT_EXTENSION } from "./convertImage.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("embeddedThumbnail");

const fileExists = async (path: string): Promise<boolean> =>
  await access(path).then(
    () => true,
    () => false,
  );

/**
 * exifr's rotation descriptor: the transform needed to display the image
 * upright. `deg` is clockwise degrees, `scaleX`/`scaleY` are -1 for a mirror,
 * and `dimensionSwapped` is true when the rotation is 90°/270° (so the upright
 * width/height are swapped relative to the stored pixels).
 */
type Rotation = {
  deg: number;
  scaleX: number;
  scaleY: number;
  dimensionSwapped: boolean;
};

/** Source (unrotated sensor) dimensions, as reported by exifr from the header. */
type SourceDims = {
  ExifImageWidth?: number;
  ExifImageHeight?: number;
  ImageWidth?: number;
  ImageHeight?: number;
};

/**
 * Extract a JPEG's embedded EXIF thumbnail and re-encode it as a small WebP,
 * reading only the file header — never the full multi-MB image. This is the
 * fast, I/O-cheap path for grid tiles: ~89% of JPEGs carry a ~160px thumbnail in
 * their header, so we avoid a full decode entirely.
 *
 * Returns the cached WebP path, or `null` when the file has no usable embedded
 * thumbnail (all HEIC, ~11% of JPEGs) so the caller can fall back to a normal
 * full-decode conversion.
 *
 * The extracted thumbnail bytes carry no EXIF of their own, so orientation is
 * applied explicitly from the source's EXIF. Some cameras store the thumbnail
 * already rotated to display orientation; to avoid double-rotating those, the
 * rotation is skipped when the thumbnail's stored aspect doesn't match the
 * source sensor's aspect (the "verify aspect + orientation" guard).
 */
export const convertEmbeddedThumbnail = async (
  filePath: string,
  maxHeight = 160,
): Promise<string | null> => {
  const cachedPath = getMirroredCachedFilePath(
    filePath,
    `${maxHeight}.micro`,
    IMAGE_OUTPUT_EXTENSION,
  );
  if (await fileExists(cachedPath)) {
    return cachedPath;
  }

  let thumb: Uint8Array | undefined;
  try {
    thumb = await exifr.thumbnail(filePath);
  } catch (error) {
    // A malformed EXIF block is not fatal — fall back to a full decode.
    log.debug({ filePath, err: error }, "Embedded thumbnail extraction failed");
    return null;
  }
  if (!thumb || thumb.length === 0) {
    return null;
  }
  const thumbBuffer = Buffer.from(thumb);

  // Orientation + sensor dimensions come from separate header-only reads.
  const [rotation, sourceDims, thumbMeta] = await Promise.all([
    exifr.rotation(filePath).then(
      (r): Rotation | null => r as Rotation | null,
      () => null,
    ),
    exifr
      .parse(filePath, {
        pick: ["ExifImageWidth", "ExifImageHeight", "ImageWidth", "ImageHeight"],
      })
      .then(
        (d): SourceDims | null => d as SourceDims | null,
        () => null,
      ),
    sharp(thumbBuffer)
      .metadata()
      .then(
        (m) => m,
        () => null,
      ),
  ]);

  let pipeline = sharp(thumbBuffer);
  if (rotation && shouldApplyOrientation(rotation, sourceDims, thumbMeta)) {
    if (rotation.scaleX === -1) pipeline = pipeline.flop();
    if (rotation.scaleY === -1) pipeline = pipeline.flip();
    if (rotation.deg) pipeline = pipeline.rotate(rotation.deg);
  }

  await mkdir(dirname(cachedPath), { recursive: true });
  await pipeline
    .resize({
      height: maxHeight,
      width: maxHeight,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 80 })
    .toFile(cachedPath);

  return cachedPath;
};

/**
 * Decide whether to apply the source's EXIF orientation to the extracted
 * thumbnail. For rotations that swap dimensions (90°/270°), an unrotated
 * thumbnail's landscape/portrait orientation matches the sensor's; if instead it
 * matches the *upright* orientation, the camera pre-rotated the thumbnail and
 * applying the rotation again would be wrong — so skip it. When source or
 * thumbnail dimensions are unknown, apply the correction (best effort).
 */
const shouldApplyOrientation = (
  rotation: Rotation,
  sourceDims: SourceDims | null,
  thumbMeta: { width?: number; height?: number } | null,
): boolean => {
  if (!rotation.dimensionSwapped) {
    return true; // 0°/180° and pure mirrors don't change aspect — always safe.
  }
  const srcW = sourceDims?.ExifImageWidth ?? sourceDims?.ImageWidth;
  const srcH = sourceDims?.ExifImageHeight ?? sourceDims?.ImageHeight;
  const thumbW = thumbMeta?.width;
  const thumbH = thumbMeta?.height;
  if (!srcW || !srcH || !thumbW || !thumbH) {
    return true;
  }
  const sensorLandscape = srcW >= srcH;
  const thumbLandscape = thumbW >= thumbH;
  // Thumbnail is in sensor orientation (unrotated) → matches the sensor aspect.
  return thumbLandscape === sensorLandscape;
};
