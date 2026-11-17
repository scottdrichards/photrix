/**
 * Feedback #195 follow-up: an installed desktop app that opted in through the
 * manifest's `display_override` has no title bar of its own. The page extends
 * under the window buttons and the header doubles as the title bar.
 *
 * This only mirrors the browser's state onto `<html data-wco>`, which the CSS
 * keys off, so nothing changes in a tab, on a phone, or in a browser without the
 * API. The geometry itself comes from the `env(titlebar-area-*)` variables.
 */

type WindowControlsOverlay = EventTarget & { visible: boolean };

const overlay = (): WindowControlsOverlay | null =>
  typeof navigator === "undefined"
    ? null
    : ((navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay })
        .windowControlsOverlay ?? null);

/** Keep `data-wco` in step with the overlay; returns the unsubscribe. */
export const initWindowControlsOverlay = (): (() => void) => {
  const wco = overlay();
  if (!wco || typeof document === "undefined") return () => {};
  const sync = () => {
    if (wco.visible) document.documentElement.dataset.wco = "";
    else delete document.documentElement.dataset.wco;
  };
  sync();
  wco.addEventListener("geometrychange", sync);
  return () => {
    wco.removeEventListener("geometrychange", sync);
    delete document.documentElement.dataset.wco;
  };
};
