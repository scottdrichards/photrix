/**
 * Parts of the app that load when first needed instead of with the page: the
 * photo viewer (and the video player inside it), the map, the People view.
 * Together they are more than half of the code, and the first screen needs none
 * of it.
 *
 * A deploy replaces every file under /assets, so a page loaded before the
 * deploy can't fetch a part it hasn't loaded yet: the server answers with
 * index.html and the import fails. That page is running a build that no longer
 * exists, and the cure is the one appUpdate.ts uses for any new deploy: load
 * again. The view lives in the URL, so the reload lands where the user was.
 */

import { lazy, type ComponentType } from "react";
import { attempt, type Result } from "./result";
import { logFailure } from "./logFailure";
import { readStorage, writeStorage } from "./storage";

const RELOADED_AT_KEY = "photrix_part_reload_at";

/**
 * A part that still fails this soon after a reload is not a stale page (the
 * network is down, or the deploy is broken), and reloading again would loop.
 */
export const RELOAD_GAP_MS = 60_000;

const RELOAD_DELAY_MS = 150;

type Options = {
  reload?: () => void;
  now?: () => number;
};

const Nothing = () => null;

/**
 * `Part` renders the component once it has loaded (suspending until then), and
 * `preload` fetches it ahead of use. `name` only labels the failure report.
 */
export const lazyPart = <Props extends object>(
  name: string,
  load: () => Promise<ComponentType<Props>>,
  { reload = () => window.location.reload(), now = Date.now }: Options = {},
) => {
  const state: { loading: Promise<Result<ComponentType<Props>>> | null } = { loading: null };
  const loadOnce = () => {
    state.loading ??= attempt(load()).then((result) => {
      // A failure isn't kept: the next caller tries again.
      if (!result.ok) state.loading = null;
      return result;
    });
    return state.loading;
  };

  const Part = lazy(async (): Promise<{ default: ComponentType<Props> }> => {
    const loaded = await loadOnce();
    if (loaded.ok) return { default: loaded.value };

    logFailure("part.load-failed", `Could not load the ${name} part of the app`)(loaded.error);
    const reloadedAt = Number(readStorage(RELOADED_AT_KEY) ?? 0);
    if (now() - reloadedAt < RELOAD_GAP_MS) return { default: Nothing };

    writeStorage(RELOADED_AT_KEY, String(now()));
    // Not at once: the click that asked for this part (opening a photo, say) is
    // still on its way into the URL, and the reload has to land on it.
    window.setTimeout(reload, RELOAD_DELAY_MS);
    // Stay suspended: the reload is about to replace the page.
    return new Promise<never>(() => undefined);
  });

  return {
    Part,
    /** Fetches the part now. A failure here is left for the first real use to deal with. */
    preload: (): void => void loadOnce(),
  };
};
