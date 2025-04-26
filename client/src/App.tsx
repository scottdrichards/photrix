import { useState } from "react";
import "./App.css";
import { FolderExplorer, Selected } from "./FolderExplorer";
import { ThumbnailViewer } from "./ThumbnailViewer";

function App() {
  const [selected, setSelected] = useState<Selected | null>(null);
  const [includeSubfolders, setIncludeSubfolders] = useState(false);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "max-content 1fr",
        gridTemplateRows: "100%",
        height: "100%",
        width: "100%",
      }}
    >
      <FolderExplorer
        onSelect={setSelected}
        style={{ height: "100%", overflowY: "auto" }}
      />
      <ThumbnailViewer
        directoryPath={selected?.fullPath}
        includeSubfolders={true}
        style={{ height: "100%", overflowY: "auto" }}
      />
    </div>
  );
}

export default App;
