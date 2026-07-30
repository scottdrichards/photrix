import { Info24Regular, Person24Regular, Share24Regular } from "@fluentui/react-icons";
import { useCallback, useEffect, useState } from "react";
import { cx } from "./cx";
import css from "./App.module.css";
import { buildShareScope } from "./api";
import { FullscreenViewer } from "./components/FullscreenViewer";
import { AccountPanel } from "./components/AccountPanel";
import { LoginScreen } from "./components/LoginScreen";
import { PeopleView } from "./components/PeopleView";
import { SearchBar } from "./components/SearchBar";
import { ShareLinkModal } from "./components/ShareLinkModal";
import { StatusModal } from "./components/StatusModal";
import { SuggestionModal } from "./components/SuggestionModal";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { Filter } from "./components/filter/Filter";
import { FilterProvider, useFilter } from "./components/filter/FilterContext";
import { SelectionProvider } from "./components/selection/SelectionContext";
import {
  useSyncUrlWithFilter,
  type UrlNavState,
  type ViewMode,
} from "./hooks/useSyncUrlWithFilter";
import { usePageTitle } from "./hooks/usePageTitle";
import { buildShareUrl, isSharedView } from "./hooks/useShareFilter";
import {
  NO_PEOPLE_SELECTION,
  parseAppUrlState,
  type PeopleSelection,
} from "./filterUrlState";
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
import {
  extractUrlToken,
  getAuthHeaders,
  hasAccountSession,
  initAuth,
  onUnauthorized,
} from "./auth";

// Extract a token from the URL immediately (before auth check) so share links self-authenticate.
extractUrlToken();

const sharedView = isSharedView();
// Whether a real account session exists underneath this share view — read before
// any request can disturb it, same as sharedView.
const ownsAccountSession = hasAccountSession();

const initialNavFromUrl = (): UrlNavState => {
  if (typeof window === "undefined") {
    return { view: "library", people: NO_PEOPLE_SELECTION };
  }
  const { view, people } = parseAppUrlState(window.location);
  return { view, people };
};

const copyToClipboard = async (text: string): Promise<boolean> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }
  // Legacy execCommand — works on HTTP / localhost
  const el = document.createElement("textarea");
  el.value = text;
  el.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(el);
  return ok;
};

type ShareModalState = { url: string; copied: boolean } | null;

type ThemeToggleProps = {
  theme: Theme;
  followsSystem: boolean;
  onToggle: () => void;
};

const ThemeToggle = ({ theme, followsSystem, onToggle }: ThemeToggleProps) => {
  const title = followsSystem
    ? `Following system theme: ${theme}`
    : `Theme override: ${theme}`;

  return (
    <button
      type="button"
      role="switch"
      aria-label="Theme"
      aria-checked={theme === "dark"}
      title={title}
      className={css.themeToggle}
      data-theme={theme}
      data-following-system={followsSystem}
      onClick={onToggle}
    >
      <span className={css.themeToggleTrack} aria-hidden="true">
        <span className={css.themeToggleGlow} />
        <span className={css.themeToggleStars} />
        <span className={css.themeToggleSun} />
        <span className={css.themeToggleMoon} />
        <span className={css.themeToggleThumb} />
        {followsSystem && <span className={css.themeToggleModeDot} />}
      </span>
    </button>
  );
};

