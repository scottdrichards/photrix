import { describe, expect, it } from "@jest/globals";
import { loadConfig } from "./config.ts";
import { ConfigError, parseByteSize } from "./env.ts";

const issuesOf = (
  env: Record<string, string>,
  role?: "server" | "mcp",
): readonly string[] => {
  try {
    loadConfig(env, role);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  return [];
};

describe("loadConfig", () => {
  it("applies the defaults to an empty environment", () => {
    const config = loadConfig({});
    expect(config.server).toMatchObject({
      port: 3000,
      logLevel: "debug",
      isProduction: false,
    });
    expect(config.hls).toMatchObject({
      idleMs: 90_000,
      variantIdleMs: 8_000,
      seekRestartGapSegments: 10,
    });
    expect(config.media.cacheMaxBytes).toBe(10 * 1024 ** 3);
    expect(config.db.directory).toBe(config.media.cacheDir);
    expect(config.auth).toMatchObject({
      enabled: false,
      ipLocation: true,
      sessionExpiryDays: 30,
    });
    expect(config.mcp).toMatchObject({
      autostart: true,
      port: 3100,
      baseUrl: "http://localhost:3000",
    });
    expect(config.search.clapMinSimilarity).toBe(0.52);
    expect(config.shareScope.clapMinSimilarity).toBe(0.45);
    expect(config.featureFlags).toEqual({});
  });

  it("treats an empty value as unset", () => {
    expect(loadConfig({ PORT: "", PHOTRIX_OLLAMA_MODEL: "" })).toMatchObject({
      server: { port: 3000 },
      ollama: { model: "llama3.2:3b" },
    });
  });

  it("keeps each reader's meaning of 0", () => {
    const config = loadConfig({
      PHOTRIX_HLS_IDLE_MS: "0",
      PHOTRIX_WHISPER_START_QUIET_MS: "0",
      PHOTRIX_MEMORY_LOG_INTERVAL_MS: "0",
      MCP_PORT: "0",
      PHOTRIX_THUMBNAIL_BACKFILL_MAX_LOAD: "-1",
    });
    expect(config.hls.idleMs).toBe(90_000);
    expect(config.python.whisperStartQuietMs).toBe(0);
    expect(config.server.memoryLogIntervalMs).toBe(0);
    expect(config.mcp.port).toBe(0);
    expect(config.media.thumbnailBackfill.maxLoad).toBe(0.5);
  });

  it("lists every bad variable at once", () => {
    expect(
      issuesOf({
        PORT: "abc",
        PHOTRIX_HLS_IDLE_MS: "-5",
        PHOTRIX_DISABLE_AUDIO: "true",
        LOG_LEVEL: "loud",
      }),
    ).toEqual([
      'PORT: expected an integer >= 0 and <= 65535, got "abc"',
      'LOG_LEVEL: expected one of fatal, error, warn, info, debug, trace, silent, got "loud"',
      'PHOTRIX_HLS_IDLE_MS: expected a number >= 0, got "-5"',
      'PHOTRIX_DISABLE_AUDIO: expected "1" or "0", got "true"',
    ]);
  });

  it("never echoes a secret", () => {
    const issues = issuesOf({
      PHOTRIX_ACCOUNTS: "not json hunter2",
      PHOTRIX_SHARE_TOKEN_SECRET: "short",
    });
    expect(issues).toEqual([
      "PHOTRIX_ACCOUNTS: must be a valid JSON array",
      "PHOTRIX_SHARE_TOKEN_SECRET: must be at least 32 characters",
    ]);
  });

  it("parses accounts and turns sign-in on", () => {
    const config = loadConfig({
      PHOTRIX_ACCOUNTS: JSON.stringify([{ username: "alice", password: "pw" }]),
    });
    expect(config.auth).toMatchObject({
      enabled: true,
      accounts: [{ username: "alice", password: "pw" }],
    });
    expect(
      issuesOf({ PHOTRIX_ACCOUNTS: JSON.stringify([{ username: "alice" }]) }),
    ).toHaveLength(1);
  });

  it("requires MEDIA_ROOT and, with sign-in on, the share secret, only for the server", () => {
    expect(issuesOf({ AUTH_PASSWORD: "pw" }, "server")).toEqual([
      "MEDIA_ROOT: required, the folder of media to index",
      "PHOTRIX_SHARE_TOKEN_SECRET: required when AUTH_PASSWORD or PHOTRIX_ACCOUNTS is set",
    ]);
    expect(issuesOf({ AUTH_PASSWORD: "pw" }, "mcp")).toEqual([]);
    expect(issuesOf({ MEDIA_ROOT: "./exampleFolder" }, "server")).toEqual([]);
  });

  it("strips trailing slashes from URLs and rejects relative ones", () => {
    expect(
      loadConfig({ PHOTRIX_PUBLIC_URL: "https://photos.example.com//" }).mcp.publicUrl,
    ).toBe("https://photos.example.com");
    expect(issuesOf({ PHOTRIX_RP_ORIGIN: "photos.example.com" })).toEqual([
      'PHOTRIX_RP_ORIGIN: expected an absolute URL, got "photos.example.com"',
    ]);
  });

  it("pins feature flags", () => {
    expect(loadConfig({ PHOTRIX_FLAG_THUMBNAIL_BACKFILL: "false" }).featureFlags).toEqual(
      {
        thumbnailBackfill: false,
      },
    );
    expect(issuesOf({ PHOTRIX_FLAG_THUMBNAIL_BACKFILL: "0" })).toEqual([
      'PHOTRIX_FLAG_THUMBNAIL_BACKFILL: must be "true" or "false", got "0"',
    ]);
  });

  it("prefers the Photrix OTLP endpoint over the standard one", () => {
    expect(
      loadConfig({
        PHOTRIX_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://a.example:4318/v1/traces",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://b.example:4318/v1/traces",
      }).telemetry.tracesEndpoint,
    ).toBe("http://a.example:4318/v1/traces");
  });
});

describe("parseByteSize", () => {
  it("parses plain byte counts", () => {
    expect(parseByteSize("1024")).toBe(1024);
  });

  it("parses suffixed sizes case-insensitively", () => {
    expect(parseByteSize("10GB")).toBe(10 * 1024 ** 3);
    expect(parseByteSize("512mb")).toBe(512 * 1024 ** 2);
  });

  it("returns null for unset or invalid values", () => {
    expect(parseByteSize(undefined)).toBeNull();
    expect(parseByteSize("not-a-size")).toBeNull();
  });
});
