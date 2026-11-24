# Configuration

Every environment variable the server reads is parsed here, once, at startup.
Nothing else in `src/` touches `process.env`; lint rejects it.

- `config.ts`: `loadConfig(env, role)` reads every variable into one typed
  object, grouped by area (`media`, `db`, `server`, `auth`, `search`, `ollama`,
  `hls`, `python`, `background`, `featureFlags`, `mcp`, `telemetry`). It
  collects every problem and throws one `ConfigError` listing them all. Each
  variable's default and `help` text sit beside the code that reads it.
  `config()` returns the loaded object; read it where a value is used, not into
  a module constant, so a test override reaches it.
- `env.ts`: the readers (`ms`, `count`, `positive`, `port`, `flag`, `url`,
  `secret`, …). Each keeps the meaning the variable always had, such as 0
  meaning "the default" for most timeouts, and rejects values that aren't the
  right kind. A secret's value never appears in an error.
- `serverEnv.ts` / `mcpEnv.ts`: the first import of `main.ts` and
  `mcp/main.ts`. They load `server/.env` and validate for that entry point: the
  main server requires `MEDIA_ROOT`, and the share-link secret when sign-in is
  on; the standalone MCP server needs neither. On a bad environment the
  process prints every problem and exits.
- `childEnv.ts`: the environment for spawned processes (the Python workers,
  ffmpeg, the day-photo scripts) and for libraries that read it themselves
  (the OpenTelemetry SDK). Variables only a Python worker reads are documented
  in `config.ts` with `passthrough`.
- `config.fixture.ts`: `overrideConfig(vars)` and `resetConfig()` for specs.

`server/.env.example` is generated from the documentation in `config.ts`:

```bash
bun run --filter server env:example
```

`envExample.spec.ts` fails when the committed file is stale, so a new variable
can't go undocumented.
