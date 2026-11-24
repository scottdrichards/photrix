// Every environment variable the server reads, parsed and validated in one
// place. `loadConfig` reads them all and throws one ConfigError listing every
// bad or missing one; `config()` is how the rest of the server reads the
// result. `server/.env.example` is generated from the documentation below
// (`bun run --filter server env:example`), and a unit test fails when it is stale.
//
// To add a variable: read it in the right section below with a reader from
// env.ts, give it a `help` line, then regenerate `.env.example`.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  featureFlagEnvironmentVariable,
  featureFlags,
  type FeatureFlagName,
} from "@photrix/feature-flags";
import { ConfigError, createEnvReader, type Env } from "./env.ts";

/** What is starting: the main server needs its library; the standalone MCP server doesn't. */
type Role = "server" | "mcp" | "any";

const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;
const MIN_SHARE_TOKEN_SECRET_LENGTH = 32;

type Account = { username: string; password: string };

const parseAccounts = (raw: string): { value: Account[] } | { error: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "must be a valid JSON array" };
  }
  const isAccount = (entry: unknown): entry is Account =>
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as Account).username === "string" &&
    typeof (entry as Account).password === "string";
  return Array.isArray(parsed) && parsed.every(isAccount)
    ? { value: parsed }
    : { error: 'must be a JSON array of {"username": …, "password": …}' };
};

