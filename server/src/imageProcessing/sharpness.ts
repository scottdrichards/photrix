import sharp from "sharp";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("sharpness");

/**
 * Side length (px) the image is downscaled to before the Laplacian pass.
 * Moment clustering only needs sharpness *relative to other members of the
 * same burst*, not an absolute measure, so this is deliberately tiny — small
 * enough that decoding + the variance pass cost single-digit milliseconds per
 * photo even on a large library, while still preserving enough detail for a
 * blurry frame's edge energy to read lower than a sharp one's.
 */
const SHARPNESS_SAMPLE_SIZE = 256;

/**
 * Computes a Laplacian-variance sharpness score for an image file.
 *
 * This is the classic cheap blur metric: convolve a grayscale downsample with
 * the discrete Laplacian kernel (edge/detail response), then take the
 * variance of the result. A sharp, detailed photo has strong edges throughout
 * and a high variance; a blurry or flat one has weak, smoothed-out edges and a
 * low variance.
 *
 * Deliberately *not* normalized to 0..1 here — the raw variance has no fixed
 * ceiling (it scales with image content, not just blur), so callers that need
 * a bounded score should min-max normalize across the specific set of photos
 * being compared (e.g. the members of one moment cluster), not against some
 * global constant.
 *
 * Returns `null` (never throws) when the file can't be decoded — corrupt,
 * truncated, or a format `sharp` doesn't support. Same "unknown, not zero"
 * convention as the rest of the analysis pipeline (see faceDetection's
 * FaceQualityInputs): a photo whose sharpness could not be measured must not
 * be read as "definitely blurry".
 */
export const computeSharpnessScore = async (fullPath: string): Promise<number | null> => {
  try {
    const { data, info } = await sharp(fullPath)
      .rotate() // apply EXIF orientation so the sample isn't sideways
      .resize(SHARPNESS_SAMPLE_SIZE, SHARPNESS_SAMPLE_SIZE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    if (width < 3 || height < 3) return null;

    // 3x3 discrete Laplacian: center*4 minus the four orthogonal neighbors.
    // Skips the 1px border so every sample has all four neighbors in bounds.
    let sum = 0;
    let sumSquares = 0;
    let count = 0;
    for (let y = 1; y < height - 1; y += 1) {
      const row = y * width;
      const rowAbove = row - width;
      const rowBelow = row + width;
      for (let x = 1; x < width - 1; x += 1) {
        const laplacian =
          4 * data[row + x] -
          data[row + x - 1] -
          data[row + x + 1] -
          data[rowAbove + x] -
          data[rowBelow + x];
        sum += laplacian;
        sumSquares += laplacian * laplacian;
        count += 1;
      }
    }
    if (count === 0) return null;

    const mean = sum / count;
    const variance = sumSquares / count - mean * mean;
    return Number.isFinite(variance) && variance >= 0 ? variance : null;
  } catch (error) {
    log.debug({ err: error, path: fullPath }, "Sharpness scoring failed; leaving unknown");
    return null;
  }
};
