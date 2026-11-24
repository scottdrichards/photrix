# fileHandling

Small, dependency-free helpers about media files themselves.

| File | What it owns |
| --- | --- |
| `fileUtils.ts` | fast dimension probes, the EXIF field mapping, GPS and date normalisation |
| `exifMetadata.type.ts` | `ExifMetadata`, the shape the EXIF stage writes to `files` |
| `mimeTypes.ts` | `mimeTypeForFilename`, the one extension → MIME table |
| `clearMirroredCacheForFile.ts` | deletes every cached derivative of a file whose bytes changed in place |

- The EXIF stage that uses these is `pipeline/processExifMetadata.ts`.
- A new EXIF field: add it to `ExifMetadata`, map it in `fileUtils.ts`, add the
  column to `indexDatabase/tables.ts`. Existing files are only re-read if a
  backfill re-queues them (see "Migrations" in `indexDatabase/README.md`).
- Values from EXIF are untrusted: normalise to a valid value or drop it, never
  store a half-parsed one.
