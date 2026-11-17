import { logFailure } from "./logFailure";

/**
 * Feedback #195: what the app tells the window around it. An installed app's
 * title bar and icon are the one piece of "native" UI a web page can still
 * drive, so the page's state is mirrored there.
 *
 * Desktop Chromium follows `theme-color` live (the title bar of an installed
 * app, the toolbar of a tab); an installed Android app's bottom bar does not
 * (see docs: the bar takes the manifest colour at install). Everything here is
 * therefore decoration: when a browser ignores it nothing is lost.
 */

/** The viewer's backdrop (see FullscreenViewer.module.css). */
export const VIEWER_THEME_COLOR = "#000000";

/** What `applyTheme` in theme.ts puts on the page; keep in step with it. */
const PAGE_THEME_COLORS = { light: "#f7f7f7", dark: "#11161d" } as const;

const themeColorMetas = (): HTMLMetaElement[] =>
  Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));

/** While a photo is open the title bar goes black like the viewer; closing restores the page colour. */
export const setViewerThemeColor = (viewerOpen: boolean): void => {
  if (typeof document === "undefined") return;
  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const color = viewerOpen ? VIEWER_THEME_COLOR : PAGE_THEME_COLORS[theme];
  themeColorMetas().forEach((meta) => meta.setAttribute("content", color));
};

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** The installed app's icon shows how many photos are selected. No-op where unsupported. */
export const setSelectionBadge = (count: number): void => {
  if (typeof navigator === "undefined") return;
  const nav = navigator as BadgeNavigator;
  const run = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
  // A rejected badge call (not installed, permission) is cosmetic.
  void run?.catch(logFailure("appBadge.failed", "Could not set the app badge"));
};

/** The idle window title: the library's size, so the title bar answers "how many". */
export const libraryTitle = (resultCount: number | null): string =>
  resultCount == null
    ? "Photrix"
    : `Photrix – ${resultCount.toLocaleString("en-US")} ${resultCount === 1 ? "photo" : "photos"}`;
