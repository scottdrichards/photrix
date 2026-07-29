import { useEffect, useRef } from "react";
import { useFilter } from "../components/filter/FilterContext";
import {
  buildAppUrl,
  navigationKey,
  parseAppUrlState,
  type PeopleSelection,
  type ViewMode,
} from "../filterUrlState";

export type { PeopleSelection, ViewMode } from "../filterUrlState";

/** The slice of app state that lives outside the filter but belongs in the URL. */
export type UrlNavState = {
  view: ViewMode;
  people: PeopleSelection;
  /**
   * Forces `replaceState` for the write this state triggers. Used for
   * corrections the user did not ask for (a person that vanished under a new
   * filter, an id that changed under a merge), which must not become history
   * entries. When absent the mode is derived from the diff.
   */
  replace?: boolean;
};

const currentUrl = (): string => `${window.location.pathname}${window.location.search}`;

/**
 * Keeps the browser URL and the application state in agreement, in both
 * directions, as the single writer of the address bar.
 *
 * Writes are skipped when the URL already says what the state says, so a
 * popstate-driven state update cannot bounce back into another history write.
 */
export const useSyncUrlWithFilter = (
  nav: UrlNavState,
  onNavigate: (next: UrlNavState) => void,
): void => {
  const { filter, setFilter } = useFilter();
  const { view, replace } = nav;
  const { personId, groupId } = nav.people;

  // The URL this hook last put in the address bar. `null` until the first write,
  // which distinguishes "mounted on a URL someone else chose" from "we navigated".
  const lastWrittenUrlRef = useRef<string | null>(null);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    const nextUrl = buildAppUrl(
      { view, filter, people: { personId, groupId } },
      window.location.search,
    );
    if (currentUrl() === nextUrl) {
      lastWrittenUrlRef.current = nextUrl;
      return;
    }

    const previousUrl = lastWrittenUrlRef.current;
    lastWrittenUrlRef.current = nextUrl;

    // First write of the session only normalizes the URL the user landed on
    // (dropping redundant defaults) — that must not push a second entry.
    const shouldPush =
      previousUrl !== null &&
      !replace &&
      navigationKey(previousUrl) !== navigationKey(nextUrl);

    if (shouldPush) {
      window.history.pushState(null, "", nextUrl);
    } else {
      window.history.replaceState(null, "", nextUrl);
    }
  }, [filter, view, personId, groupId, replace]);

  useEffect(() => {
    const handlePopState = () => {
      const state = parseAppUrlState(window.location);
      // The address bar is already correct; record it so the write effect that
      // follows this state update recognises there is nothing to do.
      lastWrittenUrlRef.current = currentUrl();
      setFilter(state.filter);
      onNavigateRef.current({ view: state.view, people: state.people, replace: true });
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [setFilter]);
};
