import { useEffect, useRef, useState } from "react";

export type ProgressiveImageFetch = {
  /**
   * Object URL for a fully-downloaded image, or `undefined` until the
   * download finishes. Left unset (rather than pointed at the still-loading
   * remote URL) so the caller never lets the browser start a second, native
   * request for the same resource on top of the one this hook is already
   * streaming.
   */
  src: string | undefined;
  /** True once the response headers have arrived (the request is in flight, not just queued). */
  hasStarted: boolean;
  /** 0..1 once `Content-Length` is known; null if the server didn't send one (so real progress can't be computed). */
  progress: number | null;
  /** Smoothed estimate of seconds remaining, or null until enough samples exist to estimate a rate. */
  etaSeconds: number | null;
  /** True once `src` is ready to render. */
  isLoaded: boolean;
};

const IDLE_STATE: ProgressiveImageFetch = {
  src: undefined,
  hasStarted: false,
  progress: null,
  etaSeconds: null,
  isLoaded: false,
};

// How often (minimum) to recompute the rate/ETA from freshly-read chunks.
// Frequent enough to feel live, coarse enough that the EMA below isn't
// dominated by single-chunk jitter.
const SAMPLE_INTERVAL_MS = 150;
// Exponential-moving-average weight for each new instantaneous-rate sample.
const RATE_EMA_WEIGHT = 0.3;

/**
 * Streams `url` via fetch (rather than handing it straight to an <img src>)
 * so real download progress and an ETA are observable — an <img> tag gives
 * no signal beyond "still loading" vs "loaded". Assembles the full response
 * into a Blob and returns an object URL once complete; the caller renders
 * that as a normal <img src>, so decode still happens the usual way (and
 * `onLoad` still fires) once it's assigned.
 *
 * Falls back to handing the browser the raw `url` (no progress, but still
 * displays) if streaming fails for any reason — this must never be a
 * regression from a plain <img src={url}>.
 */
export function useProgressiveImageFetch(url: string | undefined): ProgressiveImageFetch {
  const [state, setState] = useState<ProgressiveImageFetch>(IDLE_STATE);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    setState(IDLE_STATE);
    if (!url) return;

    let cancelled = false;
    const controller = new AbortController();

    const run = async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (cancelled) return;
        if (!res.ok || !res.body) throw new Error(`Image fetch failed: ${res.status}`);

        setState((s) => ({ ...s, hasStarted: true }));

        const totalHeader = res.headers.get("Content-Length");
        const total = totalHeader ? Number.parseInt(totalHeader, 10) : null;
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        let rate: number | null = null;
        let lastSampleAt = performance.now();
        let lastSampleLoaded = 0;

        for (;;) {
          const { done, value } = await reader.read();
          if (cancelled) {
            controller.abort();
            return;
          }
          if (done) break;
          chunks.push(value);
          loaded += value.byteLength;

          const now = performance.now();
          const elapsedMs = now - lastSampleAt;
          if (elapsedMs >= SAMPLE_INTERVAL_MS) {
            const instantRate = ((loaded - lastSampleLoaded) / elapsedMs) * 1000;
            rate = rate === null ? instantRate : rate * (1 - RATE_EMA_WEIGHT) + instantRate * RATE_EMA_WEIGHT;
            lastSampleAt = now;
            lastSampleLoaded = loaded;

            const progress = total && total > 0 ? Math.min(1, loaded / total) : null;
            const remainingBytes = total !== null ? Math.max(0, total - loaded) : null;
            const etaSeconds =
              remainingBytes !== null && rate && rate > 0 ? remainingBytes / rate : null;
            setState((s) => ({ ...s, progress, etaSeconds }));
          }
        }

        if (cancelled) return;
        const blob = new Blob(chunks as BlobPart[]);
        const objectUrl = URL.createObjectURL(blob);
        blobUrlRef.current = objectUrl;
        setState({ src: objectUrl, hasStarted: true, progress: 1, etaSeconds: 0, isLoaded: true });
      } catch {
        if (cancelled || controller.signal.aborted) return;
        // Streaming didn't work out (older browser, a proxy that strips
        // Content-Length, a network hiccup mid-stream) — fall back to a plain
        // load with no progress signal rather than showing nothing at all.
        setState({ src: url, hasStarted: true, progress: null, etaSeconds: null, isLoaded: true });
      }
    };

    run();

    return () => {
      cancelled = true;
      controller.abort();
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [url]);

  return state;
}

/** Human-readable "62% · 4s left" style label for the loading pill. */
export function formatProgressLabel(p: ProgressiveImageFetch): string {
  if (!p.hasStarted) return "Loading…";
  if (p.progress === null) return "Loading…";
  const pct = Math.round(p.progress * 100);
  if (p.etaSeconds === null || p.etaSeconds < 1 || p.progress >= 1) return `${pct}%`;
  const secs = Math.round(p.etaSeconds);
  const timeLabel = secs < 60 ? `${secs}s left` : `${Math.round(secs / 60)}m left`;
  return `${pct}% · ${timeLabel}`;
}
