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
fresh checkout/worktree.

Prefer `bun run bootstrap` over a bare `bun install`: on a fresh checkout,
`bun install` alone leaves the native addon unbuilt and the server will fail
to start. It does self-heal -- the server's `predev`/`prebuild`/`pretest`
hooks run the same step -- so such a checkout repairs itself the first time
you build, dev, or test it. Bootstrap is simply the direct path.

Bun is used only as the package manager here — the app still runs on Node
(the server runs under `node`/`tsx`, tests run under Jest/Vitest on Node, not
`bun test`). This is because better-sqlite3 doesn't load under the bun
runtime ([oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290)), and
bun's built-in `bun:sqlite` has no user-defined-function support, which
Photrix needs for its `regexp` and `cosine_similarity*` SQL functions (they
let similarity ranking run inside SQLite instead of materializing every
embedding on the JS heap). So: `bun install` / `bun run <script>`, never
`bun <file.ts>` or `bun test`.

Then install the Python ML stack (face detection, CLIP and CLAP search,
Whisper). It picks the right GPU build for the machine, installs it, and
checks the GPU is really in use:

```bash
bun run --filter server python:install                      # auto-detect
bun run --filter server python:install -- --profile cpu     # or name one
bun run --filter server python:profiles                     # list them
bun run --filter server python:report                       # what the server will use
```

| Profile | For | CLIP / CLAP | Faces |
|---|---|---|---|
| `cuda` | NVIDIA, compute capability 7.5+ | CUDA | CUDA |
| `cuda-legacy` | NVIDIA Pascal/Volta (GTX 10xx, Quadro P) | CUDA | CUDA |
| `mac` | Apple Silicon | MPS | CoreML |
| `rocm` | AMD on Linux | ROCm | CPU |
| `xpu` | Intel Arc / Core Ultra (pick by hand) | XPU | CPU |
| `directml` | Windows on AMD/Intel | CPU | DirectML |
| `cpu` | anything | CPU | CPU |

Whisper uses the GPU on CUDA only. Any setting can be forced in `server/.env`:
`PHOTRIX_TORCH_DEVICE`, `PHOTRIX_CLIP_DEVICE`, `PHOTRIX_CLAP_DEVICE`,
`PHOTRIX_INSIGHTFACE_PROVIDER`.

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
