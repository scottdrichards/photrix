import { useEffect, useState } from "react";
import { buildFileUrl } from "../../api/photoItem";
import type { PhotoItem } from "../../api/types";

/**
 * Mirrors the server's VIDEO_SCRUB_FRAME_COUNT (videoProcessing/videoUtils.ts)
 * — kept as a plain constant rather than fetched, since changing one without
 * the other only means a slightly coarser/finer strip, not a broken feature.
 */
const SCRUB_FRAME_COUNT = 5;

/**
 * Feedback #76: cheap hover-scrub for video tiles. Maps the pointer's
 * horizontal position over the tile to one of a handful of server-cached
 * still frames (see videoUtils.ts's generateVideoScrubFrame) — not true
 * per-frame scrubbing (decoding the whole video on every hover was judged
 * not worth it on this host's weak CPU), but moving the pointer left-to-right
 * does step through the video's timeline in coarse increments.
 *
 * Deliberately a separate small hook from useTileVideoPreview: that one
 * plays the real (5s-only) ambient preview clip once the user dwells: this
 * one is driven by pointer position, covers the *whole* duration, and only
 * needs to attach a listener while active.
 */
export const useTileScrubPreview = ({
  photo,
  active,
  tileElement,
}: {
  photo: PhotoItem;
  /** Caller decides: video tile, hovered (not touch-dwell), close enough to load. */
  active: boolean;
  tileElement: HTMLElement | null;
}): { scrubUrl: string | null } => {
  const [frameIndex, setFrameIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!active || !tileElement) {
      setFrameIndex(null);
      return;
    }

    const handleMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const rect = tileElement.getBoundingClientRect();
      if (rect.width <= 0) return;
      const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const next = Math.min(
        SCRUB_FRAME_COUNT - 1,
        Math.floor(fraction * SCRUB_FRAME_COUNT),
      );
      setFrameIndex((prev) => (prev === next ? prev : next));
    };

    tileElement.addEventListener("pointermove", handleMove);
    return () => {
      tileElement.removeEventListener("pointermove", handleMove);
      setFrameIndex(null);
    };
  }, [active, tileElement]);

  if (frameIndex === null) return { scrubUrl: null };

  return {
    scrubUrl: buildFileUrl(photo.path, {
      representation: "scrub",
      index: String(frameIndex),
    }),
  };
};
