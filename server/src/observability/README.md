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
