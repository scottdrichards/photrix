import { readStorage, writeStorage, removeStorage } from "./storage";
export type Theme = "light" | "dark";
export type ThemeOverride = Theme | null;

const THEME_KEY = "photrix_theme";

const isTheme = (value: string | null): value is Theme => value === "light" || value === "dark";

const getThemeMediaQuery = (): MediaQueryList | null => {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia("(prefers-color-scheme: dark)");
};

export const getStoredThemeOverride = (): ThemeOverride => {
  if (typeof window === "undefined") return null;

  const storedTheme = readStorage(THEME_KEY);
  return isTheme(storedTheme) ? storedTheme : null;
};

export const getSystemTheme = (): Theme => {
  return getThemeMediaQuery()?.matches ? "dark" : "light";
};

export const getInitialTheme = (): Theme => {
  return getStoredThemeOverride() ?? getSystemTheme();
};

// Matches --bg-canvas-start in styles.css, so the browser/installed-app title
// bar blends into the page. index.html carries a light and a dark
// `theme-color` (by prefers-color-scheme) for first paint; once the app knows
// its theme, which may be a user override of the system one, both get it.
export const THEME_COLORS: Record<Theme, string> = { light: "#f7f7f7", dark: "#11161d" };

// An installed app's system bars take the manifest's background_color, read
// once at install; no manifest field can follow dark mode. So the page points
// at the manifest matching the theme it is showing, and the app is installed
// with that colour. Both manifests share an `id`, so they are one app.
export const MANIFEST_HREFS: Record<Theme, string> = {
  light: "/manifest.webmanifest",
  dark: "/manifest-dark.webmanifest",
};

export const applyTheme = (theme: Theme): void => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Controls with their own colour transitions (sort segments, the view
  // toggle) otherwise ease into the new theme 120-250ms after everything
  // else snaps (feedback #157). Suppress transitions (CSS in styles.css), let
  // the new colours resolve, then lift it: removing only the transition
  // property afterwards changes no animated value, so nothing re-animates.
  root.dataset.themeSwitching = "";
  root.dataset.theme = theme;
  void root.offsetHeight; // forces the style flush
  delete root.dataset.themeSwitching;
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((meta) => meta.setAttribute("content", THEME_COLORS[theme]));
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", MANIFEST_HREFS[theme]);
};

export const persistThemeOverride = (themeOverride: ThemeOverride): void => {
  if (typeof window === "undefined") return;
  if (themeOverride === null) {
    removeStorage(THEME_KEY);
    return;
  }
  writeStorage(THEME_KEY, themeOverride);
};

export const subscribeToSystemTheme = (onThemeChange: (theme: Theme) => void): (() => void) => {
  const mediaQuery = getThemeMediaQuery();
  if (!mediaQuery) return () => {};

  const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
    onThemeChange(event.matches ? "dark" : "light");
  };

  handleChange(mediaQuery);

  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }

  mediaQuery.addListener(handleChange);
  return () => mediaQuery.removeListener(handleChange);
};
