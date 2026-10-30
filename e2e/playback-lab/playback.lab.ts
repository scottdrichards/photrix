import { expect, test, type Page } from "@playwright/test";
import { LAB_CLIPS } from "./media.ts";
import {
  chooseLevel,
  jitterNetwork,
  openPlayer,
  playUntil,
  readMetrics,
  report,
  seek,
  setPaused,
  shapeNetwork,
  startPlayback,
} from "./player.ts";

// What a viewer experiences, measured. Each scenario plays real media through
// the real server and asserts *budgets*, softly, so one run reports every
// scenario that misses rather than stopping at the first. A miss is a finding,
// not necessarily a regression: read the printed `[lab]` lines and
// test-results/playback-lab/results/*.json.

/** The same order of magnitude the viewer's bandwidth probe reports on a LAN. */
const LAN_MBPS = 200;

const BUDGET = {
  /** Cold start to first frame. */
  firstFrameMs: 4_000,
  /** Seek to playing again. */
  seekMs: 4_000,
  /** One stall the viewer would sit through. */
  longestStallMs: 2_000,
};

test.beforeAll(async ({ request }) => {
  console.log(`[lab] hls.js config: ${process.env.PHOTRIX_LAB_STOCK_ABR === "1" ? "stock ABR" : "the app's"}`);
  // The lab measures playback; background indexing would only add noise.
  await request.post("/api/status/background-tasks", { data: { enabled: false } });
});

test.beforeEach(async ({ request }) => {
  // Every scenario starts cold: no encodes running, no segments on disk.
  await request.post("/api/status/clear-hls");
});

const expectSmooth = (s: ReturnType<typeof import("./player.ts").summarize>) => {
  expect.soft(s.failed, "playback failed").toBeNull();
  expect.soft(s.firstFrameMs ?? Infinity, "first frame").toBeLessThan(BUDGET.firstFrameMs);
  expect.soft(s.longestStallMs, "longest stall").toBeLessThan(BUDGET.longestStallMs);
};

const newPlayer = async (page: Page) => {
  await openPlayer(page);
  return page;
};

test("short clip plays to the end", async ({ page }, info) => {
  await newPlayer(page);
  await startPlayback(page, LAB_CLIPS.short.name, { bandwidthMbps: LAN_MBPS });
  await playUntil(page, LAB_CLIPS.short.durationS, 30_000);
  const s = await report(info, "", await readMetrics(page));
  expectSmooth(s);
  expect.soft(s.reachedS).toBeGreaterThanOrEqual(LAB_CLIPS.short.durationS - 0.5);
});

test("long clip starts and keeps playing", async ({ page }, info) => {
  await newPlayer(page);
  await startPlayback(page, LAB_CLIPS.long.name, { bandwidthMbps: LAN_MBPS });
  await playUntil(page, 45, 90_000);
  const s = await report(info, "", await readMetrics(page));
  expectSmooth(s);
});

test("phone-style 4K 10-bit portrait clip", async ({ page }, info) => {
  await newPlayer(page);
  await startPlayback(page, LAB_CLIPS.medium.name, { bandwidthMbps: LAN_MBPS });
  await playUntil(page, 45, 90_000);
  const s = await report(info, "", await readMetrics(page));
  expectSmooth(s);
});

test("seek far ahead in a long clip", async ({ page }, info) => {
  await newPlayer(page);
  await startPlayback(page, LAB_CLIPS.long.name, { bandwidthMbps: LAN_MBPS });
  await playUntil(page, 5, 30_000);
  await seek(page, 300);
  await playUntil(page, 310, 120_000);
  const s = await report(info, "", await readMetrics(page));
  expectSmooth(s);
  expect.soft(s.seekMs[0] ?? Infinity, "seek to 5:00").toBeLessThan(BUDGET.seekMs);
});

test("seek back after seeking ahead", async ({ page }, info) => {
  await newPlayer(page);
  await startPlayback(page, LAB_CLIPS.long.name, { bandwidthMbps: LAN_MBPS });
  await playUntil(page, 5, 30_000);
  await seek(page, 120);
  await playUntil(page, 125, 90_000);
  await seek(page, 20);
  await playUntil(page, 30, 90_000);
  const s = await report(info, "", await readMetrics(page));
  expectSmooth(s);
  for (const [i, ms] of s.seekMs.entries()) {
    expect.soft(ms ?? Infinity, `seek #${i + 1}`).toBeLessThan(BUDGET.seekMs);
  }
});

