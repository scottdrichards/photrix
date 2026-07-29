import { useEffect, useRef, useState } from "react";

/**
 * True on devices whose primary pointer can't hover (phones, tablets). Hover is
 * the whole trigger for tile previews on desktop, so touch needs a substitute —
 * see useViewportCentered.
 */
export const useCoarsePointer = (): boolean => {
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(hover: none) and (pointer: coarse)");
    } catch {
      return;
    }
    setCoarse(query.matches);
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  return coarse;
};

// Only the middle band of the viewport counts as "being looked at". The negative
// margins crop the observer root down to a horizontal strip through the centre,
// so a tile has to actually be the focus of the screen — not merely on it.
const CENTRE_BAND_MARGIN = "-40% 0px -40% 0px";

type CentredCallback = (centred: boolean) => void;

let centreObserver: IntersectionObserver | null = null;
let centreObserverClass: typeof IntersectionObserver | null = null;
const centreCallbacks = new Map<Element, CentredCallback>();

// One observer for the whole grid, mirroring useNearViewport — thousands of
// tiles must not mean thousands of observers.
const getCentreObserver = (): IntersectionObserver | null => {
  const IO = globalThis.IntersectionObserver as typeof IntersectionObserver | undefined;
  if (!IO) return null;
  if (centreObserver && centreObserverClass === IO) return centreObserver;

  centreObserver?.disconnect();
  centreCallbacks.clear();
  centreObserver = new IO(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        centreCallbacks.get(target)?.(isIntersecting);
      }
    },
    { rootMargin: CENTRE_BAND_MARGIN },
  );
  centreObserverClass = IO;
  return centreObserver;
};

/**
 * True once the element has sat in the centre band of the viewport for
 * `delayMs` without leaving it, and false the instant it leaves.
 *
 * The dwell timer doubles as scroll detection: a tile can't stay centred for
 * most of a second while the grid is moving, so no scroll listener is needed and
 * a fast flick never starts anything.
 */
export const useViewportCentred = (
  ref: React.RefObject<Element | null>,
  { delayMs, enabled }: { delayMs: number; enabled: boolean },
): boolean => {
  const [dwelt, setDwelt] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setDwelt(false);
      return;
    }
    const el = ref.current;
    const observer = getCentreObserver();
    if (!el || !observer) return;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    centreCallbacks.set(el, (centred) => {
      clearTimer();
      if (!centred) {
        setDwelt(false);
        return;
      }
      timerRef.current = setTimeout(() => setDwelt(true), delayMs);
    });
    observer.observe(el);

    return () => {
      clearTimer();
      observer.unobserve(el);
      centreCallbacks.delete(el);
      setDwelt(false);
    };
  }, [ref, delayMs, enabled]);

  return dwelt;
};

/**
 * Delays a boolean's rising edge, passing its falling edge through immediately.
 * Used so brushing the pointer across a row of tiles never starts a preview,
 * while leaving one always stops it at once.
 */
export const useDelayedFlag = (value: boolean, delayMs: number): boolean => {
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!value) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
};
