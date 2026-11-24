import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("IndexDatabase");

// PRAGMA user_version marking that the one-time EXIF re-extraction pass for the
// new human-authored `description` column has been queued. Bumps the monotonic
// scheme above MERGED_SIMILARITY_RESCORE_VERSION. Clears exifProcessedAt on
// already-processed images so processExifMetadata re-reads their headers and
// fills in `description` (and any other fields added since they were scanned).
const EXIF_DESCRIPTION_BACKFILL_VERSION = 3;

// PRAGMA user_version marking that HEIC/HEIF files have been re-queued for
// EXIF re-scan so the new embeddedVideoLength column (Samsung motion photos)
// gets populated for existing files.
const HEIC_EMBEDDED_VIDEO_BACKFILL_VERSION = 5;

// PRAGMA user_version marking that all images have been re-queued for EXIF
// re-scan so the `tags` column (XMP dc:subject / IPTC Keywords /
// lr:hierarchicalSubject — human-authored keyword/person tags, e.g. "Jeffrey
// Goodsell; Timothy Goodsell") gets backfilled. The `tags` field mapping in
// fileUtils.ts's exifFieldMapping has existed since before
// EXIF_DESCRIPTION_BACKFILL_VERSION (3) ran, but as of 2026-08-31 zero of
// ~195k indexed files had a non-null `tags` value even though exifr
// correctly extracts it from real library files on demand — the one full
// library re-scan that would have populated it (v3, for `description`) ran
// before the extraction path worked end-to-end (and separately, IPTC segment
// parsing was never enabled — see the `iptc: true` fix alongside this
// migration). Re-queuing is required, not just fixing the extractor, because
// nothing else invalidates exifProcessedAt on ordinary code changes.
const TAGS_BACKFILL_VERSION = 6;

/**
 * One-time re-queues of already-processed files for EXIF re-scan, each gated by
 * PRAGMA user_version. They only clear `exifProcessedAt`; nothing is re-read
 * here. `invalidateStatusCounts` drops the cached "missing metadata" count.
 */
export class ExifBackfills {
  constructor(
    private readonly db: AsyncSqlite,
    private readonly invalidateStatusCounts: () => void,
  ) {}

  /**
   * One-time migration (gated by PRAGMA user_version) that re-queues images for
   * EXIF extraction so the newly-added human-authored `description` column is
   * backfilled from their file headers. Images scanned before the column existed
   * carry a non-null exifProcessedAt, so processExifMetadata would otherwise skip
   * them forever. Clearing exifProcessedAt (only for already-processed images)
   * puts them back on the "needs EXIF" queue; the re-read is header-only and the
   * extraction is idempotent for every other field. New files are unaffected.
   */
  async backfillExifDescriptions(): Promise<void> {
    const versionRow = await this.db.get<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if ((versionRow?.user_version ?? 0) >= EXIF_DESCRIPTION_BACKFILL_VERSION) return;

    const result = await this.db.run(
      `UPDATE files SET exifProcessedAt = NULL
       WHERE exifProcessedAt IS NOT NULL
         AND mimeType LIKE 'image/%'
         AND description IS NULL`,
    );

    await this.db.exec(`PRAGMA user_version = ${EXIF_DESCRIPTION_BACKFILL_VERSION}`);
    this.invalidateStatusCounts();
    log.info(
      { requeued: result?.changes ?? 0 },
      "Re-queued images for EXIF re-scan to backfill human descriptions",
    );
  }

  /**
   * One-time migration (gated by PRAGMA user_version) that re-queues every
   * already-processed image for EXIF re-scan so the `tags` column (see
   * TAGS_BACKFILL_VERSION above) gets backfilled from XMP dc:subject / IPTC
   * Keywords / lr:hierarchicalSubject. Scoped to `tags IS NULL` so it never
   * re-queues (and thus never clobbers) a file whose tags were already
   * extracted or user-edited in-app.
   */
  async backfillTags(): Promise<void> {
    const versionRow = await this.db.get<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if ((versionRow?.user_version ?? 0) >= TAGS_BACKFILL_VERSION) return;

    const result = await this.db.run(
      `UPDATE files SET exifProcessedAt = NULL
       WHERE exifProcessedAt IS NOT NULL
         AND mimeType LIKE 'image/%'
         AND tags IS NULL`,
    );

    await this.db.exec(`PRAGMA user_version = ${TAGS_BACKFILL_VERSION}`);
    this.invalidateStatusCounts();
    log.info(
      { requeued: result?.changes ?? 0 },
      "Re-queued images for EXIF re-scan to backfill human-authored tags/keywords",
    );
  }

  async backfillHeicEmbeddedVideoDetection(): Promise<void> {
    const versionRow = await this.db.get<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if ((versionRow?.user_version ?? 0) >= HEIC_EMBEDDED_VIDEO_BACKFILL_VERSION) return;

    const result = await this.db.run(
      `UPDATE files SET exifProcessedAt = NULL
       WHERE exifProcessedAt IS NOT NULL
         AND mimeType IN ('image/heic', 'image/heif')`,
    );

    await this.db.exec(`PRAGMA user_version = ${HEIC_EMBEDDED_VIDEO_BACKFILL_VERSION}`);
    this.invalidateStatusCounts();
    log.info(
      { requeued: result?.changes ?? 0 },
      "Re-queued HEIC/HEIF files for EXIF re-scan to detect embedded Samsung motion photos",
    );
  }
}
