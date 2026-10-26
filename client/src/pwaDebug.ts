// TEMPORARY: a test harness for working out which colour an installed app's
// system bars follow on Android browsers. Remove this file, its call in
// main.tsx and client/public/pwa-debug/ once the question is answered.
//
// Open `/?pwa-debug=a` (or b, c, d) and install from the browser menu. Each
// variant points at its own manifest with its own `id`, so all four install
// side by side as "Photrix A" to "Photrix D". Each variant uses its own marker
// colour, so one look at the bar says which field drives it:
//
//   a  no manifest colours   (the production manifest)
//   b  background_color      magenta
//   c  theme_color           green
//   d  both baked dark
//
// The panel also cycles the page's `theme-color` and paints a strip at the
// bottom of the page, to test what the browser picks up while the app runs,
// without reinstalling anything.

import { applyTheme, getInitialTheme } from "./theme";

export const PWA_DEBUG_VARIANTS = ["a", "b", "c", "d"] as const;
export type PwaDebugVariant = (typeof PWA_DEBUG_VARIANTS)[number];

const PARAM = "pwa-debug";
// sessionStorage is per window, so each installed variant keeps its own value
// even after the app's own URL handling drops the query string.
const SESSION_KEY = "photrix_pwa_debug";

const THEME_COLOR_STEPS = ["app", "none", "#ff00ff", "#00c853", "#11161d", "#f7f7f7"] as const;
const STRIP_STEPS = ["off", "#ff00ff", "#00c853"] as const;

const isVariant = (value: string | null): value is PwaDebugVariant =>
  (PWA_DEBUG_VARIANTS as readonly string[]).includes(value ?? "");

const readSession = (): string | null => {
  try {
    return window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
};

const writeSession = (value: string | null): void => {
  try {
    if (value === null) window.sessionStorage.removeItem(SESSION_KEY);
    else window.sessionStorage.setItem(SESSION_KEY, value);
  } catch {
    // A debug aid must never break the app.
  }
};

/** The active variant: from the URL first, then this window's session. */
export const getPwaDebugVariant = (): PwaDebugVariant | null => {
  const fromUrl = new URLSearchParams(window.location.search).get(PARAM);
  if (isVariant(fromUrl)) {
    writeSession(fromUrl);
    return fromUrl;
  }
  const fromSession = readSession();
  return isVariant(fromSession) ? fromSession : null;
};

export const manifestHrefFor = (variant: PwaDebugVariant | null): string =>
  variant ? `/pwa-debug/manifest-${variant}.webmanifest` : "/manifest.webmanifest";

const setManifest = (variant: PwaDebugVariant | null): void => {
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", manifestHrefFor(variant));
};

const themeColorMetas = (): HTMLMetaElement[] =>
  Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));

// The original tags, kept so the "none" step can remove them and "app" can put
// them back.
let savedMetas: HTMLMetaElement[] = [];

const setThemeColor = (step: (typeof THEME_COLOR_STEPS)[number]): void => {
  if (savedMetas.length === 0) savedMetas = themeColorMetas();
  themeColorMetas().forEach((meta) => meta.remove());
  if (step === "none") return;
  savedMetas.forEach((meta) => document.head.appendChild(meta));
  if (step === "app") applyTheme(getInitialTheme());
  else savedMetas.forEach((meta) => meta.setAttribute("content", step));
};

const describeThemeColor = (): string => {
  const metas = themeColorMetas();
  if (metas.length === 0) return "none";
  return metas.map((meta) => meta.getAttribute("content")).join(" / ");
};

const button = (label: string, onClick: () => void): HTMLButtonElement => {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  el.style.cssText = "font:inherit;margin:2px;padding:4px 6px;";
  el.addEventListener("click", onClick);
  return el;
};

/** Start debug mode if this window has a variant. Returns whether it did. */
export const initPwaDebug = (): boolean => {
  const variant = getPwaDebugVariant();
  if (!variant) return false;
  setManifest(variant);

  let themeStep = 0;
  let stripStep = 0;

  const strip = document.createElement("div");
  strip.dataset.testid = "pwa-debug-strip";
  strip.style.cssText =
    "position:fixed;left:0;right:0;bottom:0;height:48px;z-index:2147483646;pointer-events:none;display:none;";

  const panel = document.createElement("div");
  panel.dataset.testid = "pwa-debug-panel";
  panel.style.cssText =
    "position:fixed;top:8px;right:8px;z-index:2147483647;max-width:260px;padding:6px;" +
    "font:12px/1.3 monospace;background:#000c;color:#fff;border-radius:6px;";
  const status = document.createElement("div");

  const render = () => {
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
    status.textContent =
      `PWA debug: variant ${variant.toUpperCase()} · ${standalone ? "installed" : "browser tab"}\n` +
      `manifest: ${manifestHrefFor(variant)}\n` +
      `theme-color: ${THEME_COLOR_STEPS[themeStep]} (${describeThemeColor()})\n` +
      `bottom strip: ${STRIP_STEPS[stripStep]}`;
  };
  status.style.whiteSpace = "pre-wrap";

  const variantLinks = document.createElement("div");
  variantLinks.append("install: ");
  PWA_DEBUG_VARIANTS.forEach((v) => {
    const a = document.createElement("a");
    a.href = `/?${PARAM}=${v}`;
    a.textContent = v.toUpperCase();
    a.style.cssText = `color:#fff;margin-right:8px;${v === variant ? "font-weight:bold;" : ""}`;
    variantLinks.append(a);
  });

  panel.append(
    status,
    button("theme-color ▸", () => {
      themeStep = (themeStep + 1) % THEME_COLOR_STEPS.length;
      setThemeColor(THEME_COLOR_STEPS[themeStep]);
      render();
    }),
    button("strip ▸", () => {
      stripStep = (stripStep + 1) % STRIP_STEPS.length;
      const colour = STRIP_STEPS[stripStep];
      strip.style.display = colour === "off" ? "none" : "block";
      if (colour !== "off") strip.style.background = colour;
      render();
    }),
    button("exit", () => {
      writeSession(null);
      setThemeColor("app");
      setManifest(null);
      panel.remove();
      strip.remove();
    }),
    variantLinks,
  );
  render();

  const mount = () => document.body.append(strip, panel);
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount, { once: true });
  return true;
};

export const resetPwaDebugForTests = (): void => {
  savedMetas = [];
  writeSession(null);
};