const read = (env: Env, role: Role) => {
  const r = createEnvReader(env);

  r.section("Media library and cache");
  const mediaRoot = r.optional("MEDIA_ROOT", {
    help: "Required. The folder of photos and videos to index. ./exampleFolder is a small synthetic library for trying things out and for tests.",
    example: "./exampleFolder",
    active: true,
  });
  if (role === "server" && mediaRoot === undefined)
    r.problem("MEDIA_ROOT: required, the folder of media to index");
  const cacheDir = r.text("CACHE_DIR", path.join(process.cwd(), ".cache"), {
    help: "Where thumbnails, converted media and downloaded models are cached, and the database's default location. Defaults to ./.cache under the working directory.",
    example: "./.cache",
    active: true,
  });
  const media = {
    root: mediaRoot,
    cacheDir,
    cacheMaxBytes: r.bytes("CACHE_MAX_BYTES", 10 * 1024 ** 3, {
      help: 'Size of the media cache (thumbnails, converted images and videos) before least-recently-used entries are evicted, down to 90% of it. A byte count or a size like "10GB". The database, model downloads and grid thumbnails are never evicted.',
      example: "10GB",
    }),
    cacheEvictionIntervalMs: r.ms("CACHE_EVICTION_INTERVAL_MS", 5 * 60_000, {
      help: "How often the cache eviction sweep runs (ms).",
    }),
    rescanIntervalMs: r.ms("FILE_SYSTEM_RESCAN_INTERVAL_MS", 5 * 60_000, {
      help: "How often to rescan recently changed folders (ms). Catches writes the file watcher misses, such as ones made to a network share from another machine.",
    }),
    conversionConcurrency: r.count("PHOTRIX_MEDIA_CONVERSION_CONCURRENCY", 2, {
      help: "How many image and video conversions run at once.",
    }),
    thumbnailBackfill: {
      mbPerSecond: r.positive("PHOTRIX_THUMBNAIL_BACKFILL_MB_PER_SEC", 10, {
        help: "The grid-thumbnail backfill pre-generates every grid tile, newest first, as the lowest-priority background work. This caps its reads from the library, in MB/s.",
      }),
      maxLoad: r.positive("PHOTRIX_THUMBNAIL_BACKFILL_MAX_LOAD", 0.5, {
        help: "The backfill waits while the 1-minute load per CPU is above this.",
      }),
    },
  };

  r.section("Database");
  const db = {
    directory: r.text("INDEX_DB_LOCATION", cacheDir, {
      help: "Folder for the SQLite database (index.db). Defaults to CACHE_DIR. Must be a local disk: SQLite's WAL mode doesn't work over SMB or other network filesystems, where the read worker hangs while the write worker is busy.",
      example: "./.cache",
    }),
    readWorkers: r.count("PHOTRIX_DB_READ_WORKERS", 2, {
      help: "SQLite read workers. Each is a thread with its own connection and page cache.",
    }),
    walCheckpointIntervalMs: r.msOrZero("PHOTRIX_WAL_CHECKPOINT_INTERVAL_MS", 60_000, {
      help: "How often (ms) a blocking WAL checkpoint writes committed pages back into index.db and truncates the WAL. Background reads starve SQLite's passive checkpoints, so without this the WAL grows without bound. 0 turns it off.",
    }),
  };

  r.section("Server and logging");
  const port = r.port("PORT", 3000, { help: "HTTP port. 0 picks a free one." });
  const nodeEnv = r.text("NODE_ENV", "development", {
    help: '"production" switches the log to JSON at info level; anything else is pretty-printed at debug level.',
  });
  const isProduction = nodeEnv === "production";
  const server = {
    port,
    nodeEnv,
    isProduction,
    logLevel: r.oneOf("LOG_LEVEL", LOG_LEVELS, isProduction ? "info" : "debug", {
      help: `Log threshold: ${LOG_LEVELS.join(", ")}. Defaults to info in production, debug otherwise.`,
      example: "info",
    }),
    publicUrl: r.url("PHOTRIX_PUBLIC_URL", {
      help: "The public origin people open the app at. Share-link previews and links returned by the MCP server point here. Defaults to the request's own origin for previews, and to PHOTRIX_BASE_URL for MCP links.",
      example: "https://photos.example.com",
    }),
    slowRequestMs: r.ms("PHOTRIX_SLOW_REQUEST_MS", 1_000, {
      help: "Requests slower than this (ms) are recorded as server.request.slow diagnostics events with their span breakdown (documentation/DIAGNOSTICS.md).",
    }),
    traceSpanMinMs: r.positive("PHOTRIX_TRACE_SPAN_MIN_MS", 25, {
      help: "Spans shorter than this (ms) are left out of the per-request console lines.",
    }),
    memoryLogIntervalMs: r.msOrZero("PHOTRIX_MEMORY_LOG_INTERVAL_MS", 10 * 60_000, {
      help: "Interval (ms) for the periodic heap and RSS log line. 0 turns it off.",
    }),
  };

  r.section(
    "Sign-in",
    "With neither AUTH_PASSWORD nor PHOTRIX_ACCOUNTS set, the app is open to anyone who can reach it.",
  );
  const password = r.secret("AUTH_PASSWORD", {
    help: 'Single-account mode: the password for the account "admin".',
  });
  const accounts = r.custom(
    "PHOTRIX_ACCOUNTS",
    {
      help: 'Several accounts, as a JSON array: [{"username":"alice","password":"…"}]. Takes precedence over AUTH_PASSWORD.',
      secret: true,
    },
    parseAccounts,
  );
  const enabled = accounts !== undefined || password !== undefined;
  const shareTokenSecret = r.secret("PHOTRIX_SHARE_TOKEN_SECRET", {
    help: `Required when sign-in is on: the key share links are encrypted with. A random string of at least ${MIN_SHARE_TOKEN_SECRET_LENGTH} characters, e.g. \`openssl rand -base64 32\`. Not the password: every share link carries ciphertext under this key, so a password-derived key would let a link holder test password guesses offline. Changing it invalidates every share link.`,
    minLength: MIN_SHARE_TOKEN_SECRET_LENGTH,
  });
  if (role === "server" && enabled && shareTokenSecret === undefined) {
    r.problem(
      "PHOTRIX_SHARE_TOKEN_SECRET: required when AUTH_PASSWORD or PHOTRIX_ACCOUNTS is set",
    );
  }
  const auth = {
    password,
    accounts,
    /** Whether anyone has to sign in. */
    enabled,
    shareTokenSecret,
    minShareTokenSecretLength: MIN_SHARE_TOKEN_SECRET_LENGTH,
    sessionExpiryDays: r.positive("PHOTRIX_SESSION_EXPIRY_DAYS", 30, {
      help: "A session expires after this many days without use.",
    }),
    rpOrigin: r.url("PHOTRIX_RP_ORIGIN", {
      help: "The WebAuthn relying-party origin for passkeys: your public origin. Until it points at a public domain the passkeys section stays hidden, because a passkey bound to localhost or a LAN address only works from that one network. Defaults to http://localhost:<PORT>.",
      example: "https://photos.example.com",
    }),
    login: {
      maxConcurrent: r.count("PHOTRIX_LOGIN_MAX_CONCURRENT", 2, {
        help: "Password hashes in flight at once. Past this a login waits in a queue.",
      }),
      maxQueued: r.count("PHOTRIX_LOGIN_MAX_QUEUED", 16, {
        help: "Logins that may wait for a hash. Past this a login is refused.",
      }),
      maxFailures: r.count("PHOTRIX_LOGIN_MAX_FAILURES", 20, {
        help: "Failed logins allowed per client IP per 15 minutes. Generous, because visitors behind one proxy share an address.",
      }),
    },
    ipLocation: r.flag("PHOTRIX_IP_LOCATION", true, ["on", "off"], {
      help: 'Account → Active sessions shows a rough place for sessions from the internet, looked up from a public IP-location service (ipapi.co). Local-network addresses are never sent. "off" keeps visitors\' addresses on this server.',
    }),
  };

  r.section("Search");
  const timeoutMs = r.ms("PHOTRIX_SEARCH_TIMEOUT_MS", 15_000, {
    help: "How long a search, or resolving a semantic share link, waits on any one source (CLIP, CLAP, transcripts) before answering without it (ms).",
  });
  const clipMinSimilarity = r.real("PHOTRIX_SEARCH_CLIP_MIN_SIMILARITY", 0.18, {
    help: "Lowest CLIP image-text similarity a result may have.",
  });
  const clapMinSimilarity = r.custom(
    "PHOTRIX_SEARCH_CLAP_MIN_SIMILARITY",
    {
      help: "Lowest CLAP audio-text similarity a result may have. Defaults to 0.52 for searches and 0.45 for semantic share links.",
      example: "0.52",
    },
    (raw) =>
      Number.isFinite(Number(raw))
        ? { value: Number(raw) }
        : { error: "expected a number" },
  );
  const search = {
    timeoutMs,
    clipMinSimilarity,
    clapMinSimilarity: clapMinSimilarity ?? 0.52,
    naturalLanguageTimeoutMs: r.ms("PHOTRIX_NL_SEARCH_TIMEOUT_MS", 12_000, {
      help: "Deadline (ms) for the local LLM to turn a typed search into filters (needs PHOTRIX_OLLAMA_URL). Missing it costs only the filter chips: the plain search has already run.",
    }),
  };
  const shareScope = { clapMinSimilarity: clapMinSimilarity ?? 0.45 };

  r.section(
    "Local LLM (Ollama)",
    "Generates share-link titles, photo captions and search filters. With PHOTRIX_OLLAMA_URL unset each falls back to its deterministic behaviour.",
  );
  const ollama = {
    url: r.url("PHOTRIX_OLLAMA_URL", {
      help: "Base URL of an Ollama instance.",
      example: "http://localhost:11434",
    }),
    model: r.text("PHOTRIX_OLLAMA_MODEL", "llama3.2:3b", {
      help: "Text model for share titles and search filters. A small instruct model is plenty and leaves GPU memory free.",
    }),
    timeoutMs: r.ms("PHOTRIX_OLLAMA_TIMEOUT_MS", 15_000, {
      help: "Per-request timeout (ms) for a share title.",
    }),
    keepAlive: r.text("PHOTRIX_OLLAMA_KEEP_ALIVE", "30m", {
      help: "How long Ollama keeps the model loaded after a call. A cold call spends most of its time loading the model, so letting it idle out makes nearly every request pay that again. 0 frees the memory at once.",
    }),
    visionModel: r.text("PHOTRIX_OLLAMA_VISION_MODEL", "moondream:latest", {
      help: "Vision model for photo captions and descriptions.",
    }),
    captionTimeoutMs: r.ms("PHOTRIX_OLLAMA_CAPTION_TIMEOUT_MS", 40_000, {
      help: "Per-request timeout (ms) for a short caption.",
    }),
    descriptionTimeoutMs: r.ms("PHOTRIX_OLLAMA_DESCRIPTION_TIMEOUT_MS", 600_000, {
      help: "Total deadline (ms) for a long photo description. Long, because a contended GPU pushes the model onto the CPU.",
    }),
  };

  r.section("Video playback (HLS)");
  const hls = {
    cacheDir: r.text(
      "HLS_CACHE_DIR",
      path.join(existsSync("/dev/shm") ? "/dev/shm" : tmpdir(), "photrix-hls"),
      {
        help: "Folder for HLS output. It is made on demand and deleted shortly after playback stops, so it defaults to a RAM-backed filesystem (/dev/shm, else the OS temp folder). Don't point it at persistent disk.",
        example: "/dev/shm/photrix-hls",
      },
    ),
    idleMs: r.ms("PHOTRIX_HLS_IDLE_MS", 90_000, {
      help: "How long (ms) a video's HLS output is kept after its last request before every encode is killed and the folder deleted.",
    }),
    variantIdleMs: r.ms("PHOTRIX_HLS_VARIANT_IDLE_MS", 8_000, {
      help: "How long (ms) one encode may go untouched (after an ABR switch or a seek) before it is killed.",
    }),
    seekRestartGapSegments: r.count("PHOTRIX_HLS_SEEK_RESTART_GAP", 10, {
      help: "How many segments past an encode's head a request may be before a new encode starts at the request instead of waiting.",
    }),
    maxRunsPerVariant: r.count("PHOTRIX_HLS_MAX_RUNS_PER_VARIANT", 3, {
      help: "Encodes one quality of one video may run at once. Past this the least recently used goes.",
    }),
    paceAheadSegments: r.count("PHOTRIX_HLS_PACE_AHEAD_SEGMENTS", 30, {
      help: "An encode this many segments ahead of the furthest one requested is paused until the player catches up.",
    }),
  };

  r.section("Python and ML workers");
  const python = {
    command: r.optional("PHOTRIX_PYTHON", {
      help: "The Python interpreter for image conversion and the ML workers. Defaults to ./.venv, then python3 (python on Windows). The day-photo and screensaver scripts fall back to python3.",
      example: "./.venv/bin/python",
    }),
    executable: r.optional("PHOTRIX_PYTHON_EXECUTABLE", {
      help: "Older name for PHOTRIX_PYTHON, used by the ML workers when PHOTRIX_PYTHON is unset.",
    }),
    audioDisabled: r.flag("PHOTRIX_DISABLE_AUDIO", false, ["1", "0"], {
      help: "1 stops the audio workers (Whisper transcription, CLAP audio search) from ever starting. An emergency switch for a GPU too small to hold them.",
    }),
    imageWorkerReadyTimeoutMs: r.ms("PHOTRIX_IMAGE_WORKER_READY_TIMEOUT_MS", 5 * 60_000, {
      help: "How long (ms) the image-analysis worker (faces and CLIP) may take to load its models.",
    }),
    clapReadyTimeoutMs: r.ms("PHOTRIX_CLAP_READY_TIMEOUT_MS", 5 * 60_000, {
      help: "How long (ms) the CLAP audio worker may take to load.",
    }),
    whisperReadyTimeoutMs: r.ms("PHOTRIX_WHISPER_READY_TIMEOUT_MS", 5 * 60_000, {
      help: "How long (ms) the Whisper worker may take to load.",
    }),
    whisperIdleUnloadMs: r.msOrZero("PHOTRIX_WHISPER_IDLE_UNLOAD_MS", 60_000, {
      help: "Whisper is unloaded after this long (ms) without work.",
    }),
    whisperStartQuietMs: r.msOrZero("PHOTRIX_WHISPER_START_QUIET_MS", 60_000, {
      help: "How long (ms) the app must go unused before Whisper may load. Loading it takes ~30 s and ~2 GB, so starting it in every pause between requests only to kill it at the next one wastes both.",
    }),
  };
  r.passthrough("PHOTRIX_TORCH_DEVICE", {
    help: "Torch device for the torch workers (cuda, mps, xpu, cpu). The startup accelerator probe sets it when unset.",
    example: "cuda",
  });
  r.passthrough("PHOTRIX_CLIP_DEVICE", {
    help: "CLIP's device. Defaults to the probed torch device.",
    example: "cuda",
  });
  r.passthrough("PHOTRIX_CLAP_DEVICE", {
    help: "CLAP's device. Defaults to PHOTRIX_TORCH_DEVICE.",
    example: "cpu",
  });
  r.passthrough("PHOTRIX_INSIGHTFACE_PROVIDER", {
    help: "ONNX Runtime provider for the face models. Defaults to the probed provider, using CUDA only when torch is on CUDA too.",
    example: "CPUExecutionProvider",
  });
  r.passthrough("PHOTRIX_CLIP_PROVIDER", {
    help: "Older name for PHOTRIX_INSIGHTFACE_PROVIDER.",
  });
  r.passthrough("PHOTRIX_CLAP_MIN_FREE_GPU_MIB", {
    help: "Free GPU memory (MiB) CLAP needs before it takes the GPU instead of the CPU.",
    example: "1024",
  });
  r.passthrough("PHOTRIX_IMAGE_MAX_DECODE_EDGE", {
    help: "Longest edge (px) images are decoded at for face detection and CLIP.",
    example: "2048",
  });
  r.passthrough("WHISPER_CPU_THREADS", {
    help: "CPU threads for Whisper when it runs on the CPU.",
    example: "2",
  });

  r.section("Background work");
  const background = {
    dutyOnMs: r.ms("PHOTRIX_BG_DUTY_ON_MS", 2_000, {
      help: "Under load, background work runs in bursts instead of stopping. Length of a burst (ms).",
    }),
    dutyOffMs: r.ms("PHOTRIX_BG_DUTY_OFF_MS", 2_000, {
      help: "Rest between bursts (ms).",
    }),
    userLeaseMaxMs: r.ms("PHOTRIX_USER_LEASE_MAX_MS", 10 * 60_000, {
      help: "Longest (ms) one user request may hold background work stopped without refreshing. Past this the hold is dropped and logged, so a leak can't freeze indexing.",
    }),
    loadThreshold: r.positive("PHOTRIX_LOAD_THRESHOLD", 0.9, {
      help: "New background work holds off while the 1-minute load per CPU is above this.",
    }),
  };

  r.section(
    "Feature flags",
    'Each pins its flag to "true" or "false"; unset, it follows Status → Feature flags.',
  );
  const pins: Partial<Record<FeatureFlagName, boolean>> = {};
  for (const [name, { description, default: on }] of Object.entries(featureFlags) as [
    FeatureFlagName,
    (typeof featureFlags)[FeatureFlagName],
  ][]) {
    const pin = r.custom(
      featureFlagEnvironmentVariable(name),
      { help: `${description} Default ${on}.`, example: String(on) },
      (raw): { value: boolean } | { error: string } =>
        raw === "true" || raw === "false"
          ? { value: raw === "true" }
          : { error: 'must be "true" or "false"' },
    );
    if (pin !== undefined) pins[name] = pin;
  }

  r.section(
    "MCP server",
    "Lets AI agents query the library. It proxies the HTTP API, so it can run on another host (`bun run --filter server mcp`). See src/mcp/README.md.",
  );
  const autostart = r.flag("MCP_AUTOSTART", true, ["true", "false"], {
    help: "Start the MCP server inside the main server. false when it runs standalone elsewhere.",
  });
  const mcpPort = r.port("MCP_PORT", 3100, {
    help: "Port the MCP server listens on (Streamable HTTP at /mcp). 0 picks a free one.",
  });
  const baseUrl =
    r.url("PHOTRIX_BASE_URL", {
      help: "Base URL of the Photrix HTTP server the MCP server proxies.",
      example: "http://localhost:3000",
    }) ?? "http://localhost:3000";
  const mcp = {
    autostart,
    port: mcpPort,
    baseUrl,
    /** Where a person opens a result: the public origin when there is one. */
    publicUrl: server.publicUrl ?? baseUrl,
    token: r.secret("PHOTRIX_TOKEN", {
      help: "The Photrix bearer the MCP server uses in shared-secret mode (MCP_AUTH_TOKEN set). In per-user mode each caller sends their own MCP key from the account panel instead.",
    }),
    authToken: r.secret("MCP_AUTH_TOKEN", {
      help: "Legacy shared secret for the MCP endpoint. When set, callers send it as a bearer and the server reaches Photrix with PHOTRIX_TOKEN. Leave unset for per-user keys.",
    }),
    timeoutMs: r.ms("PHOTRIX_MCP_TIMEOUT_MS", 30_000, {
      help: "Per-request timeout (ms) when the MCP server calls Photrix.",
    }),
  };

  r.section("Tracing (OpenTelemetry)");
  const enabledTelemetry = r.flag("PHOTRIX_OTEL_ENABLED", false, ["true", "false"], {
    help: "Export request and operation spans over OTLP HTTP (Jaeger all-in-one accepts them on port 4318).",
    active: true,
  });
  const photrixEndpoint = r.url("PHOTRIX_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", {
    help: "OTLP traces endpoint.",
    example: "http://127.0.0.1:4318/v1/traces",
  });
  const standardEndpoint = r.url("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", {
    help: "The standard OpenTelemetry name for the same setting, used when the one above is unset.",
  });
  const telemetry = {
    enabled: enabledTelemetry,
    tracesEndpoint:
      photrixEndpoint ?? standardEndpoint ?? "http://127.0.0.1:4318/v1/traces",
  };

  return {
    reader: r,
    config: {
      media,
      db,
      server,
      auth,
      search,
      shareScope,
      ollama,
      hls,
      python,
      background,
      featureFlags: pins,
      mcp,
      telemetry,
    },
  };
};

