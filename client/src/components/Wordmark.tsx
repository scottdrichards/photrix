import { useEffect, useRef, useState } from "react";
import markUrl from "./logo-mark.svg";
import css from "./Wordmark.module.css";

/** How long the wordmark sits still after it appears before the first play. */
export const WORDMARK_INTRO_DELAY_MS = 2000;

/** One play: the focus hunt, then the colour sweep (1.7 s delay + 1.6 s in
    Wordmark.module.css). A replay asked for before this has passed is ignored. */
export const WORDMARK_PLAY_MS = 3300;

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The "Photrix" wordmark: the logo mark stands in for the P, followed by
 * "hotrix". Assistive technology reads the plain word instead.
 *
 * A couple of seconds after it appears, "hotrix" hunts for focus like a lens
 * — blurred, past sharp and back, a little less each time — and then a sweep
 * of the logo's colours crosses it. Hovering or clicking plays it again; a
 * play already under way is left to finish rather than restarted.
 */
export const Wordmark = () => {
  const ref = useRef<HTMLSpanElement>(null);
  const playing = useRef(false);
  const [run, setRun] = useState(0);

  // Listeners rather than onClick/onMouseEnter: the replay is decoration, not
  // a control, so it gets no role or key handling. In the header the wordmark
  // sits inside the home link, which stays the real action.
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    // A timer, not animationend, marks the end of a play: the event is not
    // guaranteed (a hidden tab may never deliver it), and a missed one would
    // leave the wordmark unable to replay.
    let done: number | undefined;
    const play = () => {
      if (playing.current) return;
      playing.current = true;
      setRun((n) => n + 1);
      done = window.setTimeout(() => {
        playing.current = false;
      }, WORDMARK_PLAY_MS);
    };
    const intro = window.setTimeout(play, WORDMARK_INTRO_DELAY_MS);
    el.addEventListener("mouseenter", play);
    el.addEventListener("click", play);
    return () => {
      window.clearTimeout(intro);
      window.clearTimeout(done);
      el.removeEventListener("mouseenter", play);
      el.removeEventListener("click", play);
    };
  }, []);

  return (
    <span ref={ref} className={css.wordmark}>
      <span className={css.srOnly}>Photrix</span>
      <span aria-hidden="true">
        <img className={css.mark} src={markUrl} alt="" />
        {/* A new key remounts the letters, which restarts their animations. */}
        <span
          key={run}
          className={run > 0 ? `${css.rest} ${css.play}` : css.rest}
          data-part="rest"
          data-playing={run > 0 ? "" : undefined}
        >
          <span className={css.focus}>hotrix</span>
          <span className={css.sheen}>hotrix</span>
        </span>
      </span>
    </span>
  );
};
