# Photrix

Photrix is a local-first photo server and web client with metadata indexing, filtering, and passkey-based authentication.

## Tech stack

- Client: React + Vite + TypeScript + Fluent UI v9
- Server: Node.js + TypeScript
- Testing: Vitest (client), Jest (server)

## Quick start

1. Copy `server/.env.example` to `server/.env` and adjust values for your environment.
2. Start the server:
   ```powershell
   npm --prefix server install
   npm --prefix server run start
   ```
3. Start the client:
   ```powershell
   npm --prefix client install
   npm --prefix client run dev
   ```

The client proxies `/api` to `http://localhost:3000` in development.

## Environment profiles

- Use `server/.env.example` as the source of truth for all environment variables.
- Local and production examples are included in that file.
- For internet-facing setup details, see `GETTING_STARTED.md`.
- For Nginx static+API deployment steps, see `documentation/DEPLOY_NGINX.md`.
- For local tracing and Jaeger setup, see `documentation/OBSERVABILITY.md`.
- For the planned face-tagging architecture and phased implementation roadmap, see `documentation/FACE_TAGGING_ROADMAP.md`.
- For a task-ready Phase 1 implementation checklist, see `documentation/FACE_TAGGING_PHASE1_CHECKLIST.md`.

## Observability

The server can export OpenTelemetry traces for request, DB, file, and conversion spans.

1. Start Jaeger locally:
   ```powershell
   npm run trace:jaeger
   ```
2. Enable tracing in `server/.env`:
   ```powershell
   PHOTRIX_OTEL_ENABLED=true
   ```
3. Start the server and open Jaeger at `http://localhost:16686`.

## Authentication and security

- Auth is enabled by default and uses passkeys.
- Protected `/api/*` routes require a valid session.
- Startup runs auth security checks and logs `[auth:start:pass|warn|fail]` entries.
- In production (`NODE_ENV=production`), unsafe auth/proxy settings fail startup.