import Hls from "hls.js";
import { getToken } from "../../auth";
import { prefersReducedMotion } from "./tilePlaybackCoordinator";

/**
 * A negotiated, preview-safe playback source. `previewMaxSeconds`, when set, is
 * the point at which the preview must loop back to the start — for the
 * cached-HLS and raw-read sources it marks the end of the region the server
 * promised not to encode further, so honouring it is what keeps those previews
 * from making the server encode anything. It is absent for a live transcode
 * preview: that source is a real ongoing encode, so it plays normally (no
 * looping) for as long as the tile keeps the playback slot.
 */
export type TilePlaybackSource = {
  mode: "hls" | "direct";
  url: string;
  previewMaxSeconds?: number;
};

export type TileVideoHandle = {
  /**
   * Stop playback and drop every resource: the MSE buffers, the hls.js worker
   * and its in-flight segment XHRs, and any open range request on the original.
   * Idempotent.
   */
  detach: () => void;
  /**
   * Cosmetic coast-to-a-stop for when the hover ends on its own terms (not an
   * eviction or a hidden tab): cuts new segment fetches immediately — so this
   * costs nothing on the server the instant it's called — then eases the
   * element's `playbackRate` down to a stop over `durationMs` on whatever is
   * already buffered, leaving a frozen last frame rather than a hard cut.
   * `onDone` fires once it's paused. Calling `detach()` at any point (e.g. a
   * fresh hover restarting this tile) aborts the ramp on its next tick.
   */
  windDown: (durationMs: number, onDone: () => void) => void;
};

const withAuthToken = (rawUrl: string): string => {
  const token = getToken();
  if (!token) return rawUrl;
  const url = new URL(rawUrl, window.location.origin);
  url.searchParams.set("token", token);
  return url.toString();
};

const supportsNativeHls = (video: HTMLVideoElement): boolean =>
  typeof video.canPlayType === "function" &&
  video.canPlayType("application/vnd.apple.mpegurl") !== "";

/**
 * Point a <video> at a negotiated preview source and start it muted.
 *
 * Everything this touches is reachable from the returned `detach`, on purpose:
 * a tile preview may need to be killed mid-handshake (pointer left, tile
 * scrolled away, tab hidden, another tile took the slot) and leaving a segment
 * fetch or a decoder alive is exactly the leak that starves the shared GPU.
 */
export const attachTileVideo = (
  video: HTMLVideoElement,
  source: TilePlaybackSource,
): TileVideoHandle => {
  const maxSeconds = source.previewMaxSeconds;
  let hls: Hls | null = null;
  let detached = false;

  // Loop inside the region we know is safe to play rather than letting the
  // element run on into un-encoded territory. A live-transcode source has no
  // cap: it's a real encode, so it just plays until the hover ends.
  const handleTimeUpdate = () => {
    if (detached || maxSeconds === undefined) return;
    if (video.currentTime >= maxSeconds) {
      try {
        video.currentTime = 0;
      } catch {
        // Seeking can throw before metadata lands; the next tick retries.
      }
    }
  };

  const startPlayback = () => {
    if (detached) return;
    // Autoplay is only permitted while muted; a grid preview is silent anyway.
    void video.play().catch(() => {
      // Blocked or interrupted by teardown — nothing to recover, the poster
      // image is still underneath.
    });
  };

  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.loop = false;
  video.preload = "metadata";
  video.addEventListener("timeupdate", handleTimeUpdate);
  video.addEventListener("loadeddata", startPlayback);

  const url = withAuthToken(source.url);

  if (source.mode === "hls" && !supportsNativeHls(video) && Hls.isSupported()) {
    hls = new Hls({
      // A preview is a few seconds long: keep the buffer tiny so teardown has
      // almost nothing to throw away and we never pull segments we won't show.
      maxBufferLength: 4,
      maxMaxBufferLength: 6,
      backBufferLength: 0,
      // Never climb off the low variant we were handed — the whole point of the
      // preview negotiation is to stay on already-encoded 360p.
      capLevelToPlayerSize: false,
      startLevel: 0,
      autoStartLoad: true,
    });
    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      hls?.loadSource(url);
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      // Previews are disposable: any fatal error just ends this one quietly.
      if (data.fatal) detach();
    });
  } else {
    video.src = url;
    video.load();
    startPlayback();
  }

  const detach = () => {
    if (detached) return;
    detached = true;

    video.removeEventListener("timeupdate", handleTimeUpdate);
    video.removeEventListener("loadeddata", startPlayback);

    try {
      video.pause();
    } catch {
      // Detached elements can throw; the rest of teardown still matters.
    }

    if (hls) {
      // stopLoad first so no new segment request is issued while destroy runs;
      // destroy() then aborts the in-flight ones and frees the MSE buffers.
      try {
        hls.stopLoad();
        hls.detachMedia();
        hls.destroy();
      } catch {
        // Already destroyed.
      }
      hls = null;
    }

    // Clearing src + load() is what actually cancels an open range request on
    // the original file. Without it the browser happily keeps downloading a
    // video nobody is looking at.
    try {
      video.removeAttribute("src");
      video.load();
    } catch {
      // jsdom / detached element — nothing left to cancel.
    }
  };

  // Never let the ramp chase playbackRate all the way to 0: some engines treat
  // that as a hard stop with odd side effects. The explicit pause() below is
  // what actually ends playback; this floor just keeps the last tick smooth.
  const MIN_WINDDOWN_RATE = 0.1;

  const windDown = (durationMs: number, onDone: () => void) => {
    if (detached) {
      onDone();
      return;
    }
    // Stop the network side the instant the hover ends — the ramp below only
    // ever plays back what's already buffered, so this is what makes leaving
    // free on the server regardless of how long the visual tail takes.
    hls?.stopLoad();

    if (prefersReducedMotion() || durationMs <= 0) {
      try {
        video.pause();
      } catch {
        // Already gone.
      }
      onDone();
      return;
    }

    const startRate = video.playbackRate || 1;
    const startedAt = performance.now();

    const tick = (now: number) => {
      if (detached) return;
      const t = Math.min(1, (now - startedAt) / durationMs);
      // Ease-out: falls fast at first, coasts gently into the stop.
      const eased = 1 - (1 - t) * (1 - t);
      try {
        video.playbackRate = Math.max(MIN_WINDDOWN_RATE, startRate * (1 - eased));
      } catch {
        // Some engines reject extreme rates; the final pause() still lands.
      }
      if (t >= 1) {
        try {
          video.pause();
        } catch {
          // Already gone.
        }
        onDone();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  return { detach, windDown };
};
