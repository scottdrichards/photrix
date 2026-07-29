# Diagnostics

Photrix now records correlated client and server diagnostics for recent activity.

## What is correlated

- Browser session: `clientSessionId`
- User action / playback attempt: `clientOperationId`
- Individual browser request: `clientRequestId`
- Server request handling: `requestId`

For video playback, the client logs negotiation, HLS/media-element errors, `waiting`, `stalled`, and cleanup events. The server logs video negotiation decisions, HLS segment/playlist waits and timeouts, and task-orchestrator queue snapshots whenever blocking encode work is queued, started, fails, or completes.

## Endpoint

- `POST /api/diagnostics/events`
  - Ingests client-side diagnostic events.
- `GET /api/diagnostics/events`
  - Returns recent events.
  - Supported filters:
    - `clientSessionId`
    - `clientOperationId`
    - `requestId`
    - `limit`

Example:

```bash
curl "http://localhost:3000/api/diagnostics/events?clientOperationId=<operation-id>&limit=200"
```

## Suggested AI Workflow

1. Reproduce the issue in the browser.
2. Capture the relevant `clientOperationId` from the diagnostics output or browser network requests.
3. Query `/api/diagnostics/events?clientOperationId=...`.
4. Ask the AI to explain the timeline across client and server events.

Example prompt:

```text
I tried playing a video and the client hung. Here are the correlated diagnostics events for the playback attempt. Reconstruct the timeline, identify the likely root cause, and suggest concrete code or queue-management improvements.
```

## Good Testing Scenarios

- Start a video while the server is already processing background ML work.
- Seek far forward in a long video to force a new HLS segment request.
- Trigger a playback attempt on a client with weak bandwidth.
- Open the same video in multiple tabs.
- Cancel playback quickly and verify the client reports aborted requests instead of silent disappearance.
