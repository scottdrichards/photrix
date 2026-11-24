import { useCallback, useEffect, useReducer, useRef } from "react";
import { fetchPhotoByPath } from "./api";
import { initialNavFromUrl, navReducer } from "./appNavigation";
import { useSelectionContext } from "./components/selection/SelectionContext";
import type { PeopleSelection } from "./filterUrlState";
import { useSyncUrlWithFilter, type UrlNavState, type ViewMode } from "./hooks/useSyncUrlWithFilter";
import { logFailure } from "./logFailure";

/**
 * Which tab is showing, who is selected in People and which photo is open,
 * kept in step with the URL and with the selection context.
 */
export const useAppNavigation = () => {
  const [nav, dispatch] = useReducer(navReducer, undefined, initialNavFromUrl);
  const { items, selectedPath, selectByPath } = useSelectionContext();

  const handleUrlNavigate = useCallback(
    (next: UrlNavState) => dispatch({ type: "urlChanged", next }),
    [],
  );
  useSyncUrlWithFilter(nav, handleUrlNavigate);

  // Feedback #120: mirror the fullscreen viewer's open photo into the URL
  // (nav.previewPath), the same way nav.people already mirrors the People
  // tab's selection — a refresh, a shared link, or the back button should
  // all be able to reopen (or close) it, not just drop back to the bare grid.
  // Keyed on the selected *path*, and only when it changes: on a cold load the
  // path is still null while the URL names a photo, and writing that null back
  // would erase the deep link before it opens.
  const lastSelectedPathRef = useRef(selectedPath);
  useEffect(() => {
    if (lastSelectedPathRef.current === selectedPath) return;
    lastSelectedPathRef.current = selectedPath;
    dispatch({ type: "previewChanged", path: selectedPath });
  }, [selectedPath]);

  // The URL side: initial load and back/forward. No view-transition morph
  // (setSelected's), since there is no origin tile to animate from. A photo
  // the loaded items don't have (a deep link from the Home Assistant wall, a
  // refresh deep in a long day, a burst member hidden in its stack) is fetched
  // on its own, so the viewer opens without waiting for the grid to find it.
  useEffect(() => {
    const path = nav.previewPath;
    if (path === selectedPath) return;
    selectByPath(path);
    if (!path || items.some((item) => item.path === path)) return;
    const controller = new AbortController();
    fetchPhotoByPath(path, controller.signal)
      .then((item) => {
        if (item) selectByPath(path, item);
      })
      .catch(logFailure("viewer.deepLink.failed", "Could not load the linked photo"));
    return () => controller.abort();
    // Only react to the URL side; the effect above handles the reverse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.previewPath]);

  const handleViewChange = useCallback(
    (view: ViewMode) => dispatch({ type: "viewChanged", view }),
    [],
  );

  const handlePeopleNavigate = useCallback(
    (people: PeopleSelection, options?: { replace?: boolean }) =>
      dispatch({ type: "peopleNavigated", people, replace: options?.replace }),
    [],
  );

  return { nav, handleViewChange, handlePeopleNavigate };
};
