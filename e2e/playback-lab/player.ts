import type { CDPSession, Page, TestInfo } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(here, "..", "..", "client");
const HLS_JS = resolve(CLIENT, "node_modules", "hls.js", "dist", "hls.min.js");
const APP_HLS_CONFIG = resolve(CLIENT, "src", "encoderAwareHls.ts");
const APP_ABR_GUARD = resolve(CLIENT, "src", "hlsAbrGuard.ts");

/**
 * A client module as a page script: types stripped, imports dropped (hls.js is
 * the page's global `Hls`), exports turned into locals for `expose` to publish.
 */
const pageScript = (file: string, expose: string): string => {
  const js = ts
    .transpileModule(readFileSync(file, "utf-8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    .outputText.replace(/^import .*$/gm, "")
    .replace(/^export /gm, "");
  return `(() => {\n${js}\n${expose}\n})();`;
};
const RESULTS_DIR = resolve(here, "..", "test-results", "playback-lab", "results");

/**
 * The viewer's own hls.js configuration (client/src/encoderAwareHls.ts),
 * transpiled for the page, so the lab measures exactly what the app ships
 * rather than a copy that drifts. It imports hls.js types only, so stripping
 * the types is all it takes. `PHOTRIX_LAB_STOCK_ABR=1` swaps in the same
 * buffer settings with stock hls.js ABR, for an A/B.
 */
const appHlsConfigScript = (): string => {
  const stock = process.env.PHOTRIX_LAB_STOCK_ABR === "1";
  if (!existsSync(APP_HLS_CONFIG)) {
    // A tree from before the config was its own module: the settings it inlined.
    return `window.__labHlsConfig = (Hls, mbps) => ({
      enableWorker: true, lowLatencyMode: false, maxBufferLength: 30, maxMaxBufferLength: 60,
      maxBufferSize: 60e6, maxBufferHole: 0.5, liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: Infinity, levelLoadingTimeOut: 20000,
      manifestLoadingTimeOut: 20000, levelLoadingRetryDelay: 1000,
      ...(mbps ? { abrEwmaDefaultEstimate: mbps * 1e6, testBandwidth: false } : {}),
    }); window.__labHlsConfigSource = "inline (pre-module tree)";`;
  }
  const pick = stock
    ? "(Hls, mbps) => ({ ...ON_THE_FLY_HLS_CONFIG, ...(mbps ? { abrEwmaDefaultEstimate: mbps * 1e6, testBandwidth: false } : {}) })"
    : "onTheFlyHlsConfig";
  return pageScript(
    APP_HLS_CONFIG,
    `window.__labHlsConfig = ${pick}; window.__labHlsConfigSource = ${JSON.stringify(stock ? "app buffers, stock ABR" : "app")};`,
  );
};

/** The viewer's upswitch guard (client/src/hlsAbrGuard.ts), attached as the viewer does. */
const appAbrGuardScript = (): string =>
  process.env.PHOTRIX_LAB_STOCK_ABR === "1" || !existsSync(APP_ABR_GUARD)
    ? "window.__labAttachAbrGuard = () => () => {};"
    : pageScript(APP_ABR_GUARD, "window.__labAttachAbrGuard = attachHlsAbrUpswitchGuard;");

export type FragSample = {
  level: number;
  sn: number;
  /** ms from player start to the request. */
  at: number;
  /** Time to first byte: for an on-the-fly encode, mostly the server's wait. */
  ttfbMs: number;
  totalMs: number;
  bytes: number;
};

export type LabMetrics = {
  firstFrameMs: number | null;
  stalls: { at: number; ms: number }[];
  /** A stall still open when metrics were read. */
  openStallMs: number;
  seeks: { to: number; at: number; ms: number | null }[];
  frags: FragSample[];
  errors: { at: number; details: string; fatal: boolean; level?: number; sn?: number }[];
  levelSwitches: { at: number; level: number; height: number }[];
  /** hls.js gave up on a fragment mid-load to drop a level (its "emergency" ABR rule). */
  emergencyAborts: { at: number; level: number; sn: number }[];
  failed: string | null;
  ended: boolean;
  currentTime: number;
  bufferedAhead: number;
};

/** Headless Chromium with the app's hls.js on a blank page served from the lab API's origin. */
export const openPlayer = async (page: Page): Promise<void> => {
  // Same origin as the API, so segment requests need no CORS.
  await page.goto("/api/health");
  await page.setContent(
    `<!doctype html><body style="margin:0;background:#000"><video id="v" muted playsinline style="width:640px"></video></body>`,
  );
  await page.addScriptTag({ path: HLS_JS });
  await page.addScriptTag({ content: appHlsConfigScript() });
  await page.addScriptTag({ content: appAbrGuardScript() });
};

/** Starts playback of `name` (a file under the lab media root) through HLS. */
export const startPlayback = async (
  page: Page,
  name: string,
  opts: {
    bandwidthMbps?: number | null;
    startLevel?: number;
    /** Lock this level at start, as the viewer does for a saved quality choice. */
    lockLevel?: number;
    hlsConfig?: object;
  } = {},
): Promise<void> => {
  const src = `/api/files/${encodeURIComponent(name)}?representation=hls`;
  await page.evaluate(
    ({ src, bandwidthMbps, overrides, startLevel, lockLevel }) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const w = window as any;
      const Hls = w.Hls;
      const config = { ...w.__labHlsConfig(Hls, bandwidthMbps), ...overrides };
      const video = document.getElementById("v") as HTMLVideoElement;
      const t0 = performance.now();
      const now = () => Math.round(performance.now() - t0);
      const m: any = {
        firstFrameMs: null,
        stalls: [],
        waitingSince: null,
        seeks: [],
        frags: [],
        errors: [],
        levelSwitches: [],
        emergencyAborts: [],
        failed: null,
        ended: false,
      };
      const hls = new Hls(config);
      if (typeof startLevel === "number") hls.startLevel = startLevel;
      hls.on(Hls.Events.FRAG_LOADED, (_e: unknown, d: any) => {
        const s = d.frag.stats.loading;
        m.frags.push({
          level: d.frag.level,
          sn: d.frag.sn,
          at: Math.round(s.start - t0),
          // The app's loader may have discounted server wait from `start`
          // (encoderAwareHls.ts); add it back so this is the real wait.
          ttfbMs: Math.round(s.first - s.start + (d.frag.stats.serverWaitMs ?? 0)),
          totalMs: Math.round(s.end - s.start + (d.frag.stats.serverWaitMs ?? 0)),
          bytes: d.frag.stats.loaded,
        });
      });
      hls.on(Hls.Events.FRAG_LOAD_EMERGENCY_ABORTED, (_e: unknown, d: any) => {
        m.emergencyAborts.push({ at: now(), level: d.frag.level, sn: d.frag.sn });
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e: unknown, d: any) => {
        m.levelSwitches.push({ at: now(), level: d.level, height: hls.levels[d.level]?.height });
      });
      // The app's recovery policy: two in-place retries of each kind, then give up.
      let net = 0;
      let media = 0;
      // As the viewer does: a recovered stream gets a fresh budget.
      hls.on(Hls.Events.FRAG_LOADED, () => { net = 0; });
      hls.on(Hls.Events.FRAG_BUFFERED, () => { media = 0; });
      hls.on(Hls.Events.ERROR, (_e: unknown, d: any) => {
        m.errors.push({ at: now(), details: d.details, fatal: d.fatal, level: d.frag?.level, sn: d.frag?.sn });
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && net < 2) { net += 1; hls.startLoad(); return; }
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && media < 2) { media += 1; hls.recoverMediaError(); return; }
        m.failed = d.details;
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // The viewer's saved quality preference, as a lock from the start.
        if (typeof lockLevel === "number") hls.currentLevel = lockLevel;
        void video.play().catch(() => {});
      });
      w.__labAttachAbrGuard(hls);
      video.addEventListener("playing", () => {
        if (m.firstFrameMs === null) m.firstFrameMs = now();
        const seek = m.seeks.at(-1);
        if (seek && seek.ms === null) seek.ms = now() - seek.at;
        if (m.waitingSince !== null) {
          // A wait that a seek caused is the seek's latency, not a stall.
          if (!(seek && seek.at >= m.waitingSince - 50)) m.stalls.push({ at: m.waitingSince, ms: now() - m.waitingSince });
          m.waitingSince = null;
        }
      });
      video.addEventListener("waiting", () => {
        if (m.firstFrameMs !== null && m.waitingSince === null) m.waitingSince = now();
      });
      video.addEventListener("ended", () => { m.ended = true; });
      w.__lab = { m, hls, video, now };
      hls.loadSource(src);
      hls.attachMedia(video);
    },
    {
      src,
      bandwidthMbps: opts.bandwidthMbps ?? null,
      overrides: opts.hlsConfig ?? {},
      startLevel: opts.startLevel,
      lockLevel: opts.lockLevel,
    },
  );
};

