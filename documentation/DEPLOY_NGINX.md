# Nginx Deployment (Prod + Local)

This guide shows a split-domain setup where:

- `photrix.scottdrichards.com` serves built client files from disk (production)
- `local.photrix.scottdrichards.com` reverse proxies to the calling client IP on your LAN
- Local host access is restricted to `192.168.1.0/24`

Drop-in server blocks are in `documentation/NGINX_SITES_PROD_TEST.conf`.

## 1) Build client assets

From repo root:

```powershell
npm --prefix client install
npm --prefix client run build
```

Built files will be in `client/build`.

## 2) Copy client build to Nginx host (Windows)

Example command from repo root:

```powershell
scp -r .\client\build\* deploy@192.168.1.97:/opt/photrix/client/
```

Notes:

- `scp` copies files but does not delete old files on the server.
- If you want clean/atomic deploys later, move to a release+symlink workflow.

### Optional: npm deploy script with env vars

From repo root, the script `scripts/deploy-client.mjs` can deploy using environment variables.

Required environment variables:

- `PHOTRIX_DEPLOY_USER` (example: `deploy`)
- `PHOTRIX_DEPLOY_HOST` (example: `192.168.1.97`)
- `PHOTRIX_DEPLOY_TARGET` (example: `/opt/photrix/client/`)

Optional environment variables:

- `PHOTRIX_DEPLOY_SOURCE_DIR` (default: `client/build`)
- `PHOTRIX_DEPLOY_PORT` (default: `22`)
- `PHOTRIX_DEPLOY_SSH_KEY` (path to private key file)

PowerShell example:

```powershell
$env:PHOTRIX_DEPLOY_USER = "deploy"
$env:PHOTRIX_DEPLOY_HOST = "192.168.1.97"
$env:PHOTRIX_DEPLOY_TARGET = "/opt/photrix/client/"
$env:PHOTRIX_DEPLOY_SSH_KEY = "C:\Users\Scott\.ssh\id_ed25519"
npm run deploy:client:build
```

Notes:

- `PHOTRIX_DEPLOY_PASSWORD` is not supported by OpenSSH `scp` CLI options.
- Use SSH keys, agent auth, or interactive password prompt.

## 3) Start backend server

On the Photrix host:

```bash
npm --prefix server install
npm --prefix server run start
```

The Photrix server is API-only and listens on port `3000` by default.

## 4) Nginx site config

Use `documentation/NGINX_SITES_PROD_TEST.conf` as the baseline config.

Key points:

- Production site serves static files from `/opt/photrix/client`
- Local site proxies to caller IP ports (`5173` for UI, `3000` for API)
- Local site has `allow 192.168.1.0/24; deny all;`

Create a symlink (or copy) to your enabled sites directory and reload Nginx.

## 5) Run local dev services on the calling machine

On the machine you browse from (for example `192.168.1.42`), run:

```powershell
npm --prefix server run start
npm --prefix client run dev -- --host 0.0.0.0 --port 5173
```

Nginx will proxy requests for `local.photrix.scottdrichards.com` to:

- `http://<your-caller-ip>:5173` for UI
- `http://<your-caller-ip>:3000` for API

Ensure your machine firewall allows the Nginx host (`192.168.1.97`) to reach ports `5173` and `3000`.

## 6) Reload Nginx

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 7) Verify

- `https://photrix.scottdrichards.com/` loads the UI
- `https://local.photrix.scottdrichards.com/` loads local dev UI from the calling machine
- `https://photrix.scottdrichards.com/api/health` returns health JSON
- `https://local.photrix.scottdrichards.com/api/health` reaches local server API

## Troubleshooting

- `local.photrix.scottdrichards.com` returns `403`
  - Confirm client IP is in `192.168.1.0/24`
  - Confirm no upstream proxy is rewriting source IP before Nginx
- `local.photrix.scottdrichards.com` returns `502`
  - Confirm local dev services are running on caller machine ports `5173` and `3000`
  - Confirm caller machine firewall allows inbound from `192.168.1.97`
- Browser shows `Blocked request. This host is not allowed.`
  - Add `local.photrix.scottdrichards.com` to `client/vite.config.ts` `server.allowedHosts`
  - Restart the Vite dev server after updating config
- Getting raw JSON instead of the app at `/`
  - Ensure Nginx `root` points at the deployed client files
  - Ensure `location /` uses `try_files $uri $uri/ /index.html;`
- Client works but API fails
  - Confirm `location /api/` proxies to the Photrix server port (`3000` by default)
