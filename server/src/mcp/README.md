# Photrix MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI
agents query your Photrix photo library — semantic search, face recognition,
"on this day" nostalgia, metadata filtering, and viewing actual photos.

It runs as its own process and talks to Photrix over the **HTTP API** (the same
endpoints the web client uses), so it inherits Photrix's auth/share-scoping and
can run on a different host from Photrix itself. It never opens the SQLite index
directly.

## Running

```bash
# from server/
npm run mcp
```

Configuration (env vars, e.g. in `server/.env`):

| Variable                 | Default                 | Purpose                                                              |
| ------------------------ | ----------------------- | -------------------------------------------------------------------- |
| `MCP_PORT`               | `3100`                  | Port the MCP server listens on.                                      |
| `PHOTRIX_BASE_URL`       | `http://localhost:3000` | Base URL of the Photrix HTTP server to proxy.                        |
| `PHOTRIX_TOKEN`          | _(none)_                | Default Photrix bearer used when a caller sends no key of their own. |
| `MCP_AUTH_TOKEN`         | _(none)_                | Legacy shared-secret gate (see Authentication below).                |
| `PHOTRIX_MCP_TIMEOUT_MS` | `30000`                 | Per-request timeout when calling Photrix.                            |

## Authentication

There are two modes, chosen by whether `MCP_AUTH_TOKEN` is set:

- **Per-user keys (recommended, `MCP_AUTH_TOKEN` unset):** each caller sends
  `Authorization: Bearer <mcp-key>` and the MCP server **forwards that key to
  Photrix**, so every agent authenticates as a specific user. Generate a key
  from the Photrix web app → account panel → **MCP keys**, or via the API. A
  revoked key immediately stops working (Photrix returns 401). If a caller sends
  no bearer, the server falls back to the env `PHOTRIX_TOKEN`.
- **Legacy shared secret (`MCP_AUTH_TOKEN` set):** callers must send
  `Authorization: Bearer <MCP_AUTH_TOKEN>` to reach `/mcp`, and the MCP server
  talks to Photrix using the single env `PHOTRIX_TOKEN`.

You can also obtain a raw Photrix bearer for `PHOTRIX_TOKEN` via:

```bash
curl -s -X POST "$PHOTRIX_BASE_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<your AUTH_PASSWORD>"}'
```

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

Use a per-user **MCP key** from the account panel as the bearer (per-user mode),
or the `MCP_AUTH_TOKEN` value in legacy mode. Omit `headers` only if Photrix auth
is disabled and no `MCP_AUTH_TOKEN` is set.

## Tools

| Tool                | What it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| `search_photos`     | Natural-language / semantic search (CLIP image + CLAP audio + transcripts). |
| `list_people`       | List face-clustered people (id, name, photo count, year range).             |
| `get_person_photos` | Photos a given person (by id or name) appears in.                           |
| `on_this_day`       | Photos taken on a month/day across all years; highest-rated first.          |
| `query_photos`      | Structured filters: date range, min rating, tag, camera, folder.            |
| `get_photo_image`   | Fetch an actual photo (JPEG, resized) so the agent can see it.              |

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
