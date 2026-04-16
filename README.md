# Photrix

Photrix is a local-first photo server and web client with metadata indexing and filtering.

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

## Observability

The server can export OpenTelemetry traces for request, DB, file, and conversion spans.
