import {
  Button,
  Caption1,
  Title2,
  Tooltip,
  mergeClasses,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Info24Regular } from "@fluentui/react-icons";
import { useState } from "react";
import { FullscreenViewer } from "./components/FullscreenViewer";
import { StatusModal } from "./components/StatusModal";
import { ThumbnailGrid } from "./components/ThumbnailGrid";
import { AuthGate } from "./auth/AuthGate";
import { Filter } from "./components/filter/Filter";
import { FilterProvider } from "./components/filter/FilterContext";
import {
  SelectionProvider,
  useSelectionContext,
} from "./components/selection/SelectionContext";
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
  headerStatusOpen: {
    zIndex: 2000,
    pointerEvents: "none",
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
  const [isSharing, setIsSharing] = useState(false);
  const { clearSelection, selectedItems, selectionMode, setSelectionMode } =
    useSelectionContext();
  useSyncUrlWithFilter();

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
    <div className={styles.app}>
      <header
        className={mergeClasses(
          styles.header,
          isStatusOpen ? styles.headerStatusOpen : undefined,
        )}
      >
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
                disabled={
                  !canUseNativeShare ||
                  !supportsFileShare ||
                  selectedItems.length === 0 ||
                  isSharing
                }
              >
                {isSharing ? "Preparing…" : "Share"}
              </Button>
              <Button
                onClick={() => handleSelectionModeChange(false)}
                appearance="subtle"
              >
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
    <AuthGate>
      <FilterProvider>
        <SelectionProvider>
          <AppContent />
        </SelectionProvider>
      </FilterProvider>
    </AuthGate>
  );
}
