import { useEffect, useRef, useState } from "react";
import markUrl from "./logo-mark.svg";
import css from "./Wordmark.module.css";

/**
 * One play, from start to the end of the colour sweep (2.81 s delay + 1.6 s
 * in Wordmark.module.css). A replay asked for before this has passed is
 * ignored, so the pointer drifting across the word does not keep restarting it.
 */
export const WORDMARK_PLAY_MS = 4410;

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Play = "intro" | "replay" | "still";

/**
 * The "Photrix" wordmark: the logo mark stands in for the P, followed by
 * "hotrix". Assistive technology reads the plain word instead.
 *
 * It arrives out of focus, like a lens hunting: focus creeps up, passes the
 * word, lands on a cloud backdrop behind it, then backs up onto the word. A
 * sweep of the logo's colours follows. Hovering or clicking plays it again.
 * The timing lives in Wordmark.module.css.
 */
export const Wordmark = () => {
  const ref = useRef<HTMLSpanElement>(null);
  const [initial] = useState<Play>(() => (prefersReducedMotion() ? "still" : "intro"));
  const [play, setPlay] = useState<{ kind: Play; run: number }>({
    kind: initial,
    run: 0,
  });
  const playing = useRef(initial === "intro");

  // Listeners rather than onClick/onMouseEnter: the replay is decoration, not
  // a control, so it gets no role or key handling. In the header the wordmark
  // sits inside the home link, which stays the real action.
  //
  // A timer, not animationend, marks the end of a play: the event is not
  // guaranteed (a hidden tab may never deliver it), and a missed one would
  // leave the wordmark unable to replay.
  useEffect(() => {
    const el = ref.current;
    if (!el || initial === "still") return;
    let done = window.setTimeout(() => {
      playing.current = false;
    }, WORDMARK_PLAY_MS);
    const replay = () => {
      if (playing.current) return;
      playing.current = true;
      setPlay((p) => ({ kind: "replay", run: p.run + 1 }));
      done = window.setTimeout(() => {
        playing.current = false;
      }, WORDMARK_PLAY_MS);
    };
    el.addEventListener("mouseenter", replay);
    el.addEventListener("click", replay);
    return () => {
      window.clearTimeout(done);
      el.removeEventListener("mouseenter", replay);
      el.removeEventListener("click", replay);
    };
  }, [initial]);

  const sceneClass =
    play.kind === "intro"
      ? `${css.scene} ${css.intro}`
      : play.kind === "replay"
        ? `${css.scene} ${css.replay}`
        : css.scene;

  return (
    <span ref={ref} className={css.wordmark}>
      <span className={css.srOnly}>Photrix</span>
      <span aria-hidden="true">
        {/* A new key remounts the scene, which restarts its animations. */}
        <span
          key={play.run}
          className={sceneClass}
          data-part="scene"
          data-play={play.kind}
        >
          <span className={css.backdrop} />
          <span className={css.focus}>
            <img className={css.mark} src={markUrl} alt="" />
            <span className={css.letters}>
              hotrix
              <span className={css.sheen}>hotrix</span>
            </span>
          </span>
        </span>
      </span>
    </span>
  );
};