const ShareButton = () => {
  const { filter } = useFilter();
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<ShareModalState>(null);

  const handleShare = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const shareScope = buildShareScope({
        ...filter,
        path: filter.path,
        includeSubfolders: filter.includeSubfolders,
      });
      const res = await fetch("/api/auth/share-token", {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(shareScope),
      });
      if (!res.ok) throw new Error("Failed to issue share token");
      const { token } = (await res.json()) as { token: string };
      const url = buildShareUrl(token);
      const copied = await copyToClipboard(url);
      setModal({ url, copied });
    } catch {
      // nothing — button returns to idle
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        title="Share current view"
        className="btn btn-subtle"
        onClick={() => void handleShare()}
        disabled={loading}
      >
        <Share24Regular fontSize={20} />
        <span className={css.btnLabel}>{loading ? "Sharing…" : "Share"}</span>
      </button>

      {modal && (
        <ShareLinkModal
          url={modal.url}
          copied={modal.copied}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
};

type AppContentProps = {
  theme: Theme;
  followsSystem: boolean;
  onThemeToggle: () => void;
};

const AppContent = ({ theme, followsSystem, onThemeToggle }: AppContentProps) => {
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isSuggestionOpen, setIsSuggestionOpen] = useState(false);
  const [nav, setNav] = useState<UrlNavState>(initialNavFromUrl);
  const { view } = nav;

  useSyncUrlWithFilter(nav, setNav);

  // A person only exists inside the People tab, so leaving it clears the
  // selection rather than leaving state the URL can no longer express.
  const handleViewChange = useCallback((nextView: ViewMode) => {
    setNav((prev) => ({
      view: nextView,
      people: nextView === "people" ? prev.people : NO_PEOPLE_SELECTION,
    }));
  }, []);

  const handlePeopleNavigate = useCallback(
    (people: PeopleSelection, options?: { replace?: boolean }) => {
      setNav((prev) => ({ view: prev.view, people, replace: options?.replace }));
    },
    [],
  );

  const { filter } = useFilter();
  usePageTitle(filter);

  useEffect(() => {
    if (sharedView) return;
    void probeVideoPlaybackProfile();
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
    <div className={css.app}>
      <header className={cx(css.header, isStatusOpen ? css.headerStatusOpen : undefined)}>
        <div className={css.title}>
          <h2>Photrix</h2>
          <small>{sharedView ? "Shared view" : "A better way to view photos."}</small>
        </div>

        <div className={css.headerActions}>
          <SearchBar />
          <div className={css.filterSlot}>
            <Filter />
          </div>
          <ThemeToggle theme={theme} followsSystem={followsSystem} onToggle={onThemeToggle} />
          <ShareButton />
          {sharedView && ownsAccountSession && (
            // A signed-in owner viewing their own share link is not trapped in it:
            // the account session is still there, and dropping the ?token= URL
            // restores the full library. A full navigation (not pushState) is
            // deliberate — share mode is read once at module load.
            <a className="btn btn-subtle" href="/" title="Return to your full library">
              <Person24Regular fontSize={20} />
              <span className={css.btnLabel}>My library</span>
            </a>
          )}
          {!sharedView && (
            <>
              <button
                title="Account"
                className="btn btn-subtle"
                onClick={() => setIsAccountOpen(true)}
              >
                <Person24Regular fontSize={20} />
                <span className={css.btnLabel}>Account</span>
              </button>
              <button
                title="Server Status"
                className="btn btn-subtle"
                onClick={() => setIsStatusOpen(true)}
              >
                <Info24Regular fontSize={20} />
                <span className={css.btnLabel}>Status</span>
              </button>
            </>
          )}
        </div>
      </header>

      {!sharedView && (
        <>
          <StatusModal isOpen={isStatusOpen} onDismiss={() => setIsStatusOpen(false)} />
          <AccountPanel
            isOpen={isAccountOpen}
            onDismiss={() => setIsAccountOpen(false)}
          />
          {isSuggestionOpen && <SuggestionModal onClose={() => setIsSuggestionOpen(false)} />}
        </>
      )}

      {view === "library" ? (
        <ThumbnailGrid view={view} onViewChange={handleViewChange} />
      ) : (
        <PeopleView
          view={view}
          onViewChange={handleViewChange}
          personId={nav.people.personId}
          groupId={nav.people.groupId}
          onNavigate={handlePeopleNavigate}
        />
      )}
      <FullscreenViewer />
    </div>
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
    <FilterProvider>
      <SelectionProvider>
        <AppContent theme={theme} followsSystem={followsSystem} onThemeToggle={handleThemeToggle} />
      </SelectionProvider>
    </FilterProvider>
  );
}
