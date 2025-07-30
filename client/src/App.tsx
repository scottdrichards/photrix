import { useEffect, useState } from "react";
import "./App.css";
import { useStyles } from "./App.styles";
import { FolderExplorer } from "./FolderExplorer";
import { Media } from "./Media";
import { SelectedProvider, useSelected, useSelectedDispatch } from "./selectedContext";
import {ThumbnailViewer} from "./ThumbnailViewer";

const App = () => {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const selectedDispatch = useSelectedDispatch();
  const selected = useSelected();
  const [includeSubfolders, setIncludeSubfolders] = useState(false);

  const styles = useStyles();

  useEffect(() => {
    selectedDispatch({ type: 'clear' });
  }, [selectedFolder]);

  return (
      <div className={styles.root}>
        <div className={styles.folderSelectionPanel}>
          <label>
            <input
              type="checkbox"
              id="includeSubfolders"
              checked={includeSubfolders}
              onChange={(e) => setIncludeSubfolders(e.target.checked)}
            />
            Include Subfolders
          </label>
          <FolderExplorer
            onSelect={setSelectedFolder}
            selected={selectedFolder}
          />
        </div>
        <ThumbnailViewer
          directoryPath={selectedFolder}
          includeSubfolders={includeSubfolders}
          selectFolder={setSelectedFolder}
        />
        <div className={styles.preview}>
          {[...selected].map((image) => (
            <Media
              key={image}
              path={image}
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
              thumbnailBehavior={{ fetchPriority: "high", loading: "eager" }}
              fullSizeBehavior={{ fetchPriority: "high", loading: "eager" }}
            />
          ))}
        </div>
      </div>
  );
}

export default () => (
  <SelectedProvider>
    <App />
  </SelectedProvider>
);
