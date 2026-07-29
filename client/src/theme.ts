export type Theme = "light" | "dark";
export type ThemeOverride = Theme | null;

const THEME_KEY = "photrix_theme";

const isTheme = (value: string | null): value is Theme => value === "light" || value === "dark";

const readLocalStorage = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeLocalStorage = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures so theme selection never blocks rendering.
  }
};

const removeLocalStorage = (key: string): void => {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures so theme selection never blocks rendering.
  }
};

const getThemeMediaQuery = (): MediaQueryList | null => {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia("(prefers-color-scheme: dark)");
};

export const getStoredThemeOverride = (): ThemeOverride => {
  if (typeof window === "undefined") return null;

  const storedTheme = readLocalStorage(THEME_KEY);
  return isTheme(storedTheme) ? storedTheme : null;
};

export const getSystemTheme = (): Theme => {
  return getThemeMediaQuery()?.matches ? "dark" : "light";
};

export const getInitialTheme = (): Theme => {
  return getStoredThemeOverride() ?? getSystemTheme();
};

export const applyTheme = (theme: Theme): void => {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
};

export const persistThemeOverride = (themeOverride: ThemeOverride): void => {
  if (typeof window === "undefined") return;
  if (themeOverride === null) {
    removeLocalStorage(THEME_KEY);
    return;
  }
  writeLocalStorage(THEME_KEY, themeOverride);
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
