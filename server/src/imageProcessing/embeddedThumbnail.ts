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
 *
 * Some cameras (e.g. Canon DSLRs) also embed a 4:3 thumbnail for a 3:2 image,
 * because the LCD preview uses a 4:3 crop. The thumbnail is cropped to the
 * source's true aspect ratio so the micro and sharp thumbnails both show the
 * same framing inside the justified grid.
 *
 * Cache key uses "micro2" — files previously generated as "micro" had the wrong
 * aspect for Canon (and similar) sources and are intentionally orphaned.
 */
export const convertEmbeddedThumbnail = async (
  filePath: string,
  maxHeight = 160,
): Promise<string | null> => {
  const cachedPath = getMirroredCachedFilePath(
    filePath,
    `${maxHeight}.micro2`,
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

  // `appliedRotation` is non-null only when orientation correction was actually
  // needed, which lets later code use it as both a "did we rotate?" flag and a
  // source of the dimensionSwapped field without extra null checks.
  const appliedRotation =
    rotation && shouldApplyOrientation(rotation, sourceDims, thumbMeta) ? rotation : null;

  let pipeline = sharp(thumbBuffer);
  if (appliedRotation) {
    if (appliedRotation.scaleX === -1) pipeline = pipeline.flop();
    if (appliedRotation.scaleY === -1) pipeline = pipeline.flip();
    if (appliedRotation.deg) pipeline = pipeline.rotate(appliedRotation.deg);
  }

  // Compute the source image's display aspect ratio from EXIF dimension tags,
  // accounting for any dimension swap the orientation rotation introduced.
  const srcWraw = sourceDims?.ExifImageWidth ?? sourceDims?.ImageWidth;
  const srcHraw = sourceDims?.ExifImageHeight ?? sourceDims?.ImageHeight;
  const targetAspect = (() => {
    if (!srcWraw || !srcHraw) return null;
    // For orientation 5–8 the display dimensions are the sensor ones transposed.
    const swapped = appliedRotation?.dimensionSwapped ?? false;
    const dw = swapped ? srcHraw : srcWraw;
    const dh = swapped ? srcWraw : srcHraw;
    return dh > 0 ? dw / dh : null;
  })();

  // Thumbnail natural aspect after any orientation rotation.
  const thumbAspect = (() => {
    if (!thumbMeta?.width || !thumbMeta?.height) return null;
    return (appliedRotation?.dimensionSwapped ?? false)
      ? thumbMeta.height / thumbMeta.width
      : thumbMeta.width / thumbMeta.height;
  })();

  // When the embedded thumbnail's aspect differs meaningfully from the source
  // (Canon DSLRs embed 4:3 LCD-crop thumbnails for 3:2 sensor images), use
  // cover+crop so the micro and sharp thumbnails frame the image identically.
  // A 4% tolerance avoids unnecessary processing for near-equal ratios.
  const ASPECT_TOLERANCE = 0.04;
  const needsCrop =
    targetAspect !== null &&
    thumbAspect !== null &&
    Math.abs(thumbAspect - targetAspect) > ASPECT_TOLERANCE;

  if (needsCrop && targetAspect !== null) {
    // Cap the long side to maxHeight, derive the short side from targetAspect.
    // Landscape (aspect ≥ 1): long side = width → width=maxHeight, height=maxHeight/aspect.
    // Portrait  (aspect < 1): long side = height → height=maxHeight, width=maxHeight*aspect.
    const resizeW = targetAspect >= 1 ? maxHeight : Math.round(maxHeight * targetAspect);
    const resizeH = targetAspect >= 1 ? Math.round(maxHeight / targetAspect) : maxHeight;
    pipeline = pipeline.resize({
      width: resizeW,
      height: resizeH,
      fit: "cover",
      position: "centre",
      withoutEnlargement: true,
    });
  } else {
    pipeline = pipeline.resize({
      height: maxHeight,
      width: maxHeight,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  await mkdir(dirname(cachedPath), { recursive: true });
  await pipeline.webp({ quality: 80 }).toFile(cachedPath);

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
