# Observability

Photrix can export request traces with nested spans for database work, file I/O, and conversion operations using OpenTelemetry.

## Local Jaeger

Start Jaeger all-in-one locally (Docker):

```bash
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:2.16.0
```

This gives:

- Jaeger UI: `http://localhost:16686`
- OTLP HTTP ingest: `http://localhost:4318/v1/traces`

## Server configuration

Add these to `server/.env`:

```bash
PHOTRIX_OTEL_ENABLED=true
PHOTRIX_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
```

Optional tuning:

```bash
PHOTRIX_TRACE_SPAN_MIN_MS=25
```

## What appears in traces

- Root request span for each HTTP request
- Child spans for DB operations
- Child spans for file operations
- Child spans for conversion operations, including image conversion, thumbnail generation, and HLS work

## Recommended workflow

1. Start Jaeger.
2. Enable `PHOTRIX_OTEL_ENABLED=true`.
3. Start the server with `bun run --filter server start`.
4. Exercise the app in the browser.
5. Open Jaeger and search for service `photrix-server`.
6. Inspect the slowest request traces to see the breakdown by span.

## Notes

- Trace export is off by default.
- The console timing logs remain useful for local terminal output, but Jaeger is the primary UI for sorting through slow requests.
- Background conversion operations that are not attached to a request still emit standalone spans.