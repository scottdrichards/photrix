import { NO_PEOPLE_SELECTION, parseAppUrlState, type PeopleSelection } from "./filterUrlState";
import type { UrlNavState, ViewMode } from "./hooks/useSyncUrlWithFilter";

/** Every way the view, the People selection or the open preview can change. */
export type NavAction =
  /** The URL side moved (initial load, back/forward): take its state as given. */
  | { type: "urlChanged"; next: UrlNavState }
  /**
   * A person only exists inside the People tab, so leaving it clears the
   * selection rather than leaving state the URL can no longer express. The
   * open preview doesn't carry across either: the People tab and the library
   * grid load different item lists, so a path from one won't resolve in the other.
   */
  | { type: "viewChanged"; view: ViewMode }
  | { type: "peopleNavigated"; people: PeopleSelection; replace?: boolean }
  /** The fullscreen viewer opened, moved or closed. */
  | { type: "previewChanged"; path: string | null };

export const navReducer = (prev: UrlNavState, action: NavAction): UrlNavState => {
  switch (action.type) {
    case "urlChanged":
      return action.next;
    case "viewChanged":
      return {
        view: action.view,
        people: action.view === "people" ? prev.people : NO_PEOPLE_SELECTION,
        previewPath: null,
      };
    case "peopleNavigated":
      return {
        view: prev.view,
        people: action.people,
        previewPath: prev.previewPath,
        replace: action.replace,
      };
    case "previewChanged":
      return prev.previewPath === action.path ? prev : { ...prev, previewPath: action.path };
  }
};

export const initialNavFromUrl = (): UrlNavState => {
  if (typeof window === "undefined") {
    return { view: "library", people: NO_PEOPLE_SELECTION, previewPath: null };
  }
  const { view, people, preview } = parseAppUrlState(window.location);
  return { view, people, previewPath: preview };
};
