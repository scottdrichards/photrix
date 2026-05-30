import { Info24Regular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { cx } from "./cx";
import css from "./App.module.css";
import { FullscreenViewer } from "./components/FullscreenViewer";
import { PeopleView } from "./components/PeopleView";
import { StatusModal } from "./components/StatusModal";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { Filter } from "./components/filter/Filter";
import { FilterProvider } from "./components/filter/FilterContext";
import { SelectionProvider } from "./components/selection/SelectionContext";
import { useSyncUrlWithFilter, type ViewMode } from "./hooks/useSyncUrlWithFilter";
import { probeVideoPlaybackProfile } from "./videoPlaybackProfile";

const initialViewFromUrl = (): ViewMode => {
  if (typeof window === "undefined") {
    return "library";
  }
  return new URLSearchParams(window.location.search).get("view") === "people"
    ? "people"
    : "library";
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
          <small>A better way to view photos.</small>
        </div>

        <div className={css.headerActions}>
          <div className={css.viewToggle} role="tablist" aria-label="Current view">
            <button
              type="button"
              className={`btn btn-subtle ${view === "library" ? css.viewToggleActive : ""}`}
              onClick={() => setView("library")}
              role="tab"
              aria-selected={view === "library"}
            >
              Thumbnails
            </button>
            <button
              type="button"
              className={`btn btn-subtle ${view === "people" ? css.viewToggleActive : ""}`}
              onClick={() => setView("people")}
              role="tab"
              aria-selected={view === "people"}
            >
              People
            </button>
          </div>
          <Filter />
          <button
            title="Server Status"
            className="btn btn-subtle"
            onClick={() => setIsStatusOpen(true)}
          >
            <Info24Regular fontSize={20} />
            Status
          </button>
        </div>
      </header>

      <StatusModal isOpen={isStatusOpen} onDismiss={() => setIsStatusOpen(false)} />

      {view === "library" ? <ThumbnailGrid /> : <PeopleView />}
      <FullscreenViewer />
    </div>
  );
};

export default function App() {
  return (
    <FilterProvider>
      <SelectionProvider>
        <AppContent />
      </SelectionProvider>
    </FilterProvider>
  );
}
