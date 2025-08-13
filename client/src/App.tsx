import { useEffect, useState } from "react";
import "./App.css";
import { useStyles } from "./App.styles";
import { FolderExplorer } from "./FolderExplorer";
import { Media } from "./Media";
import {
  SelectedProvider,
  useSelected,
  useSelectedDispatch,
} from "./contexts/selectedContext";
import { ThumbnailViewer } from "./ThumbnailViewer";
import { FilterProvider, useFilter } from "./contexts/filterContext";

const App = () => {
  const {filter, setFilter} = useFilter();
  const selectedDispatch = useSelectedDispatch();
  const selected = useSelected();

  const styles = useStyles();

  useEffect(() => {
    selectedDispatch({ type: "clear" });
  }, [filter.parentFolder]);
  console.log(JSON.stringify(filter));

  return (
    <div
      className={styles.root}
      style={{
        "backgroundImage": "linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)"
      }}
    >
      <div className={styles.folderSelectionPanel}>
        <label>
          <input
            type="checkbox"
            id="includeSubfolders"
            checked={!filter.excludeSubfolders}
            onChange={(e) => setFilter({...filter, excludeSubfolders: !e.target.checked})}
          />
          Include Subfolders
        </label>
        <FolderExplorer/>
      </div>
      <ThumbnailViewer/>
      <div className={styles.preview}>
        {[...selected].map((image) => (
          <Media
            key={image}
            path={image}
            style={{ objectFit: "contain", width: "100%", height: "100%" }}
            thumbnailBehavior={{ fetchPriority: "high", loading: "eager" }}
            fullSizeBehavior={{ fetchPriority: "high", loading: "eager" }}
          />
        ))}
      </div>
    </div>
  );
};

export default () => (
  <SelectedProvider>
    <FilterProvider>
      <App />
    </FilterProvider>
  </SelectedProvider>
);
