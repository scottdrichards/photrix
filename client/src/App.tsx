import { Suspense, useCallback, useEffect, useState } from "react";
import { cx } from "./cx";
import css from "./App.module.css";
import {
  LazyFullscreenViewer,
  preloadFullscreenViewer,
} from "./components/viewer/LazyFullscreenViewer";
import { lazyPart } from "./lazyPart";
import { whenNetworkQuiet } from "./whenNetworkQuiet";
import { AccountPanel } from "./components/account/AccountPanel";
import { ThemeToggle } from "./components/account/ThemeToggle";
import { LoginScreen } from "./components/account/LoginScreen";
import { StatusModal } from "./components/status/StatusModal";
import { SuggestionModal } from "./components/feedback/SuggestionModal";
import { ThumbnailGrid } from "./components/grid/ThumbnailGrid";
import { TopRailPortalProvider } from "./components/TopRailPortal";
import { SortDockProvider } from "./components/grid/SortDockPortal";
import { FilterProvider, useFilter } from "./components/filter/FilterContext";
import { SelectionProvider, useSelectionContext } from "./components/selection/SelectionContext";
import { usePageTitle } from "./hooks/usePageTitle";
import { setSelectionBadge, setViewerThemeColor } from "./appChrome";
import { isSharedView } from "./hooks/useShareFilter";
import {
  applyTheme,
  getStoredThemeOverride,
  getSystemTheme,
  persistThemeOverride,
  subscribeToSystemTheme,
  type Theme,
  type ThemeOverride,
} from "./theme";
import { probeVideoPlaybackProfile } from "./videoPlaybackProfile";
import { extractUrlToken, hasAccountSession, initAuth, onUnauthorized } from "./auth";
import { FeatureFlagsProvider } from "./featureFlags/FeatureFlagsContext";
import { AppHeader } from "./AppHeader";
import { useAppNavigation } from "./useAppNavigation";

const { Part: PeopleView } = lazyPart("people", () =>
  import("./components/people/PeopleView").then((module) => module.PeopleView),
);

// Extract a token from the URL immediately (before auth check) so share links self-authenticate.
extractUrlToken();

// Feedback #127: below this scroll offset the floating view-toggle/sort bar
// (see .floatingBarDock) is shown; above it, hidden.
const NEAR_TOP_THRESHOLD_PX = 24;

const sharedView = isSharedView();
// Whether a real account session exists underneath this share view — read before
// any request can disturb it, same as sharedView.
const ownsAccountSession = hasAccountSession();

type AppContentProps = {
  theme: Theme;
  followsSystem: boolean;
  onThemeToggle: () => void;
};

