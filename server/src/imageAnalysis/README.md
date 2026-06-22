# Image analysis (faces + CLIP)

Combined background pass that, for each image, runs **face detection
(InsightFace)** and/or **semantic embedding (CLIP)** — decoding the image exactly
once for both.

Files:

- `imageAnalysisWorker.ts` — Node-side manager for the long-lived Python worker.
- `processImageAnalysis.ts` — the background `TaskRunner`: pulls work from the DB,
  fans out, stores results, reports progress.
- `../../python/image_analysis_worker.py` — the Python process holding both models.

## Why one combined worker

Previously face detection and CLIP were separate workers that each loaded and
decoded every photo independently (two decodes per image, two model processes).
The combined worker holds both models and decodes once, and the caller requests
only the stages a file is still missing (`{ faces, embed }`), so completed work
is never recomputed.

## Worker protocol (`imageAnalysisWorker.ts`)

- A single Python child process is spawned lazily on first use
  (`ensureWorkerReady`) and reused. Models lazy-load inside Python on first use,
  so the first image pays warmup.
- Framing: newline-delimited JSON over stdin/stdout. Each request carries a
  numeric `id`; responses are matched back via the `pending` map.
- Readiness: the worker prints `{"type":"ready"}` once initialized.
- **Crash handling**: on child `exit`/`error`, `worker`/`readyPromise` are reset
  and all pending requests are rejected, so the next call transparently respawns.
- **Timeouts**: every request has a `REQUEST_TIMEOUT_MS` (120s) guard so a wedged
  model can't hang a caller forever.
- Python executable resolution prefers `PHOTRIX_PYTHON[_EXECUTABLE]`, then the
  project `.venv`, then `python3`/`python`. `HF_HOME` is pinned under `CACHE_DIR`
  so model downloads are cached with everything else.
- Worker `stderr` is forwarded through the structured logger
  (`module: "imageAnalysisWorker"`), not `console`.

`analyzeImage(path, { faces, embed })` returns per-stage results **and per-stage
errors** (`facesError` / `embeddingError`) so a fault in one model does not
discard the other model's result.

## Background runner (`processImageAnalysis.ts`)

- Pulls `getImagesNeedingAnalysis(DB_BATCH_SIZE=50)` and processes each batch with
  a small Node-side fan-out (`PARALLELISM=3`) — enough to keep the worker's input
  pipe fed without flooding the box (the single Python worker is the real
  throttle).
- Respects the orchestrator: `ctrl.checkCancelled()` / `await
  ctrl.waitUntilResumed()` at each chunk boundary.
- Per-stage results are persisted independently; a per-stage failure records an
  error timestamp (`facesLastErrorAt` / `embeddingErrorAt`) so the file is retried
  *after* the rest of the backlog instead of blocking it or being lost.
- `getStatus()` reports combined faces+embeddings progress. It is polled by the
  status SSE stream, so it must stay cheap.

The audio workers (`../audioProcessing/whisperWorker.ts`,
`clapWorker.ts`) follow the same long-lived-Python-worker pattern.
