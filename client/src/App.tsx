import {
  Button,
  Caption1,
  Divider,
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
import { SelectionProvider } from "./components/selection/SelectionContext";
import { useSyncUrlWithFilter } from "./hooks/useSyncUrlWithFilter";


const useStyles = makeStyles({
  app: {
    padding: tokens.spacingHorizontalXL,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalXL,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: tokens.spacingHorizontalM,
  },
});

const AppContent = () => {
  const styles = useStyles();
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  useSyncUrlWithFilter();
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div>
          <Title2>Photrix</Title2>
          <Caption1>A better way to view photos.</Caption1>
        </div>
        <Tooltip content="Server Status" relationship="description">
          <Button
            icon={<Info24Regular />}
            onClick={() => setIsStatusOpen(true)}
            appearance="subtle"
          >
            Status
          </Button>
        </Tooltip>
      </header>

      <StatusModal isOpen={isStatusOpen} onDismiss={() => setIsStatusOpen(false)} />

      <Divider />

      <Filter />

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
