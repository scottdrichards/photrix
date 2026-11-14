import markUrl from "./logo-mark.svg";
import css from "./Wordmark.module.css";

/**
 * The "Photrix" wordmark: the logo mark stands in for the P, followed by
 * "hotrix". Assistive technology reads the plain word instead.
 */
export const Wordmark = () => (
  <span className={css.wordmark}>
    <span className={css.srOnly}>Photrix</span>
    <span aria-hidden="true">
      <img className={css.mark} src={markUrl} alt="" />
      hotrix
    </span>
  </span>
);
