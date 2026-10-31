import type Hls from "hls.js";
import type { HlsConfig, LoaderStats } from "hls.js";

// hls.js settings for Photrix's on-the-fly HLS.
//
// hls.js assumes segments already exist and that time spent waiting for the
// first byte is network round trip. Here a segment can be encoded *while the
// player asks for it*: a seek, a quality switch or a busy box makes the server
// long-poll for a second or more. Stock hls.js reads that wait as a slow
// network, and reacts the one way that makes it worse: it drops a quality
// level, whose encode then has to cold-start too, and the upswitch guard
// (hlsAbrGuard.ts) holds it down there. Measured with the playback lab
// (e2e/playback-lab): hunting 1080p↔360p a dozen times a minute on a loaded box.
//
// Two adjustments keep ABR about the network:
//  - bandwidth samples discount server wait beyond the fastest first byte seen
//    (that minimum is the network's round trip plus the server's floor);
//  - the emergency "abandon this fragment and drop a level" rule does not fire
//    before the first byte arrives, because a lower level is no closer to
//    existing than this one. Once bytes flow, it applies normally.
// The fragment timeouts in hls.js's load policy still bound a wait that never ends.
//
// Imports from hls.js are types only, so the playback lab can transpile this
// file and load it next to hls.min.js without a bundler.

type HlsClass = typeof Hls;

/** The viewer's buffer and timeout settings. */
export const ON_THE_FLY_HLS_CONFIG = {
  enableWorker: true,
  lowLatencyMode: false,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  maxBufferSize: 60 * 1000 * 1000,
  maxBufferHole: 0.5,
  liveSyncDurationCount: 3,
  liveMaxLatencyDurationCount: Infinity,
  levelLoadingTimeOut: 20000,
  manifestLoadingTimeOut: 20000,
  levelLoadingRetryDelay: 1000,
} satisfies Partial<HlsConfig>;

/** Where a player's round-trip floor is tracked; one per player. */
type ServerWaitTracker = { minTtfbMs: number };

export const createServerWaitTracker = (): ServerWaitTracker => ({ minTtfbMs: Infinity });

/**
 * Moves a completed request's start forward past any server wait beyond the
 * fastest first byte this player has seen, so the bandwidth estimate measures
 * the network. Records the discounted wait as `serverWaitMs`. Returns it.
 */
export const discountServerWait = (
  stats: LoaderStats & { serverWaitMs?: number },
  tracker: ServerWaitTracker,
): number => {
  const ttfb = stats.loading.first - stats.loading.start;
  if (!(stats.loading.first > 0) || !(ttfb >= 0)) return 0;
  tracker.minTtfbMs = Math.min(tracker.minTtfbMs, ttfb);
  const wait = ttfb - tracker.minTtfbMs;
  if (wait <= 0) return 0;
  stats.loading.start += wait;
  stats.serverWaitMs = wait;
  return wait;
};

/** True once a request has received its first byte. */
export const hasFirstByte = (stats: LoaderStats | undefined): boolean =>
  Boolean(stats && stats.loading.first > 0);

/** A loader class (extending `Base`) that discounts server wait in every sample. */
const createEncoderAwareLoader = (
  HlsCtor: HlsClass,
  tracker: ServerWaitTracker = createServerWaitTracker(),
) => {
  const Base = HlsCtor.DefaultConfig.loader;
  return class EncoderAwareLoader extends Base {
    load(...args: Parameters<InstanceType<typeof Base>["load"]>) {
      const [context, config, callbacks] = args;
      const onSuccess = callbacks.onSuccess;
      callbacks.onSuccess = (response, stats, ctx, details) => {
        discountServerWait(stats, tracker);
        onSuccess(response, stats, ctx, details);
      };
      super.load(context, config, callbacks);
    }
  };
};

type AbandonInternals = {
  _abandonRulesCheck?: ((levelLoaded?: unknown) => void) | null;
  fragCurrent?: { stats?: LoaderStats } | null;
  partCurrent?: { stats?: LoaderStats } | null;
};

/**
 * hls.js's ABR controller with the emergency-abandon rule held off until the
 * first byte. Reaches into an hls.js internal (`_abandonRulesCheck`); if a
 * future hls.js renames it, `encoderAware` is false and the stock rule runs
 * unchanged — encoderAwareHls.spec.ts fails loudly on that.
 */
export const createEncoderAwareAbrController = (HlsCtor: HlsClass) => {
  const Base = HlsCtor.DefaultConfig.abrController;
  return class EncoderAwareAbrController extends Base {
    readonly encoderAware: boolean;
    constructor(...args: ConstructorParameters<typeof Base>) {
      super(...args);
      const self = this as unknown as AbandonInternals;
      const stock = self._abandonRulesCheck;
      this.encoderAware = typeof stock === "function";
      if (typeof stock !== "function") return;
      self._abandonRulesCheck = (levelLoaded?: unknown) => {
        const current = self.partCurrent ?? self.fragCurrent;
        if (current?.stats && !hasFirstByte(current.stats)) return;
        stock(levelLoaded);
      };
    }
  };
};

/**
 * Everything the viewer passes to `new Hls()` apart from auth and its own
 * loader hooks. `bandwidthMbps` is the viewer's own measurement, if it has one.
 */
export const onTheFlyHlsConfig = (HlsCtor: HlsClass, bandwidthMbps: number | null) => ({
  ...ON_THE_FLY_HLS_CONFIG,
  loader: createEncoderAwareLoader(HlsCtor),
  // Only when hls.js exposes one to extend (test doubles of hls.js may not).
  ...(typeof HlsCtor.DefaultConfig.abrController === "function"
    ? { abrController: createEncoderAwareAbrController(HlsCtor) }
    : {}),
  // Seed hls.js's own bandwidth estimate from the measurement the viewer already
  // took, instead of its hardcoded 500 kbps default, and start at the rung it
  // supports instead of test-loading the lowest: every rung is a separate
  // on-demand encode, so climbing 360p→720p→1080p on open costs two extra
  // encodes and two visible quality jumps.
  ...(bandwidthMbps
    ? { abrEwmaDefaultEstimate: bandwidthMbps * 1_000_000, testBandwidth: false }
    : {}),
});