export type Config = ReturnType<typeof read>["config"];

/** Parses and validates `env`, throwing one ConfigError that lists every problem. */
export const loadConfig = (env: Env, role: Role = "any"): Config => {
  const { reader, config } = read(env, role);
  if (reader.issues.length) throw new ConfigError(reader.issues);
  return config;
};

/** The variables and sections `.env.example` documents, in order. */
export const describeEnv = () => read({}, "any").reader.docs;

/**
 * config.fixture.ts installs a test's config here. It lives on globalThis so an
 * override survives `jest.resetModules()`, which hands re-imported modules a
 * fresh copy of this file.
 */
export const CONFIG_OVERRIDE = Symbol.for("photrix.configOverride");
type OverrideSlot = { [CONFIG_OVERRIDE]?: { config: Config } };

let loaded: Config | undefined;

/**
 * Validates the environment for `role` and keeps the result. An entry point
 * calls this before anything reads config; on a bad environment it prints
 * every problem and exits.
 */
export const initConfig = (role: Role): Config => {
  try {
    loaded = loadConfig(processEnv(), role);
    return loaded;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
};

/** The server's configuration. Read it where it is used, not into module constants. */
export const config = (): Config =>
  (globalThis as OverrideSlot)[CONFIG_OVERRIDE]?.config ??
  (loaded ??= loadConfig(processEnv()));

// The one place config reads the process environment; see initConfig for startup.
const processEnv = (): Env => process.env;
