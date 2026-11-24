# imageProcessing

Turns an original image into what the browser is sent, and a few per-image
measurements.

| File | What it owns |
| --- | --- |
| `convertImage.ts` | resizes, re-encodes and crops (sharp; Python via `process_image.py` for HEIC/RAW), cached on disk |
| `process_image.py` | the Pillow/pillow-heif converter; runs as a CLI or a `--worker` |
| `embeddedThumbnail.ts` | the `micro` tile from a JPEG's embedded EXIF thumbnail, read from the header only |
| `microThumbnail.ts` | which `micro` tile to serve: a cached 160 decode, the embedded thumbnail, or a fresh 160 decode |
| `thumbnailBackfill.ts` | background stage: makes grid tiles ahead of time, newest first |
| `sharpness.ts` | Laplacian-variance sharpness, used to rank a burst |
| `suggestRotation.ts`, `detect_horizon.py` | the editor's auto-straighten suggestion (Hough lines, confidence-gated) |

- Conversions share a small concurrency pool (`common/mediaConversionScheduler.ts`)
  with video frame grabs.
- The Python scripts live beside the TypeScript that runs them and are found
  through `import.meta.url`, so a compiled server needs them copied into
  `dist/`: list each one in `server/scripts/copy-build-assets.mjs`. The
  interpreter comes from `python/pythonRuntime.ts`.
- Served by `requestHandlers/files/filesRequestHandler.ts` (`tryImageVariant`,
  `tryMicroThumbnail`, `tryImageCrop`). Cache eviction is
  `common/cacheEviction.ts`; grid tiles are exempt.
