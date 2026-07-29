import { useEffect, useRef, useState } from "react";

type Callback = (isNear: boolean) => void;

// Singleton observer shared across all mounted tiles. Keyed on the current
// IntersectionObserver constructor so test environments that swap it in beforeAll
// transparently get a fresh observer pointing at the new class.
let sharedObserver: IntersectionObserver | null = null;
let sharedObserverClass: typeof IntersectionObserver | null = null;
const callbacks = new Map<Element, Callback>();

const getSharedObserver = (): IntersectionObserver | null => {
  const IO = globalThis.IntersectionObserver as typeof IntersectionObserver | undefined;
  if (!IO) return null;

  if (sharedObserver && sharedObserverClass === IO) {
    return sharedObserver;
  }

  // Constructor changed (e.g. test replaced it) — tear down and recreate.
  sharedObserver?.disconnect();
  callbacks.clear();
  sharedObserver = new IO(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        callbacks.get(target)?.(isIntersecting);
      }
    },
    { rootMargin: "300px" },
  );
  sharedObserverClass = IO;
  return sharedObserver;
};

export const useNearViewport = <T extends Element>(): [
  isNear: boolean,
  ref: React.RefObject<T | null>,
] => {
  const [isNear, setIsNear] = useState(typeof IntersectionObserver === "undefined");
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    const obs = getSharedObserver();
    if (!el || !obs) return;
    callbacks.set(el, setIsNear);
    obs.observe(el);
    return () => {
      obs.unobserve(el);
      callbacks.delete(el);
    };
  }, []);

  return [isNear, ref];
};
