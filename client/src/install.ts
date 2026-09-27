// Installing Photrix as an app (PWA).
//
// The manifest and service worker in /public make the site installable; this
// module tracks *whether* this browser can install it right now, so the UI can
// offer an Install button instead of making people hunt through a browser menu.
//
// `beforeinstallprompt` fires once, early, and usually before any install UI is
// mounted — so it has to be captured at startup (initInstall, from main.tsx) and
// held here, not inside a component.

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/**
 * - `installed`   — running as the installed app, or just installed from this tab
 * - `available`   — the browser handed us an install prompt; promptInstall() works
 * - `ios`         — iOS/iPadOS: no prompt API, installs via Share → Add to Home Screen
 * - `manual`      — nothing to prompt with; the browser's own menu may still offer it
 */
export type InstallState = "installed" | "available" | "ios" | "manual";

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let justInstalled = false;
let initialized = false;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

export const isStandalone = (): boolean => {
  if (typeof window === "undefined") return false;
  const displayModeStandalone =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return displayModeStandalone || iosStandalone;
};

const isIos = (): boolean => {
  if (typeof navigator === "undefined") return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  // iPadOS 13+ reports itself as a Mac; the touch points give it away.
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
};

export const getInstallState = (): InstallState => {
  if (justInstalled || isStandalone()) return "installed";
  if (deferredPrompt) return "available";
  if (isIos()) return "ios";
  return "manual";
};

export const subscribeInstallState = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Shows the browser's install dialog. Resolves true if the user accepted. */
export const promptInstall = async (): Promise<boolean> => {
  const prompt = deferredPrompt;
  if (!prompt) return false;
  // A prompt event can only be used once, whatever the outcome.
  deferredPrompt = null;
  try {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    return outcome === "accepted";
  } catch {
    return false;
  } finally {
    notify();
  }
};

/** Starts listening for install availability. Call once, at startup. */
export const initInstall = (): void => {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Not preventDefault()-ed: the browser keeps its own install affordance,
    // and the stashed event additionally backs the in-app Install button.
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    justInstalled = true;
    notify();
  });
};

/** Registers the service worker that makes the site installable. */
export const registerServiceWorker = (): void => {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Installability is a nicety; never let it surface as an app error.
    });
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
};

/** Test-only: forget captured state between specs. */
export const resetInstallStateForTests = (): void => {
  deferredPrompt = null;
  justInstalled = false;
  initialized = false;
  listeners.clear();
};
