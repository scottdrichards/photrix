# Photrix

Photrix is a local-first photo server and web client with metadata indexing and filtering.

## Tech stack

- Client: React + Vite + TypeScript + Fluent UI v9
- Server: Node.js + TypeScript
- Testing: Vitest (client), Jest (server)
- Package manager: bun (workspaces) — see `GETTING_STARTED.md` for why bun is
  used only as the package manager, not the runtime

## Quick start

1. Copy `server/.env.example` to `server/.env` and adjust values for your environment.
2. Install dependencies (once, from the repo root):
   ```bash
   bun run bootstrap
   ```
3. Start the server:
   ```bash
   bun run --filter server start
   ```
4. Start the client:
   ```bash
   bun run --filter photrix-client dev
   ```

The client proxies `/api` to `http://localhost:3000` in development.

## Environment profiles

- Use `server/.env.example` as the source of truth for all environment variables.
- Local and production examples are included in that file.
- For internet-facing setup details, see `GETTING_STARTED.md`.

- For local tracing and Jaeger setup, see `documentation/OBSERVABILITY.md`.

## Observability

The server can export OpenTelemetry traces for request, DB, file, and conversion spans.
