import type { Theme } from "../../theme";
import css from "./ThemeToggle.module.css";

type ThemeToggleProps = {
  theme: Theme;
  followsSystem: boolean;
  onToggle: () => void;
  /** Extra class for the button, e.g. to shrink it inside the header. */
  className?: string;
};

export const ThemeToggle = ({ theme, followsSystem, onToggle, className }: ThemeToggleProps) => {
  const title = followsSystem
    ? `Following system theme: ${theme}`
    : `Theme override: ${theme}`;

  return (
    <button
      type="button"
      role="switch"
      aria-label="Theme"
      aria-checked={theme === "dark"}
      title={title}
      className={className ? `${css.themeToggle} ${className}` : css.themeToggle}
      data-theme-toggle
      data-theme={theme}
      data-following-system={followsSystem}
      onClick={onToggle}
    >
      <span className={css.themeToggleTrack} aria-hidden="true">
        <span className={css.themeToggleGlow} />
        <span className={css.themeToggleStars} />
        <span className={css.themeToggleSun} />
        <span className={css.themeToggleMoon} />
        <span className={css.themeToggleThumb} />
        {followsSystem && <span className={css.themeToggleModeDot} />}
      </span>
    </button>
  );
};
