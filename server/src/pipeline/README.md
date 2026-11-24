# pipeline

The indexing stages that turn files on disk into index rows. Each one is a
background task that `main.ts` registers with the task runner: it reads the
next batch of work from `IndexDatabase`, does it, and writes the result back.
They hold no state of their own between batches.

| File | What it owns |
| --- | --- |
| `fileSystemScanFolder.ts` | walks the media root, adds new paths and prunes missing ones (refuses to prune when the root looks unmounted) |
| `fileSystemMonitorFolder.ts` | the recursive watcher: creates, deletes, moves and in-place edits after the first scan |
| `fileSystemRescanRecent.ts` | the periodic rescan of recently changed folders, for writes the watcher never sees (another client on the share) |
| `processFileInfo.ts` | file-level facts: size, created, modified |
| `processExifMetadata.ts` | EXIF/XMP/probe output mapped onto `files` columns (the mapping is `fileHandling/fileUtils.ts`) |
| `processPlaceNames.ts` | GPS to the place words search matches on (`places/placeNames.ts`) |
| `processFaceClustering.ts` | drains the unclustered-face backlog into people (`people/store/faceClusterEdits.ts`) |
| `processMomentClustering.ts` | burst and near-duplicate stacks (`indexDatabase/momentClusterEngine.ts`) |

- Stages talk to the database only through `IndexDatabase` and its stores;
  none of them runs SQL.
- Stages that need an ML worker, a transcoder or a GPU live in their feature
  module instead: `imageAnalysis/`, `videoFaceAnalysis/`, `audioProcessing/`,
  `imageProcessing/` (thumbnails). They follow the same shape.
- Which stage runs when, and how they share the machine, is
  `taskOrchestrator/` and `backgroundTasks/`.
- Ordering lives in the queries, not here: `getFilesNeedingMetadataUpdate`
  in `indexDatabase/`, for example, only offers a photo to face detection
  once its EXIF is in.
