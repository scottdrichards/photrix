/**
 * Picks up a new deploy without a manual reload (feedback #172).
 *
 * An installed app (PWA) has no reload button and can sit in the background
 * for days, so without this it keeps running whatever build it first loaded.
 * The service worker caches nothing (see public/sw.js), so a fresh load is
 * always current; the only problem is knowing when to load again.
 *
 * Detection: fetch `/` with the HTTP cache bypassed and compare its entry
 * script (Vite names it by content hash) with the one this page is running.
 * No server endpoint or version file is needed.
 *
 * What happens on a new build:
 * - **Coming back to the app** after a while away reloads straight away. The
 *   view lives in the URL, so the reload lands where the user was.
 * - **While the app is in use** it only reports the update, so the caller can
 *   offer a Reload button. Yanking the page out from under someone mid-edit
 *   would lose their work.
 */

import { attempt } from "./result";

/** How long the app must have been hidden for a return to count as "coming back". */
export const RESUME_AFTER_HIDDEN_MS = 60_000;
/** How often to check while the app stays open and visible. */
export const CHECK_INTERVAL_MS = 10 * 60_000;
/** Don't check more often than this, however often visibility flips. */
export const MIN_CHECK_GAP_MS = 30_000;

const ENTRY_SCRIPT = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/i;

/** The entry script named by an index.html, or null when there isn't one. */
export const entryScriptFromHtml = (html: string): string | null =>
  ENTRY_SCRIPT.exec(html)?.[1] ?? null;

/** The entry script this page was loaded with. */
export const runningEntryScript = (doc: Document = document): string | null =>
  doc.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null;

/**
 * The entry script the server would hand out now, or null if it can't tell.
 * Failing is expected (offline, or the server mid-restart) and harmless: the
 * next check tries again, so the failure is not worth logging.
 */
export const fetchLatestEntryScript = async (): Promise<string | null> => {
  const response = await attempt(
    fetch("/", { cache: "no-store", headers: { accept: "text/html" } }),
  );
  if (!response.ok || !response.value.ok) return null;
  const html = await attempt(response.value.text());
  return html.ok ? entryScriptFromHtml(html.value) : null;
};

/**
 * True when the user has typed something a reload would throw away. A focused
 * but empty field (the sign-in form autofocuses one) has nothing to lose.
 */
const isEditing = (doc: Document): boolean => {
  const active = doc.activeElement as HTMLElement | null;
  if (!active) return false;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    return active.value.trim() !== "";
  }
  return active.isContentEditable && (active.textContent ?? "").trim() !== "";
};

type WatchOptions = {
  /** Called once when a new build is found and the page wasn't reloaded for it. */
  onUpdateAvailable: () => void;
  reload?: () => void;
  latestEntryScript?: () => Promise<string | null>;
  now?: () => number;
  doc?: Document;
};

/** Starts watching for a new deploy. Returns a function that stops it. */
export const watchForAppUpdate = ({
  onUpdateAvailable,
  reload = () => window.location.reload(),
  latestEntryScript = fetchLatestEntryScript,
  now = Date.now,
  doc = document,
}: WatchOptions): (() => void) => {
  const running = runningEntryScript(doc);
  // The Vite dev server serves /src/main.tsx, which never changes name: HMR
  // already keeps it current.
  if (!running || !running.includes("/assets/")) return () => {};

  let hiddenSince: number | null = doc.visibilityState === "hidden" ? now() : null;
  let lastCheck = now();
  let reported = false;
  let checking = false;

  const check = async (resumed: boolean) => {
    if (checking || reported) return;
    checking = true;
    lastCheck = now();
    try {
      const latest = await latestEntryScript();
      if (!latest || latest === running) return;
      if (resumed && doc.visibilityState === "visible" && !isEditing(doc)) {
        reload();
        return;
      }
      reported = true;
      onUpdateAvailable();
    } finally {
      checking = false;
    }
  };

  const handleVisibility = () => {
    if (doc.visibilityState === "hidden") {
      hiddenSince = now();
      return;
    }
    const awayFor = hiddenSince === null ? 0 : now() - hiddenSince;
    hiddenSince = null;
    if (now() - lastCheck < MIN_CHECK_GAP_MS) return;
    void check(awayFor >= RESUME_AFTER_HIDDEN_MS);
  };

  const timer = setInterval(() => {
    if (doc.visibilityState === "visible") void check(false);
  }, CHECK_INTERVAL_MS);
  doc.addEventListener("visibilitychange", handleVisibility);

  return () => {
    clearInterval(timer);
    doc.removeEventListener("visibilitychange", handleVisibility);
  };
};
