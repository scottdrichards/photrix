import { useEffect, useRef, useState } from "react";
import type { PhotoItem } from "../../api";
import { negotiateVideoPlayback } from "../../api";
import { probeVideoPlaybackProfile } from "../../videoPlaybackProfile";
import { attachTileVideo, type TileVideoHandle } from "./attachTileVideo";
import {
  acquirePlaybackSlot,
  isAmbientPlaybackAllowed,
  isPlaybackAllowed,
} from "./tilePlaybackCoordinator";

type Options = {
  photo: PhotoItem;
  /** Whether this tile currently wants to be playing. */
  active: boolean;
  /**
   * True when the user asked for it (hover). False for the touch dwell, which is
   * unattended and therefore additionally respects reduced-motion / Save-Data.
   */
  deliberate: boolean;
};

// How long a preview coasts to a stop after the hover ends on its own terms,
// before the tile fades back to the static thumbnail (see .motionLayer's
// transition in ThumbnailTile.module.css, which drives that fade). Purely
// cosmetic — see the teardown-vs-windDown split below.
const LEAVE_SLOWDOWN_MS = 1000;
// Must match .motionLayer's `transition: opacity …` duration: the element is
// only really released once it has finished fading out, so an earlier detach
// never flashes a blank frame mid-fade.
const LEAVE_FADE_MS = 420;

/**
 * Hover/dwell preview playback for a single video tile.
 *
 * Every way a preview can end funnels into one of two paths, both of which
 * abort the in-flight negotiation and give the playback slot back immediately
 * — nothing ever leaves a stray transcode session running on the GPU the
 * server shares with its ML workers:
 *
 *   - hardStop(): instant, total. Used when another tile takes the single
 *     video slot, the tab is hidden or the page is unloading (coordinator
 *     calls it), negotiation failed/aborted, or the player hit a fatal error.
 *   - the effect's own cleanup, when the tile stops wanting to play on its own
 *     terms (pointer left, scrolled out of the close band, grid re-rendered it
 *     for a different photo) or the component unmounts: cuts new network
 *     activity immediately (windDown's first move) but lets the element coast
 *     to a stop on already-buffered frames and fade out cosmetically before
 *     finally detaching — see LEAVE_SLOWDOWN_MS / LEAVE_FADE_MS.
 */
export const useTileVideoPreview = ({ photo, active, deliberate }: Options) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // True while a preview that ended naturally is coasting to a stop and/or
  // fading out, but hasn't yet released its element. Distinct from isPlaying
  // so the tile knows to keep rendering (and showing) the <video> through the
  // whole tail instead of snapping back to the thumbnail immediately.
  const [isLeaving, setIsLeaving] = useState(false);
  // A windDown in progress, kept outside the effect closure so the *next*
  // hover cycle (a quick re-hover) can interrupt it instead of fighting it for
  // the same <video> element.
  const leavingHandleRef = useRef<TileVideoHandle | null>(null);

  const isVideo = photo.mediaType === "video";
  const path = photo.path;

  useEffect(() => {
    if (!isVideo || !active) return;
    if (!isPlaybackAllowed()) return;
    if (!deliberate && !isAmbientPlaybackAllowed()) return;

    // A fresh hover pre-empts whatever the previous one was coasting down.
    if (leavingHandleRef.current) {
      leavingHandleRef.current.detach();
      leavingHandleRef.current = null;
      setIsLeaving(false);
    }

    let torndown = false;
    let handle: TileVideoHandle | null = null;
    let release: (() => void) | null = null;
    const abortController = new AbortController();

    // Instant, total stop — no visual tail. Used when something more important
    // takes the slot, the tab is hidden, or the page unloads: none of those
    // can wait out a coast-to-a-stop.
    const hardStop = () => {
      if (torndown) return;
      torndown = true;
      // Order matters: kill the pending negotiation before the player, so a late
      // response can never re-attach onto an element we just cleared.
      abortController.abort();
      handle?.detach();
      handle = null;
      release?.();
      release = null;
      setIsPlaying(false);
      setIsLeaving(false);
    };

    // Reserved before any await so a second hover immediately evicts this tile
    // rather than both of them racing to open a stream.
    release = acquirePlaybackSlot("video", hardStop);
    if (!release) return;

    void (async () => {
      try {
        // One-time per session, and bounded to a couple of seconds. Measuring is
        // what lets the server refuse to read a 50 Mbps original over a phone
        // link, so it is worth paying once on the first video the user dwells on.
        const profile = await probeVideoPlaybackProfile();
        if (torndown) return;

        const negotiation = await negotiateVideoPlayback({
          path,
          bandwidthMbps: profile.bandwidthMbps,
          hevcSupported: profile.hevcSupported,
          preview: true,
          signal: abortController.signal,
        });
        if (torndown) return;

        // "error" here is the server declining to spend GPU on a throwaway
        // preview. That is a normal answer — the tile just keeps its thumbnail.
        if (negotiation.mode === "error") {
          hardStop();
          return;
        }

        const element = videoRef.current;
        if (!element) {
          hardStop();
          return;
        }

        handle = attachTileVideo(element, {
          mode: negotiation.mode,
          url: negotiation.url,
          previewMaxSeconds: negotiation.previewMaxSeconds,
        });
        setIsPlaying(true);
      } catch {
        hardStop();
      }
    })();

    // The hover ended on its own terms (pointer left, dwell lapsed): let the
    // preview visually coast to a stop instead of cutting it off mid-frame.
    // The network side still stops immediately either way (windDown's first
    // move) — only the already-buffered pixels linger.
    return () => {
      if (torndown) return;
      torndown = true;
      abortController.abort();
      release?.();
      release = null;

      if (!handle) {
        setIsPlaying(false);
        return;
      }

      const h = handle;
      handle = null;
      setIsPlaying(false);
      setIsLeaving(true);
      leavingHandleRef.current = h;
      h.windDown(LEAVE_SLOWDOWN_MS, () => {
        // Flip the visibility class now — its own CSS transition does the fade
        // — and only actually free the element once that fade has had time to
        // finish, so it never blanks out mid-fade.
        setIsLeaving(false);
        setTimeout(() => {
          if (leavingHandleRef.current === h) leavingHandleRef.current = null;
          h.detach();
        }, LEAVE_FADE_MS);
      });
    };
  }, [isVideo, active, deliberate, path]);

  // True-unmount safety net: don't leave a coasting preview's rAF loop ticking
  // against an element React has already torn out of the DOM.
  useEffect(
    () => () => {
      leavingHandleRef.current?.detach();
      leavingHandleRef.current = null;
    },
    [],
  );

  return { videoRef, isPlaying, isLeaving };
};
