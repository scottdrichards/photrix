# Observability

Logging, request tracing, and system metrics.

## Logging — `logger.ts`

`pino` logger. In development (`NODE_ENV !== "production"`) it pretty-prints via
`pino-pretty`; in production it emits newline-delimited JSON to stdout (intended
for a log shipper). Level comes from `LOG_LEVEL` (default `debug` in dev, `info`
in prod).

Use `getLogger("ModuleName")` to get a child logger tagged with `module`. **Do
not use `console.*`** anywhere in `src/` — it bypasses levels, structure, and the
shipper. Worker `stderr` lines and child-process failures should be forwarded
through the logger (`log.warn({ line }, "worker stderr")`).

## Request tracing — `requestTrace.ts`

`runWithRequestTrace` wraps each HTTP request in an AsyncLocalStorage context so
logs and spans carry a request id (honoring an inbound `x-request-id`). The
server echoes it back as `X-Request-Id` and logs request completion exactly once
on `finish`/`close`. `measureOperation` wraps a named async block as a span (also
used for bootstrap).

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
