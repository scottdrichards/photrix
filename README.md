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

## Authentication and security

- Auth is enabled by default and uses passkeys.
- Protected `/api/*` routes require a valid session.
- Startup runs auth security checks and logs `[auth:start:pass|warn|fail]` entries.
- In production (`NODE_ENV=production`), unsafe auth/proxy settings fail startup.