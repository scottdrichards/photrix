# Photrix MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI
agents query your Photrix photo library — semantic search, face recognition,
"on this day" nostalgia, metadata filtering, and viewing actual photos.

It talks to Photrix over the **HTTP API** (the same endpoints the web client
uses), so it inherits Photrix's auth/share-scoping and can run on a different
host from Photrix itself. It never opens the SQLite index directly.

## Running

**It starts automatically** in-process alongside the main app (`bun run start` /
`tsx src/main.ts`) — there's nothing extra to run for the common case of
Photrix and its MCP server living on the same host.

If you want it as a separate process instead (e.g. running it on a different
host from Photrix, or restarting it independently), set `MCP_AUTOSTART=false`
in the main app's env to opt out of the in-process copy, then run it standalone:

```bash
# from server/
bun run mcp
```

Configuration (env vars, e.g. in `server/.env`):

| Variable                 | Default                 | Purpose                                                                              |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------ |
| `MCP_AUTOSTART`          | `true`                   | Whether the main app starts this in-process on boot. Set `false` to run it standalone only. |
| `MCP_PORT`               | `3100`                   | Port the MCP server listens on.                                                      |
| `PHOTRIX_BASE_URL`       | `http://localhost:3000`  | Base URL of the Photrix HTTP server to proxy.                                        |
| `PHOTRIX_PUBLIC_URL`     | `PHOTRIX_BASE_URL`       | Origin used for the `view:` links in tool results. Set it to the address people open Photrix at; the default is usually a loopback address that only works on the server. |
| `PHOTRIX_MCP_TIMEOUT_MS` | `30000`                  | Per-request timeout when calling Photrix.                                            |

## Authentication

Every caller sends its own **personal MCP key** as `Authorization: Bearer <key>`,
and the MCP server forwards that key to Photrix, so each agent acts as a
specific user. Generate a key in the Photrix web app: account panel, then
**MCP keys**. A revoked key stops working immediately.

There is **no server-side credential**. A request without a key is refused, so
the endpoint can sit on a public URL without becoming a way into the library.
(`PHOTRIX_TOKEN` and `MCP_AUTH_TOKEN` used to configure a shared fallback key
and a shared gate. Both are gone; the server logs a warning if either is still
set.)

The key is checked with Photrix before a request is served, so a wrong or
revoked key gets an HTTP 401 at connect time rather than a client that connects
and then fails every tool call. A key that passed is remembered for five
minutes. If Photrix can't be reached, the request is served anyway and the tools
report the error.

Photrix rate-limits each key (see `PHOTRIX_RATE_API_*` in `.env.example`). The
MCP server passes a 429 through with its `Retry-After`, and forwards the
caller's address in `X-Forwarded-For` so Photrix sees the real client.

### Serving it publicly

Put a reverse proxy route for `/mcp` in front of `MCP_PORT`. If the site's
fallback serves the web app for unknown paths, also answer
`/.well-known/oauth-*` with a 404: MCP clients look there for a sign-in method
after a 401, and an HTML page in reply confuses them.

## Transport

Streamable HTTP (stateless). POST JSON-RPC to `http://<host>:<MCP_PORT>/mcp`.
`GET /health` returns a liveness check.

### Connecting a client

Any MCP client that speaks Streamable HTTP can connect. Example Claude Code /
Claude Desktop config:

```json
{
  "mcpServers": {
    "photrix": {
      "type": "http",
      "url": "http://your-server:3100/mcp",
      "headers": { "Authorization": "Bearer <your-mcp-key>" }
    }
  }
}
```

Use a personal **MCP key** from the account panel as the bearer. A key is
required even when Photrix sign-in is disabled; any value works then.

## Tools

| Tool                | What it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| `search_photos`     | Natural-language / semantic search (CLIP image + CLAP audio + transcripts). |
| `list_people`       | List face-clustered people (id, name, face count), optionally by name.      |
| `get_person_photos` | Photos a person appears in, by id or name; date range, sort, paging.        |
| `on_this_day`       | Photos taken on a month/day across all years; highest-rated first, paged.   |
| `query_photos`      | Structured filters: date range, min rating, tag, camera, folder; sort, paging. |
| `get_photo_image`   | Fetch a photo as a JPEG (small 320px / medium 640px / large 1080px high).   |

A name passed to `get_person_photos` may be a first or partial name. When it
matches more than one person the tool lists them instead of guessing.

`get_photo_image` sizes are Photrix's standard heights. Photrix rounds any other
height up to the next one, and anything above the largest means the original
file, which can be tens of megabytes, so the tool doesn't accept arbitrary sizes.

Photos are identified by a `relativePath` like `/2023/trip/img.jpg`, returned by
every listing tool and accepted by `get_photo_image`.

## Design notes

- **Stateless**: a fresh `McpServer` + transport is built per POST and torn down
  on response close. There are no server→client notifications, so no session
  state is needed. See `main.ts`.
- **API proxy, not DB**: all data access goes through `photrixApi.ts`, a thin
  `fetch` wrapper over the Photrix REST endpoints (`/api/search`, `/api/files/`
  with `aggregate=people|peopleClusterDetail|dateRange`, etc.).
- **Dates**: Photrix stores `dateTaken` as epoch-ms integers and its filter layer
  only converts `Date` instances (never JSON strings), so date filters are sent
  as epoch-ms numbers. `on_this_day` builds an `OR` of per-year day ranges.
- **Sort and page on the server.** Every listing passes `sort` and `page` to
  Photrix and asks for exactly `limit` rows. Fetching a large page to sort it in
  the MCP server was two orders of magnitude slower on a large library.
- **People list cache**: the face aggregation behind `list_people` (and a
  name lookup) is cached per caller key for a minute.
