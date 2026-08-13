# Getting Started

Development and deployment setup for Photrix.

## 1) Prerequisites

- Reverse proxy is configured in front of server (for production deployment)

## 2) Install

The repo is a bun workspace (client, server, e2e). Install everything in one
pass from the repo root:

```bash
bun run bootstrap
```

This runs `bun install` and then restores better-sqlite3's compiled native
addon from a shared cache (`~/.cache/photrix/native`, override with
`PHOTRIX_NATIVE_CACHE`), instead of rebuilding it from source (~85s) in every
fresh checkout/worktree. Plain `bun install` also works if you just need
dependencies and already have (or don't need) the native addon.

Bun is used only as the package manager here — the app still runs on Node
(the server runs under `node`/`tsx`, tests run under Jest/Vitest on Node, not
`bun test`). This is because better-sqlite3 doesn't load under the bun
runtime ([oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290)), and
bun's built-in `bun:sqlite` has no user-defined-function support, which
Photrix needs for its `regexp` and `cosine_similarity*` SQL functions (they
let similarity ranking run inside SQLite instead of materializing every
embedding on the JS heap). So: `bun install` / `bun run <script>`, never
`bun <file.ts>` or `bun test`.

Then install the Python dependencies for face detection:

```bash
bun run --filter server face:python:install
```

Optional GPU acceleration:

```bash
bun run --filter server face:python:install:gpu
bun run --filter server clip:python:install:gpu
```

## 3) Configure environment

Copy the template and edit values for your deployment:

```powershell
Copy-Item server/.env.example server/.env
```

Use `server/.env.example` as the source of truth for required settings.

## 4) Start services

```bash
bun run --filter server start
bun run --filter photrix-client dev
```

## 5) Local development

Just start both services:

```bash
bun run --filter server start
bun run --filter photrix-client dev
```

Open `http://localhost:5173`.

Set `MEDIA_ROOT=./exampleFolder` (instead of a real photo library) for
local dev/testing — see `TESTING.md` under "Manual/local testing".
