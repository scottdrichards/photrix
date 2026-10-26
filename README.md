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

## Finding your way around

- `documentation/ARCHITECTURE.md`: where each route, representation and background stage is processed.
- `documentation/DIAGNOSTICS.md`: turning "it was slow" into a report an agent can debug
  (`/api/diagnostics/report`, also saved with every suggestion).
- `documentation/OBSERVABILITY.md`: OpenTelemetry/Jaeger traces for request, DB, file and conversion spans.
