import { useEffect, useLayoutEffect, useRef, useState } from "react";
import markUrl from "./logo-mark.svg";
import css from "./Wordmark.module.css";
import {
  focusKeyframes,
  focusMs,
  playMs,
  SHEEN_EASING,
  SHEEN_MS,
  type FocusPlay,
} from "./wordmarkFocus";

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Play = FocusPlay | "still";

const SHEEN_FRAMES: Keyframe[] = [
  { backgroundPosition: "100% 0" },
  { backgroundPosition: "0 0" },
];

/**
 * The "Photrix" wordmark: the logo mark stands in for the P, followed by
 * "hotrix". Assistive technology reads the plain word instead.
 *
 * It arrives out of focus and a lens pulls focus onto it, as a camera 20 m
 * away would, with clouds far behind that never come sharp. A sweep of the
 * logo's colours follows. Hovering or clicking plays it again. The optics and
 * timing live in wordmarkFocus.ts.
 */
export const Wordmark = () => {
  const ref = useRef<HTMLSpanElement>(null);
  const focusRef = useRef<HTMLSpanElement>(null);
  const cloudsRef = useRef<HTMLSpanElement>(null);
  const sheenRef = useRef<HTMLSpanElement>(null);
  const [initial] = useState<Play>(() => (prefersReducedMotion() ? "still" : "intro"));
  const [play, setPlay] = useState<{ kind: Play; run: number }>({
    kind: initial,
    run: 0,
  });
  const playing = useRef(initial !== "still");

  // A layout effect, so the intro's first, blurred frame is applied before the
  // first paint rather than flashing the sharp word first.
  useLayoutEffect(() => {
    if (play.kind === "still") return;
    const [focus, clouds, sheen] = [
      focusRef.current,
      cloudsRef.current,
      sheenRef.current,
    ];
    if (!focus || !clouds || !sheen || typeof focus.animate !== "function") return;
    const frames = focusKeyframes(play.kind);
    const timing: KeyframeAnimationOptions = {
      duration: frames.durationMs,
      fill: "both",
    };
    const animations = [
      focus.animate(frames.word, timing),
      clouds.animate(frames.clouds, timing),
      sheen.animate(SHEEN_FRAMES, {
        duration: SHEEN_MS,
        delay: focusMs(play.kind),
        easing: SHEEN_EASING,
        fill: "both",
      }),
    ];
    return () => animations.forEach((a) => a.cancel());
  }, [play]);

  // Listeners rather than onClick/onMouseEnter: the replay is decoration, not
  // a control, so it gets no role or key handling. In the header the wordmark
  // sits inside the home link, which stays the real action.
  //
  // A replay asked for mid-play is ignored, so the pointer drifting across the
  // word does not keep restarting it. A timer, not animationend, marks the end:
  // the event is not guaranteed (a hidden tab may never deliver it), and a
  // missed one would leave the wordmark unable to replay.
  useEffect(() => {
    const el = ref.current;
    if (!el || initial === "still") return;
    let done = window.setTimeout(() => {
      playing.current = false;
    }, playMs("intro"));
    const replay = () => {
      if (playing.current) return;
      playing.current = true;
      setPlay((p) => ({ kind: "replay", run: p.run + 1 }));
      done = window.setTimeout(() => {
        playing.current = false;
      }, playMs("replay"));
    };
    el.addEventListener("mouseenter", replay);
    el.addEventListener("click", replay);
    return () => {
      window.clearTimeout(done);
      el.removeEventListener("mouseenter", replay);
      el.removeEventListener("click", replay);
    };
  }, [initial]);

  return (
    <span ref={ref} className={css.wordmark}>
      <span className={css.srOnly}>Photrix</span>
      <span aria-hidden="true">
        <span
          className={css.scene}
          data-part="scene"
          data-play={play.kind}
          data-run={play.run}
        >
          <span ref={cloudsRef} className={css.backdrop} />
          <span ref={focusRef} className={css.focus}>
            <img className={css.mark} src={markUrl} alt="" />
            <span className={css.letters}>
              hotrix
              <span ref={sheenRef} className={css.sheen}>
                hotrix
              </span>
            </span>
          </span>
        </span>
      </span>
    </span>
  );
};
