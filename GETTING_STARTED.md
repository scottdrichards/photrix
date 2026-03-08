# Getting Started

Internet-facing deployment checklist for Photrix.

For a concrete Nginx deployment example (serve client build + proxy `/api/`), see `documentation/DEPLOY_NGINX.md`.

## 1) Prerequisites

- Reverse proxy is configured in front of server
- Public host: `photrix.scottdrichards.com`
- Trusted proxy IP: `192.168.1.97`

## 2) Install

```bash
npm --prefix server install
npm --prefix client install
```

## 3) Configure environment

Copy the template and edit values for your deployment:

```powershell
Copy-Item server/.env.example server/.env
```

Use `server/.env.example` as the source of truth for required auth/proxy settings.

## 4) Start services

```bash
npm --prefix server run start
npm --prefix client run dev
```

## 5) Verify startup security checks

- Confirm server logs include `[auth:start:pass]` entries
- Ensure there are no `[auth:start:fail]` entries
- In `NODE_ENV=production`, startup should fail on unsafe auth/proxy config

## 6) First login

1. Open `https://photrix.scottdrichards.com`
2. Register first user with bootstrap token
3. Create/store passkey
4. Rotate or remove bootstrap token after setup
