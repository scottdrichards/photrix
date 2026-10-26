# Diagnostics

Photrix keeps the last 2,000 client and server diagnostics events in memory
(`server/src/observability/diagnosticsStore.ts`) plus always-on server
performance stats (`perfMonitor.ts`). Library paths become opaque per-process
tokens, and search text is dropped before anything is stored
(`observability/privacy.ts`). So everything below is safe to paste to an agent.

## Reproducing a problem: the short version

1. Hit the problem in the browser.
2. Either **send a suggestion** describing it (the diagnostics report for
   your browser session is saved with it; read it at
   `GET /api/feedback/<id>/diagnostics`), or fetch the report directly:
   ```bash
   # clientSessionId is in sessionStorage["photrix_client_session_id"]
   curl -H "Authorization: Bearer $TOKEN" \
     "http://localhost:3000/api/diagnostics/report?clientSessionId=<id>" > report.json
   ```
3. Give `report.json` to an agent: "Reconstruct the timeline, find the cause
   of the slowdown, propose a fix."

The report contains that session's events, server-wide events from the same
window (event-loop stalls, slow requests from anyone), per-route latency, the
task queue and machine load (CPU/GPU/memory/disk).

## Correlation ids

- Browser session: `clientSessionId`
- User action / playback attempt: `clientOperationId`
- Individual browser request: `clientRequestId`
- Server request: `requestId` (returned as `X-Request-Id`)

## Events worth knowing

| Event                                | Source | Tells you                                                                                                                                                 |
| ------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.request.slow`                | server | A request over `PHOTRIX_SLOW_REQUEST_MS` (default 1000): time by category (db/file/conversion), top spans, what else was in flight, event-loop delay, RSS |
| `server.eventloop.stall`             | server | Synchronous work blocked the whole server for ≥200ms, and which requests it held up                                                                       |
| `client.request.*`                   | client | Every API call with `durationMs` (to response headers); join to server events by `requestId`                                                              |
| `client.ui.frozen`                   | client | A frame ≥200ms (UI froze), with the scripts responsible where the browser reports them                                                                    |
| `client.page.loaded`                 | client | TTFB, DOMContentLoaded and load times                                                                                                                     |
| `video.negotiation.*`                | client | Direct vs HLS decision, the measured bandwidth and the server's reason                                                                                    |
| `video.element.*`, `video.hls.error` | client | waiting/stalled/error events from the `<video>` element and hls.js                                                                                        |
| `video.playback.summary`             | client | Per attempt: time to first frame (or how long the user waited before giving up), stalls, stalled time, ABR switches, dropped frames                       |
| HLS / orchestrator events            | server | Segment waits and timeouts; task queue snapshots whenever encode work is queued or finishes                                                               |

## Endpoints

- `POST /api/diagnostics/events` ingests client events (batched by `client/src/diagnostics.ts`).
- `GET /api/diagnostics/events?clientSessionId=&clientOperationId=&requestId=&limit=` returns raw events.
- `GET /api/diagnostics/perf` returns live per-route p50/p95/max, requests in flight (oldest first),
  event-loop delay per minute for the last 15 minutes, and recent stalls.
- `GET /api/diagnostics/report?clientSessionId=` returns the bundle described above.

Share-link sessions can only POST events; they can't read any of these.

For span-level traces in Jaeger, see `OBSERVABILITY.md`.

## Good scenarios to exercise

- Start a video while the server is busy with background ML work.
- Seek far forward in a long video so a new HLS segment has to be encoded.
- Play over a throttled link (DevTools) and watch the ABR switches in the summary.
- Open the same video in several tabs.
- Close a video before it starts: `gaveUpWaitingAfterMs` in the summary.
