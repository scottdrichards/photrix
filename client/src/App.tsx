import {
  Button,
  Caption1,
  Title2,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Info24Regular } from "@fluentui/react-icons";
import { useState } from "react";
import { FullscreenViewer } from "./components/FullscreenViewer";
import { StatusModal } from "./components/StatusModal";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { Filter } from "./components/filter/Filter";
import { FilterProvider } from "./components/filter/FilterContext";
import { SelectionProvider, useSelectionContext } from "./components/selection/SelectionContext";
import { useSyncUrlWithFilter } from "./hooks/useSyncUrlWithFilter";


const useStyles = makeStyles({
  app: {
    paddingInline: tokens.spacingHorizontalM,
    paddingBlockEnd: tokens.spacingHorizontalXL,
    display: "flex",
    flexDirection: "column",
    gap: 0,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
    position: "sticky",
    top: 0,
    zIndex: 10,
    paddingBlock: tokens.spacingHorizontalM,
    paddingInline: tokens.spacingHorizontalM,
    marginInline: `calc(${tokens.spacingHorizontalM} * -1)`,
    backgroundColor: "rgba(255, 255, 255, 0.4)",
    backdropFilter: "blur(10px)",
    WebkitBackdropFilter: "blur(10px)",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    marginBlockEnd: tokens.spacingHorizontalL,
  },
  headerTitle: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalXS,
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
});

const AppContent = () => {
  const styles = useStyles();
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const { clearSelection, selectedItems, selectionMode, setSelectionMode } = useSelectionContext();
  useSyncUrlWithFilter();

  const canUseNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const handleSelectionModeChange = (nextSelectionMode: boolean) => {
    setSelectionMode(nextSelectionMode);
    clearSelection();
  };

  const handleShare = async () => {
    if (!canUseNativeShare || selectedItems.length === 0) {
      return;
    }

    const selectedUrls = selectedItems.map((item) => new URL(item.fullUrl, window.location.origin).toString());

    const sharePayload = selectedUrls.length === 1
      ? {
          title: selectedItems[0].name,
          url: selectedUrls[0],
        }
      : {
          title: `${selectedUrls.length} items from Photrix`,
          text: selectedUrls.join("\n"),
        };

    try {
      await navigator.share(sharePayload);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      console.error("Native share failed", error);
    }
  };

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <Title2>Photrix</Title2>
          <Caption1>A better way to view photos.</Caption1>
        </div>

        <div className={styles.headerActions}>
          <Filter />
          {selectionMode ? (
            <>
              <Caption1>{selectedItems.length} selected</Caption1>
              <Button
                onClick={handleShare}
                appearance="primary"
                disabled={!canUseNativeShare || selectedItems.length === 0}
              >
                Share
              </Button>
              <Button onClick={() => handleSelectionModeChange(false)} appearance="subtle">
                Done
              </Button>
            </>
          ) : (
            <Button onClick={() => handleSelectionModeChange(true)} appearance="subtle">
              Select
            </Button>
          )}
          <Tooltip content="Server Status" relationship="description">
            <Button
              icon={<Info24Regular />}
              onClick={() => setIsStatusOpen(true)}
              appearance="subtle"
            >
              Status
            </Button>
          </Tooltip>
        </div>
      </header>

      <StatusModal isOpen={isStatusOpen} onDismiss={() => setIsStatusOpen(false)} />

      <ThumbnailGrid />

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
