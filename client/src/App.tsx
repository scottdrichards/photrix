import { useEffect, useState } from "react";
import "./App.css";
import { FolderExplorer, Selected } from "./FolderExplorer";
import { ThumbnailViewer } from "./ThumbnailViewer";
import { Media } from "./Media";
import { useStyles } from "./App.styles";

function App() {
  const [selectedFolder, setSelectedFolder] = useState<Selected | null>(null);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [includeSubfolders, setIncludeSubfolders] = useState(false);

  const styles = useStyles();

  useEffect(() => {
    setSelectedImages([]);
  }, [selectedFolder]);

  return (
    <div
    className={styles.root}
    >
      <div
      className={styles.folderSelectionPanel}
      >
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
        selected={selectedImages}
        setSelected={setSelectedImages}
        directoryPath={selectedFolder?.fullPath}
        includeSubfolders={includeSubfolders}
      />
      <div
        className={styles.preview}
      >
        {selectedImages.map((image) => (
          <Media
            key={image}
            path={image}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ))}
      </div>
    </div>
  );
}

export default App;
