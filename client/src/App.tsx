import { Info24Regular, Share24Regular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { cx } from "./cx";
import css from "./App.module.css";
import { buildShareScope } from "./api";
import { FullscreenViewer } from "./components/FullscreenViewer";
import { LoginScreen } from "./components/LoginScreen";
import { PeopleView } from "./components/PeopleView";
import { SearchBar } from "./components/SearchBar";
import { ShareLinkModal } from "./components/ShareLinkModal";
import { StatusModal } from "./components/StatusModal";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { Filter } from "./components/filter/Filter";
import { FilterProvider, useFilter } from "./components/filter/FilterContext";
import { SelectionProvider } from "./components/selection/SelectionContext";
import { useSyncUrlWithFilter, type ViewMode } from "./hooks/useSyncUrlWithFilter";
import { buildShareUrl, isSharedView } from "./hooks/useShareFilter";
import { readViewModeFromSearch } from "./filterUrlState";
import { probeVideoPlaybackProfile } from "./videoPlaybackProfile";
import { extractUrlToken, getAuthHeaders, initAuth, onUnauthorized } from "./auth";

// Extract a token from the URL immediately (before auth check) so share links self-authenticate.
extractUrlToken();

const sharedView = isSharedView();

const initialViewFromUrl = (): ViewMode => {
  if (typeof window === "undefined") return "library";
  return readViewModeFromSearch(window.location.search);
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
        {loading ? "Sharing…" : "Share"}
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

const AppContent = () => {
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [view, setView] = useState<ViewMode>(initialViewFromUrl);

  useSyncUrlWithFilter(view, setView);

  useEffect(() => {
    void probeVideoPlaybackProfile();
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
          <Filter />
          <ShareButton />
          {!sharedView && (
            <button
              title="Server Status"
              className="btn btn-subtle"
              onClick={() => setIsStatusOpen(true)}
            >
              <Info24Regular fontSize={20} />
              Status
            </button>
          )}
        </div>
      </header>

      {!sharedView && (
        <StatusModal isOpen={isStatusOpen} onDismiss={() => setIsStatusOpen(false)} />
      )}

      {view === "library" ? (
        <ThumbnailGrid view={view} onViewChange={setView} />
      ) : (
        <PeopleView view={view} onViewChange={setView} />
      )}
      <FullscreenViewer />
    </div>
  );
};

type AuthState = "loading" | "authenticated" | "unauthenticated";

export default function App() {
  const [authState, setAuthState] = useState<AuthState>("loading");

  useEffect(() => {
    void initAuth().then((ok) => setAuthState(ok ? "authenticated" : "unauthenticated"));
    onUnauthorized(() => setAuthState("unauthenticated"));
  }, []);

  if (authState === "loading") return null;

  if (authState === "unauthenticated") {
    return <LoginScreen onAuthenticated={() => setAuthState("authenticated")} />;
  }

  return (
    <FilterProvider>
      <SelectionProvider>
        <AppContent />
      </SelectionProvider>
    </FilterProvider>
  );
}
