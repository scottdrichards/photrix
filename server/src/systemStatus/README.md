# systemStatus

What the machine and the task queue are doing right now, for the status page
and the diagnostics report. It reads from the task orchestrator and the audio
workers, so it sits above them; logging and tracing stay in `observability/`,
which imports nothing.

## System metrics — `systemMetrics.ts`

`getSystemMetrics()` returns CPU / memory / disk / GPU usage.

> **CPU and disk usage are delta-based** against module-global state
> (`lastCpuMeasure`, `lastDiskStats`). Two callers sampling concurrently would
> each reset the other's measurement window and corrupt the reading. The function
> therefore **caches its result for `METRICS_CACHE_TTL_MS` (1s) and de-dupes
> in-flight calls**, so the sampling cadence is independent of how many clients
> are polling. Keep this cache if you add new callers.

- CPU%: idle/total tick deltas across `os.cpus()`.
- Disk: parsed from `/proc/diskstats` (Linux only; absent elsewhere → `undefined`).
- GPU: `nvidia-smi` shelled out with a 2s timeout, cached for 2s. If `nvidia-smi`
  is missing/fails once, GPU polling is disabled until restart (`gpuAvailable`).

The status SSE stream consumes these; see
`requestHandlers/statusRequestHandler.ts` for the shared payload cache that keeps
many open browser tabs from multiplying DB and metrics load.

## Diagnostics report: `buildDiagnosticsReport.ts`

One JSON document with a browser session's timeline, the perf snapshot, the
task queue and machine load. See `/documentation/DIAGNOSTICS.md`.