export const readMetrics = (page: Page): Promise<LabMetrics> =>
  page.evaluate(() => {
    const { m, video, now } = (window as any).__lab;
    const ranges = video.buffered as TimeRanges;
    let bufferedAhead = 0;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= video.currentTime + 0.5 && ranges.end(i) > video.currentTime) {
        bufferedAhead = ranges.end(i) - video.currentTime;
      }
    }
    const { waitingSince, ...rest } = m;
    return {
      ...JSON.parse(JSON.stringify(rest)),
      openStallMs: waitingSince === null ? 0 : now() - waitingSince,
      currentTime: video.currentTime,
      bufferedAhead,
    };
  });

/** Seeks the player and records how long until it is playing again. */
export const seek = (page: Page, to: number) =>
  page.evaluate((to) => {
    const { m, video, now } = (window as any).__lab;
    m.seeks.push({ to, at: now(), ms: null });
    video.currentTime = to;
  }, to);

export const setPaused = (page: Page, paused: boolean) =>
  page.evaluate((paused) => {
    const { video } = (window as any).__lab;
    if (paused) video.pause();
    else void video.play();
  }, paused);

/** The quality picker: `nextLevel`, exactly as the viewer's selector does. -1 = Auto. */
export const chooseLevel = (page: Page, level: number) =>
  page.evaluate((level) => {
    (window as any).__lab.hls.nextLevel = level;
  }, level);