test("switch quality up mid-stream", async ({ page }, info) => {
  await newPlayer(page);
  // Watching at 360p (a saved choice), then picking 1080p by hand a minute in:
  // the 1080p encode has to start at the playhead, cold.
  await startPlayback(page, LAB_CLIPS.long.name, { bandwidthMbps: LAN_MBPS, lockLevel: 0 });
  await playUntil(page, 60, 120_000);
  const before = await readMetrics(page);
  const top = 2;
  await chooseLevel(page, top);
  const switchedAt = Date.now();
  let switchedMs: number | null = null;
  while (Date.now() - switchedAt < 60_000) {
    const m = await readMetrics(page);
    if (m.levelSwitches.some((l) => l.level === top)) {
      switchedMs = Date.now() - switchedAt;
      break;
    }
    await page.waitForTimeout(250);
  }
  await playUntil(page, before.currentTime + 20, 60_000);
  const s = await report(info, "", await readMetrics(page));
  console.log(`[lab] switch quality up mid-stream: 1080p on screen after ${switchedMs} ms`);
  expectSmooth(s);
  expect.soft(switchedMs ?? Infinity, "time until 1080p is on screen").toBeLessThan(10_000);
});

test("start below the link's real speed and climb", async ({ page }, info) => {
  await newPlayer(page);
  // The viewer's bandwidth probe under-read the link (it does on a busy
  // moment): Auto starts low and has to climb onto rungs not yet encoded.
  await startPlayback(page, LAB_CLIPS.long.name, { bandwidthMbps: 1 });
  await playUntil(page, 60, 120_000);
  const s = await report(info, "", await readMetrics(page));
  expectSmooth(s);
  expect.soft(s.levels.at(-1), "climbed to the top rung").toBe(1080);
});

test("pause longer than the variant idle window", async ({ page }, info) => {
  await newPlayer(page);
  await startPlayback(page, LAB_CLIPS.long.name, { bandwidthMbps: LAN_MBPS });
  await playUntil(page, 10, 60_000);
  await setPaused(page, true);
  // The buffer fills (30 s ahead), the player goes quiet, then sits paused.
  await page.waitForTimeout(45_000);
  await setPaused(page, false);
  await playUntil(page, 70, 120_000);
  const s = await report(info, "", await readMetrics(page));
  expectSmooth(s);
});

test("slow network", async ({ page }, info) => {
  await newPlayer(page);
  await shapeNetwork(page, { downMbps: 1.5, latencyMs: 150 });
  await startPlayback(page, LAB_CLIPS.medium.name, { bandwidthMbps: 1.5 });
  await playUntil(page, 60, 150_000);
  const s = await report(info, "", await readMetrics(page));
  expectSmooth(s);
});

test("jittery network", async ({ page }, info) => {
  await newPlayer(page);
  const cdp = await shapeNetwork(page, { downMbps: 10, latencyMs: 40 });
  const stop = jitterNetwork(
    cdp,
    [
      { downMbps: 10, latencyMs: 40 },
      { downMbps: 0.7, latencyMs: 400 },
      { downMbps: 4, latencyMs: 120 },
    ],
    7_000,
  );
  await startPlayback(page, LAB_CLIPS.long.name, { bandwidthMbps: 10 });
  await playUntil(page, 90, 180_000);
  stop();
  const s = await report(info, "", await readMetrics(page));
  expectSmooth(s);
});

test("three viewers on different clips at once", async ({ browser }, info) => {
  const clips = [LAB_CLIPS.long.name, LAB_CLIPS.medium.name, LAB_CLIPS.long.name];
  const contexts = await Promise.all(clips.map(() => browser.newContext({ baseURL: info.project.use.baseURL })));
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  await Promise.all(pages.map(openPlayer));
  // The third starts mid-clip, so its encode can't share the first's.
  await Promise.all(pages.map((p, i) => startPlayback(p, clips[i], { bandwidthMbps: LAN_MBPS })));
  await seek(pages[2], 200);
  await Promise.all(pages.map((p, i) => playUntil(p, i === 2 ? 230 : 30, 120_000)));
  for (const [i, p] of pages.entries()) {
    const s = await report(info, `viewer${i + 1}`, await readMetrics(p));
    expectSmooth(s);
  }
  await Promise.all(contexts.map((c) => c.close()));
});

test("two viewers on the same clip, 20 s apart", async ({ browser }, info) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL: info.project.use.baseURL })));
  const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
  await openPlayer(a);
  await openPlayer(b);
  await startPlayback(a, LAB_CLIPS.long.name, { bandwidthMbps: LAN_MBPS });
  await playUntil(a, 20, 60_000);
  await startPlayback(b, LAB_CLIPS.long.name, { bandwidthMbps: LAN_MBPS });
  await Promise.all([playUntil(a, 50, 90_000), playUntil(b, 30, 90_000)]);
  for (const [label, p] of [["first", a], ["second", b]] as const) {
    const s = await report(info, label, await readMetrics(p));
    expectSmooth(s);
  }
  await Promise.all(contexts.map((c) => c.close()));
});
