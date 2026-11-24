# Docs index

Review these when implicated (paths relative to the repo root).

| Doc | Read it for |
| --- | --- |
| `/GETTING_STARTED.md` | setup, install profiles, configuration, running locally |
| `/TESTING.md` | test layers, `exampleFolder`, e2e; `/server/TESTING.md` for the server's jest specifics |
| `/server/API.md` | every HTTP endpoint and its parameters |
| `/documentation/ARCHITECTURE.md` | where X happens: routes, file serving, video, the background pipeline, module boundaries |
| `/documentation/FACES.md` | faces and people: detection, embeddings, clustering, verdicts and review, identify |
| `/documentation/CODING_STYLE.md` | style rules (loaded below) |
| `/documentation/DIAGNOSTICS.md` | debugging a slowdown or bug from a user report |
| `/documentation/OBSERVABILITY.md` | traces (OpenTelemetry, Jaeger) |
| `/e2e/README.md` | adding Playwright tests |
| `<module>/README.md` | the detail for one module; most directories in the map below have one |

# Module map

| Path | What it is |
| --- | --- |
| `server/src/main.ts` | boots the server: database, stores, background stages, HTTP, MCP |
| `server/src/createServer.ts`, `createRoutes.ts` | request trace and auth gate; the route table and share-link policy |
| `server/src/requestHandlers/` | one handler per route group |
| `server/src/indexDatabase/` | SQLite schema, stores, queries, migrations, the scan/EXIF/clustering stages |
| `server/src/backgroundTasks/`, `taskOrchestrator/` | which stage feeds which; scheduling, resource budgets, backing off for users |
| `server/src/imageAnalysis/`, `faceDetection/`, `videoFaceAnalysis/` | faces and CLIP for photos, live identify, faces in videos |
| `server/src/imageProcessing/`, `videoProcessing/`, `audioProcessing/` | image conversion, ffmpeg/HLS, Whisper and CLAP |
| `server/src/auth/`, `shareScope/`, `shareDescription/` | accounts and tokens; what a share link may see; share previews |
| `server/src/naturalLanguageSearch/`, `photoCaption/`, `places/` | query interpretation, captions, place names |
| `server/src/observability/`, `systemStatus/`, `featureFlags/`, `feedback/`, `mcp/` | logs/traces/privacy, status, flags, the feedback queue, the MCP server |
| `server/src/common/`, `fileHandling/`, `accel/`, `python/` | shared helpers, file/EXIF helpers, accelerator probe, Python interpreter resolution |
| `server/python/` | the long-lived Python workers (image analysis, Whisper, CLAP) and their requirements |
| `client/src/` | the React app; see its README |
| `shared/` | code both sides import: filter contract, feature flags, HLS headers, video storyboard |
| `e2e/` | Playwright suite and the playback lab |

Python lives in two places on purpose: `server/python/` holds the long-lived
workers, found from the server's working directory and installed by
`bun run --filter server python:install`; `server/src/imageProcessing/*.py` are
one-shot scripts kept beside the TypeScript that runs them and found through
`import.meta.url`. `server/src/python/` is TypeScript only (interpreter
resolution).

# Recipes: where to add X

- **A route**: handler in `server/src/requestHandlers/<thing>RequestHandler.ts`,
  then a `Route` in `createRoutes.ts` with the narrowest `shareLink` access, a
  row in `/documentation/ARCHITECTURE.md` and the endpoint in `server/API.md`.
  See `requestHandlers/README.md`.
- **A background stage**: a `process<Thing>.ts` returning a `TaskRunner` (use
  `createTaskController`) in the module that owns the work; add it to
  `BackgroundTaskPlan` and the cascade in
  `backgroundTasks/registerBackgroundTasks.ts`, give it a name and task `type`
  in `main.ts`, and add it to the pipeline diagram in ARCHITECTURE.md.
- **A DB table, column or migration**: declare it in
  `server/src/indexDatabase/tables.ts` and query it from the store that owns
  it. Carrying user data across a schema change follows "Migrations" in
  `indexDatabase/README.md`.
- **An env var**: add it to its section of `server/src/config/config.ts` with
  a reader from `config/env.ts` and a `help` line, read it with `config()`
  where it is used (not into a module constant), then run
  `bun run --filter server env:example` to regenerate `server/.env.example`.
  Lint rejects `process.env` anywhere else; a spec changes config with
  `overrideConfig` from `config/config.fixture.ts`. See
  `server/src/config/README.md`. Client build-time vars are `VITE_*` in
  `client/.env.example`.
- **A client API call**: a function in `client/src/api/<area>.ts`, types in
  `api/api.type.ts`, exported from `api/index.ts`. See `client/src/README.md`.
- **A Python worker**: the script in `server/python/` (newline-delimited JSON
  over stdin/stdout, print `{"type":"ready"}`, a `*_test.py` beside it for
  `bun run --filter server test:python`); a Node manager modelled on
  `imageAnalysis/imageAnalysisWorker.ts` using `python/pythonRuntime.ts`;
  add its script name to `taskOrchestrator/reapOrphanedWorkers.ts` and its
  dependencies to `server/python/requirements.txt`.

# Terminal commands

- Never use `npx` to run tools. Use `bun run <script>` instead, adding scripts to the relevant `package.json` if one doesn't already exist.

# Agent interactions

- If a prompt/interaction is testable, create a test before implementation if possible. If not possible, inform the user and create one after implementation.
- To validate UI/behavior changes end-to-end without a human, run `bun run test:e2e` (Playwright drives an isolated app; see /TESTING.md and /e2e/README.md).
- Default to `MEDIA_ROOT=./exampleFolder` for any manual/local run of the
  dev server, not a real photo library — face clusters, moment stacks, and
  embeddings live in one shared index/DB per `MEDIA_ROOT`, so concurrent
  sessions against the same real library step on each other's analysis
  state. See /TESTING.md under "Manual/local testing".
- If a prompt/interaction could be reflected in a prettier/linting change, suggest updating
  those configurations.
- If a misunderstanding occurs, ensure the learnings are captured in documentation or comments
- Ensure agent contexts are concise and only relevant contexts are loaded. For example, don't put much information in this file, but put it in a file/comment/etc. close to the relevant file.
- Challenge the user if a prompt seems to go against any directive, best practice, or principle in the repository.
- Database changes: derived data (embeddings, EXIF, clusters a re-run reproduces) may be rebuilt, but data a user made by hand (face verdicts, names, merges, ratings) must be carried forward by a one-time startup migration. Never add read-time fallbacks for old shapes. See "Migrations" in `server/src/indexDatabase/README.md`.

# Directive persistence

- Treat explicit user phrases like `always`, `never`, `from now on`, or `every time` as durable directive candidates (not one-off preferences).
- If the directive changes repository workflow or coding behavior, update `AGENTS.md` (or a referenced instruction file) in the same change so future agents inherit it.
- If the directive is user-personal and not repository policy, store it in user memory instead of repo instructions.
- When directive scope is unclear, ask once whether it should be repo-wide policy or session-only behavior.
- After applying a durable directive, briefly confirm where it was recorded.

@./documentation/CODING_STYLE.md