/** Waits until the player has reached `seconds` of media time, or `timeoutMs` passes. */
export const playUntil = async (page: Page, seconds: number, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = await readMetrics(page);
    if (m.currentTime >= seconds || m.ended || m.failed) return;
    await page.waitForTimeout(250);
  }
};

// ---------------------------------------------------------------------------
// Network shaping (Chrome DevTools Protocol)
// ---------------------------------------------------------------------------

export type NetworkProfile = { downMbps: number; latencyMs: number };

export const shapeNetwork = async (page: Page, profile: NetworkProfile | null): Promise<CDPSession> => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await applyProfile(cdp, profile);
  return cdp;
};

export const applyProfile = (cdp: CDPSession, profile: NetworkProfile | null) =>
  cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: profile?.latencyMs ?? 0,
    downloadThroughput: profile ? (profile.downMbps * 1_000_000) / 8 : -1,
    uploadThroughput: profile ? 2_000_000 / 8 : -1,
  });

/** Cycles through `profiles`, `periodMs` each, until the returned stop() is called. */
export const jitterNetwork = (cdp: CDPSession, profiles: NetworkProfile[], periodMs: number) => {
  let i = 0;
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      await applyProfile(cdp, profiles[i++ % profiles.length]);
      await new Promise((r) => setTimeout(r, periodMs));
    }
  };
  void tick();
  return () => {
    stopped = true;
  };
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

export const summarize = (m: LabMetrics) => {
  const stalledMs = m.stalls.reduce((sum, s) => sum + s.ms, 0) + m.openStallMs;
  const ttfb = m.frags.map((f) => f.ttfbMs);
  return {
    firstFrameMs: m.firstFrameMs,
    stalls: m.stalls.length + (m.openStallMs > 0 ? 1 : 0),
    stalledMs,
    longestStallMs: Math.max(0, m.openStallMs, ...m.stalls.map((s) => s.ms)),
    seekMs: m.seeks.map((s) => s.ms),
    frags: m.frags.length,
    fragTtfbP50: percentile(ttfb, 50),
    fragTtfbMax: percentile(ttfb, 100),
    levels: m.levelSwitches.map((l) => l.height),
    emergencyAborts: m.emergencyAborts.length,
    errors: m.errors.map((e) => `${e.fatal ? "FATAL " : ""}${e.details}`),
    failed: m.failed,
    reachedS: Math.round(m.currentTime * 10) / 10,
  };
};

/** Writes the full metrics as JSON, attaches them to the report, and prints a one-line summary. */
export const report = async (testInfo: TestInfo, label: string, m: LabMetrics) => {
  const summary = summarize(m);
  await mkdir(RESULTS_DIR, { recursive: true });
  const slug = `${testInfo.title}${label ? `-${label}` : ""}`.replace(/[^a-z0-9]+/gi, "-");
  await writeFile(resolve(RESULTS_DIR, `${slug}.json`), JSON.stringify({ summary, metrics: m }, null, 2));
  await testInfo.attach(slug, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  console.log(`[lab] ${testInfo.title}${label ? ` [${label}]` : ""}: ${JSON.stringify(summary)}`);
  return summary;
};
