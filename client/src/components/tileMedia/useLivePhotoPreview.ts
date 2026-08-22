import { useCallback, useEffect, useRef, useState } from "react";
import {
  acquirePlaybackSlot,
  isAmbientPlaybackAllowed,
  registerAmbientCandidate,
  suppressAmbientPlayback,
} from "./tilePlaybackCoordinator";

/** How long an unattended live photo is allowed to run before fading back out. */
const AMBIENT_MAX_MS = 3200;
/** Must match the CSS opacity transition so the element outlives its fade-out. */
const FADE_MS = 420;

type Options = {
  livePhotoUrl: string | undefined;
  /** The tile is close enough to the viewport to be worth animating. */
  isNear: boolean;
  /** The user is pointing at the live badge and wants to see the clip now. */
  hovered: boolean;
};

export type LivePhotoPreview = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Render the clip element (kept mounted through its fade-out). */
  isMounted: boolean;
  /** Drive the opacity — false during the fade in/out. */
  isVisible: boolean;
  /** Hand back to the element so a clip that finishes early releases its slot. */
  handleEnded: () => void;
};

/**
 * Plays a photo's paired live-photo motion clip, either because the user is
 * hovering the badge or because the idle rotation picked this tile.
 *
 * Live clips are small paired files served straight from disk, so unlike video
 * previews they cost no GPU — but they are still motion and still bytes, so they
 * go through the same coordinator: at most two at a time, none while the tab is
 * hidden, and none at all under prefers-reduced-motion or Save-Data.
 */
export const useLivePhotoPreview = ({
  livePhotoUrl,
  isNear,
  hovered,
}: Options): LivePhotoPreview => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [mode, setMode] = useState<"hover" | "ambient" | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const releaseRef = useRef<(() => void) | null>(null);
  // Only held while playing because the user deliberately hovered (not for
  // the unattended idle rotation) — see suppressAmbientPlayback's contract.
  const deliberateReleaseRef = useRef<(() => void) | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (autoStopRef.current !== null) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
    if (unmountRef.current !== null) {
      clearTimeout(unmountRef.current);
      unmountRef.current = null;
    }
  };

  const stop = useCallback(() => {
    clearTimers();
    releaseRef.current?.();
    releaseRef.current = null;
    deliberateReleaseRef.current?.();
    deliberateReleaseRef.current = null;

    // Halt decoding immediately; the element lingers only long enough to fade.
    const element = videoRef.current;
    try {
      element?.pause();
    } catch {
      // Detached element — nothing to pause.
    }
    setMode(null);
    unmountRef.current = setTimeout(() => {
      unmountRef.current = null;
      const el = videoRef.current;
      try {
        el?.removeAttribute("src");
        el?.load();
      } catch {
        // Already gone.
      }
      setIsMounted(false);
    }, FADE_MS);
  }, []);

  const start = useCallback(
    (next: "hover" | "ambient") => {
      if (!livePhotoUrl) return;
      if (releaseRef.current) {
        // Already running. A hover over a clip the rotation started just takes
        // it over, so it doesn't vanish under the pointer.
        if (next === "hover") {
          clearTimers();
          setMode("hover");
          // The rotation started this one unattended, so it never claimed the
          // deliberate-preview slot. The hover takeover means it must now,
          // so any other ambient clip elsewhere stops too.
          if (!deliberateReleaseRef.current) {
            deliberateReleaseRef.current = suppressAmbientPlayback();
          }
        }
        return;
      }
      // A deliberate hover claims the "one thing being looked at" slot before
      // asking for its own playback slot below — see suppressAmbientPlayback,
      // which immediately stops any other ambient clip already running
      // elsewhere in the grid (not just blocks new ones).
      const deliberateRelease = next === "hover" ? suppressAmbientPlayback() : null;
      const release = acquirePlaybackSlot("ambient", stop, {
        // Deliberate hover may bump an idle clip; the rotation may not.
        preempt: next === "hover",
      });
      if (!release) {
        deliberateRelease?.();
        return;
      }
      // Cancel a pending fade-out unmount: without this, a clip started right
      // after another one ended would have its element torn out from under it.
      clearTimers();
      releaseRef.current = release;
      deliberateReleaseRef.current = deliberateRelease;
      setIsMounted(true);
      setMode(next);
      if (next === "ambient") {
        autoStopRef.current = setTimeout(stop, AMBIENT_MAX_MS);
      }
    },
    [livePhotoUrl, stop],
  );

  // Hover is authoritative: entering starts, leaving stops (even a clip the
  // rotation had started, which is the least surprising behaviour).
  useEffect(() => {
    if (hovered && livePhotoUrl && isNear) {
      start("hover");
    } else if (mode === "hover") {
      stop();
    }
  }, [hovered, livePhotoUrl, isNear, mode, start, stop]);

  // Offer this tile to the idle rotation while it is on screen and untouched.
  useEffect(() => {
    if (!livePhotoUrl || !isNear || hovered) return;
    if (!isAmbientPlaybackAllowed()) return;
    return registerAmbientCandidate(() => start("ambient"));
  }, [livePhotoUrl, isNear, hovered, start]);

  // Scrolling away, unmounting, or swapping the tile onto a new photo all stop
  // playback and give the slot back.
  useEffect(() => {
    if (isNear) return;
    if (releaseRef.current) stop();
  }, [isNear, stop]);

  useEffect(
    () => () => {
      clearTimers();
      releaseRef.current?.();
      releaseRef.current = null;
    },
    [],
  );

  const handleEnded = useCallback(() => {
    if (mode === "ambient") stop();
  }, [mode, stop]);

  return { videoRef, isMounted, isVisible: mode !== null, handleEnded };
};
