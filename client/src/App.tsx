import { Info, User, LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "./cx";
import css from "./App.module.css";
import { FullscreenViewer } from "./components/FullscreenViewer";
import { FacesReviewPage } from "./components/faces";
import { StatusModal } from "./components/StatusModal";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { AuthGate, useAuthSession } from "./auth/AuthGate";
import { Filter } from "./components/filter/Filter";
import { FilterProvider } from "./components/filter/FilterContext";
import {
  SelectionProvider,
  useSelectionContext,
} from "./components/selection/SelectionContext";
import { useSyncUrlWithFilter, type ViewMode } from "./hooks/useSyncUrlWithFilter";
import { probeVideoPlaybackProfile } from "./videoPlaybackProfile";

const AppContent = () => {
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewMode>(
    () => new URLSearchParams(window.location.search).get("view") === "faces" ? "faces" : "library",
  );
  const { username, isSigningOut, signOut } = useAuthSession();
  const { clearSelection, selectedItems, selectionMode, setSelectionMode } =
    useSelectionContext();
  useSyncUrlWithFilter(view, setView);

  useEffect(() => {
    void probeVideoPlaybackProfile();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const handle = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

  const canUseNativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";
  const supportsFileShare = (() => {
    if (!canUseNativeShare || typeof navigator.canShare !== "function") {
      return false;
    }

    try {
      return navigator.canShare({
        files: [new File([""], "share-check.txt", { type: "text/plain" })],
      });
    } catch {
      return false;
    }
  })();

  const handleSelectionModeChange = (nextSelectionMode: boolean) => {
    setSelectionMode(nextSelectionMode);
    clearSelection();
  };

  const handleShare = async () => {
    if (
      !canUseNativeShare ||
      !supportsFileShare ||
      selectedItems.length === 0 ||
      isSharing
    ) {
      return;
    }

    try {
      setIsSharing(true);
      const files = await Promise.all(
        selectedItems.map(async (item) => {
          const response = await fetch(item.originalUrl);
          if (!response.ok) {
            throw new Error(
              `Failed to fetch file for sharing (status ${response.status})`,
            );
          }

          const blob = await response.blob();
          const mimeType = blob.type || item.metadata?.mimeType || undefined;
          return mimeType
            ? new File([blob], item.name, { type: mimeType })
            : new File([blob], item.name);
        }),
      );

      if (!navigator.canShare({ files })) {
        throw new Error("Native share does not support the selected files");
      }

      await navigator.share({
        files,
        title: files.length === 1 ? files[0].name : `${files.length} items from Photrix`,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      console.error("Native share failed", error);
    } finally {
      setIsSharing(false);
    }
  };

  return (
    <div className={css.app}>
      <header
        className={cx(
          css.header,
          isStatusOpen ? css.headerStatusOpen : undefined,
        )}
      >
        <div className={css.headerTitle}>
          <h2>Photrix</h2>
          <small>A better way to view photos.</small>
        </div>

        <div className={css.headerActions}>
          <button
            className={`btn ${view === "library" ? "btn-primary" : "btn-subtle"}`}
            onClick={() => setView("library")}
          >
            Library
          </button>
          <button
            className={`btn ${view === "faces" ? "btn-primary" : "btn-subtle"}`}
            onClick={() => setView("faces")}
          >
            Faces
          </button>
          <Filter />
          {view === "library" ? (
            <>
              {selectionMode ? (
                <>
                  <small>{selectedItems.length} selected</small>
                  <button
                    onClick={handleShare}
                    className="btn btn-primary"
                    disabled={
                      !canUseNativeShare ||
                      !supportsFileShare ||
                      selectedItems.length === 0 ||
                      isSharing
                    }
                  >
                    {isSharing ? "Preparing…" : "Share"}
                  </button>
                  <button
                    onClick={() => handleSelectionModeChange(false)}
                    className="btn btn-subtle"
                  >
                    Done
                  </button>
                </>
              ) : (
                <button
                  onClick={() => handleSelectionModeChange(true)}
                  className="btn btn-subtle"
                >
                  Select
                </button>
              )}
            </>
          ) : null}
          <button
            title="Server Status"
            className="btn btn-subtle"
            onClick={() => setIsStatusOpen(true)}
          >
            <Info size={20} />
            Status
          </button>
        </div>

        <div ref={menuRef} className={css.headerAuthMenu}>
          <button
            className="btn btn-subtle"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <User size={20} />
            {username}
          </button>
          {menuOpen && (
            <div role="menu" className="menu-popover">
              <button
                role="menuitem"
                className="menu-item"
                onClick={() => { signOut(); setMenuOpen(false); }}
                disabled={isSigningOut}
              >
                <LogOut size={20} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      <StatusModal isOpen={isStatusOpen} onDismiss={() => setIsStatusOpen(false)} />

      {view === "library" ? (
        <>
          <ThumbnailGrid />
          <FullscreenViewer />
        </>
      ) : (
        <FacesReviewPage />
      )}
    </div>
  );
};

export default function App() {
  return (
    <AuthGate>
      <FilterProvider>
        <SelectionProvider>
          <AppContent />
        </SelectionProvider>
      </FilterProvider>
    </AuthGate>
  );
}