const AppContent = ({ theme, followsSystem, onThemeToggle }: AppContentProps) => {
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isSuggestionOpen, setIsSuggestionOpen] = useState(false);
  const [viewToggleHost, setViewToggleHost] = useState<HTMLDivElement | null>(null);
  const [sortDockHost, setSortDockHost] = useState<HTMLDivElement | null>(null);
  const { nav, handleViewChange, handlePeopleNavigate } = useAppNavigation();
  const { view } = nav;
  const { selected, checkedPaths } = useSelectionContext();

  // Feedback #195: the window around the app mirrors its state: a black title
  // bar while a photo is open, and the selection count on the installed icon.
  const viewerOpen = selected !== null;
  useEffect(() => {
    setViewerThemeColor(viewerOpen);
    return () => setViewerThemeColor(false);
  }, [viewerOpen]);
  const checkedCount = checkedPaths.size;
  useEffect(() => {
    setSelectionBadge(checkedCount);
    return () => setSelectionBadge(0);
  }, [checkedCount]);

  const { filter } = useFilter();
  // Live result count for the header subtitle, reported by ThumbnailGrid so
  // it isn't fetched twice. Only meaningful in the library view — reset when
  // navigating to People so the subtitle doesn't show a stale count there.
  const [resultCount, setResultCount] = useState<number | null>(null);
  const { description: viewDescription } = usePageTitle(filter, view === "library" ? resultCount : null);
  // Feedback #202: a capped semantic search only knows a floor, shown as "500+".
  const [resultCountIsLowerBound, setResultCountIsLowerBound] = useState(false);
  const handleTotalChange = useCallback((total: number | null, isLowerBound = false) => {
    setResultCount(total);
    setResultCountIsLowerBound(isLowerBound);
  }, []);
  useEffect(() => {
    if (view !== "library") setResultCount(null);
  }, [view]);

  useEffect(() => {
    if (sharedView) return;
    void probeVideoPlaybackProfile();
  }, []);

  // Opening a photo is the next thing most visits do, so the viewer is fetched
  // ahead of that: once the first screen has stopped loading, not during it.
  useEffect(() => whenNetworkQuiet(preloadFullscreenViewer), []);

  // Feedback #127: floating the view-toggle/sort bar at the bottom of the
  // viewport (see #121/#122/#123) still needs to get out of the way while
  // scrolling through the grid — it should only be there when the grid is
  // scrolled to the top, not permanently on-screen. Unlike the old
  // implementation this ignores scroll *direction* entirely: it's purely a
  // function of the current position, so there's no "reappears over a photo
  // the user scrolled up past" failure mode.
  const [nearTop, setNearTop] = useState(true);
  useEffect(() => {
    const onScroll = () => setNearTop(window.scrollY <= NEAR_TOP_THRESHOLD_PX);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (sharedView) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "p" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setIsSuggestionOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <TopRailPortalProvider host={viewToggleHost}>
    <SortDockProvider host={sortDockHost}>
      <div className={css.app}>
        <div className={cx(css.topRail, isStatusOpen ? css.topRailStatusOpen : undefined)}>
          <AppHeader
            sharedView={sharedView}
            ownsAccountSession={ownsAccountSession}
            viewDescription={viewDescription}
            resultCount={resultCount}
            resultCountIsLowerBound={resultCountIsLowerBound}
            theme={theme}
            followsSystem={followsSystem}
            onThemeToggle={onThemeToggle}
            onOpenSuggestion={() => setIsSuggestionOpen(true)}
            onOpenAccount={() => setIsAccountOpen(true)}
            onOpenStatus={() => setIsStatusOpen(true)}
          />
        </div>

        {/* Feedback #121/#122/#123: this used to dock just under the header
            and hide/show based on scroll direction, which meant scrolling up
            anywhere in a long grid — not just reaching the top — could shove
            it back over a photo the user was looking at, and the sort
            control lived in-flow above the grid and pushed every tile down
            whenever it was visible. Floating it at the bottom of the
            viewport fixes both, but feedback #127: it still needs to get out
            of the way while scrolling through the grid, so it's only shown
            near the top (see the `nearTop` effect above) rather than
            permanently on-screen. */}
        <div
          className={cx(css.floatingBarDock, !nearTop && css.floatingBarDockHidden)}
          style={{ pointerEvents: "none" }}
          aria-hidden={!nearTop}
          data-testid="floating-bar-dock"
        >
          <div ref={setViewToggleHost} style={{ pointerEvents: "none" }} />
        </div>

        {/* A comment (not a queue item, unlike #121-#123/#127 above): sharing
            the centered dock with the view-toggle pill made SortControl's
            box stack under (not beside) the pill — each is its own
            block-level box, so the pill's own width, not a shared row,
            decided how wide the centered dock read as — and its buttons
            didn't respond to clicks at all, since nothing in that chain set
            pointer-events back to auto for it (see SortControl.module.css).
            Its own dock, pinned to the bottom-right, sidesteps both. */}
        <div
          className={cx(css.sortDock, !nearTop && css.sortDockHidden)}
          style={{ pointerEvents: "none" }}
          aria-hidden={!nearTop}
          data-testid="sort-dock"
        >
          <div ref={setSortDockHost} style={{ pointerEvents: "none" }} />
        </div>

        {!sharedView && (
          <>
            <StatusModal isOpen={isStatusOpen} onDismiss={() => setIsStatusOpen(false)} />
            <AccountPanel
              isOpen={isAccountOpen}
              onDismiss={() => setIsAccountOpen(false)}
              theme={theme}
              followsSystem={followsSystem}
              onThemeToggle={onThemeToggle}
            />
          </>
        )}
        {/* Not gated on !sharedView, unlike the panels above — the whole point
            of feedback #99 is that this has to work from a shared link too. */}
        {isSuggestionOpen && <SuggestionModal onClose={() => setIsSuggestionOpen(false)} />}

        {view === "library" ? (
          <ThumbnailGrid
            view={view}
            onViewChange={handleViewChange}
            onTotalChange={handleTotalChange}
          />
        ) : (
          <Suspense fallback={null}>
            <PeopleView
              view={view}
              onViewChange={handleViewChange}
              personId={nav.people.personId}
              groupId={nav.people.groupId}
              onNavigate={handlePeopleNavigate}
            />
          </Suspense>
        )}
        <LazyFullscreenViewer />
      </div>
    </SortDockProvider>
    </TopRailPortalProvider>
  );
};

type AuthState = "loading" | "authenticated" | "unauthenticated";

export default function App() {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);
  const [themeOverride, setThemeOverride] = useState<ThemeOverride>(getStoredThemeOverride);

  const theme = themeOverride ?? systemTheme;
  const followsSystem = themeOverride === null;

  const handleThemeToggle = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setThemeOverride(nextTheme === systemTheme ? null : nextTheme);
  };

  useEffect(() => {
    applyTheme(theme);
    persistThemeOverride(themeOverride);
  }, [theme, themeOverride]);

  useEffect(() => subscribeToSystemTheme(setSystemTheme), []);

  useEffect(() => {
    void initAuth().then((ok) => setAuthState(ok ? "authenticated" : "unauthenticated"));
    onUnauthorized(() => setAuthState("unauthenticated"));
  }, []);

  if (authState === "loading") return null;

  if (authState === "unauthenticated") {
    return (
      <>
        <div className={css.themeToggleFloating}>
          <ThemeToggle theme={theme} followsSystem={followsSystem} onToggle={handleThemeToggle} />
        </div>
        <LoginScreen onAuthenticated={() => setAuthState("authenticated")} />
      </>
    );
  }

  return (
    <FeatureFlagsProvider>
      <FilterProvider>
        <SelectionProvider>
          <AppContent theme={theme} followsSystem={followsSystem} onThemeToggle={handleThemeToggle} />
        </SelectionProvider>
      </FilterProvider>
    </FeatureFlagsProvider>
  );
}
