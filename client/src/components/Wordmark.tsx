import { useEffect, useRef, useState } from "react";
import markUrl from "./logo-mark.svg";
import css from "./Wordmark.module.css";

/**
 * The "Photrix" wordmark: the logo mark stands in for the P, followed by
 * "hotrix". Assistive technology reads the plain word instead.
 *
 * "hotrix" comes in like a lens hunting for focus — blurred, past sharp and
 * back, a little less each time — and then a sweep of the logo's colours
 * crosses it. Clicking the wordmark plays it again.
 */
export const Wordmark = () => {
  const ref = useRef<HTMLSpanElement>(null);
  const [run, setRun] = useState(0);

  // A listener rather than onClick: the replay is decoration, not a control,
  // so it gets no role or key handling. In the header the wordmark sits inside
  // the home link, which stays the real action.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const replay = () => setRun((n) => n + 1);
    el.addEventListener("click", replay);
    return () => el.removeEventListener("click", replay);
  }, []);

  return (
    <span ref={ref} className={css.wordmark}>
      <span className={css.srOnly}>Photrix</span>
      <span aria-hidden="true">
        <img className={css.mark} src={markUrl} alt="" />
        {/* A new key remounts the letters, which restarts their animations. */}
        <span key={run} className={css.rest} data-part="rest">
          <span className={css.focus}>hotrix</span>
          <span className={css.sheen}>hotrix</span>
        </span>
      </span>
    </span>
  );
};
