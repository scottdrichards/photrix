import { useEffect, useRef, useState } from "react";

type Callback = (inBand: boolean) => void;

/**
 * Two activation bands, both measured outward from the viewport edge:
 *
 *  - PREFETCH — "start getting this tile ready". Wide, because a thumbnail only
 *    requested once the tile is on screen is always late: over a WAN link a
 *    round trip is 100-300ms, and at a normal wheel-scroll speed the old 300px
 *    band bought under 200ms of warning. Tiles in this band paint their cheap
 *    embedded micro thumbnail.
 *  - CLOSE — "the user is about to actually look at this". Narrow, and the only
 *    band allowed to trigger the expensive full 320 thumbnail, so a fast fling
 *    past a thousand tiles costs micro thumbnails and nothing else.
 *
 * Both derive from the viewport height so a phone doesn't prefetch a
 * desktop-sized band (and a tall window doesn't under-prefetch), clamped so an
 * odd viewport can't produce a degenerate margin.
 */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const viewportHeight = (): number =>
  typeof window === "undefined" || !window.innerHeight ? 800 : window.innerHeight;

type Band = "prefetch" | "close";

const marginForBand: Record<Band, () => string> = {
  prefetch: () => `${Math.round(clamp(viewportHeight() * 1.25, 700, 2000))}px 0px`,
  close: () => `${Math.round(clamp(viewportHeight() * 0.4, 250, 700))}px 0px`,
};

type BandObserver = {
  observer: IntersectionObserver;
  callbacks: Map<Element, Callback>;
};

// One observer per band, shared across every mounted tile — thousands of tiles
// must not mean thousands of observers. Keyed on the current
// IntersectionObserver constructor so test environments that swap it in
// beforeAll transparently get fresh observers pointing at the new class.
const bandObservers = new Map<Band, BandObserver>();
let observerClass: typeof IntersectionObserver | null = null;

const getBandObserver = (band: Band): BandObserver | null => {
  const IO = globalThis.IntersectionObserver as typeof IntersectionObserver | undefined;
  if (!IO) return null;

  if (observerClass !== IO) {
    // Constructor changed (e.g. a test replaced it) — tear everything down.
    for (const entry of bandObservers.values()) entry.observer.disconnect();
    bandObservers.clear();
    observerClass = IO;
  }

  const existing = bandObservers.get(band);
  if (existing) return existing;

  const callbacks = new Map<Element, Callback>();
  const observer = new IO(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        callbacks.get(target)?.(isIntersecting);
      }
    },
    { rootMargin: marginForBand[band]() },
  );
  const created = { observer, callbacks };
  bandObservers.set(band, created);
  return created;
};

const useBand = (band: Band, ref: React.RefObject<Element | null>): boolean => {
  const [inBand, setInBand] = useState(typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const el = ref.current;
    const entry = getBandObserver(band);
    if (!el || !entry) return;
    entry.callbacks.set(el, setInBand);
    entry.observer.observe(el);
    return () => {
      entry.observer.unobserve(el);
      entry.callbacks.delete(el);
    };
  }, [band, ref]);

  return inBand;
};

/**
 * Viewport proximity for a grid tile.
 *
 * `isNear` is the wide prefetch band and `isClose` the narrow one; `isClose`
 * always implies `isNear`. Callers use the first to decide what to start
 * loading in the background and the second to decide what earns full quality.
 */
export const useNearViewport = <T extends Element>(): [
  isNear: boolean,
  ref: React.RefObject<T | null>,
  isClose: boolean,
] => {
  const ref = useRef<T | null>(null);
  const isNear = useBand("prefetch", ref);
  const isClose = useBand("close", ref);

  return [isNear || isClose, ref, isClose];
};
