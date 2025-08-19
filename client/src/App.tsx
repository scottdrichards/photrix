import { useEffect, useState } from "react";
import "./App.css";
import { useStyles } from "./App.styles";
import { FolderExplorer } from "./FolderExplorer";
import {
  SelectedProvider,
  useSelectedDispatch,
} from "./contexts/selectedContext";
import { ThumbnailViewer } from "./ThumbnailViewer";
import { FilterProvider, useFilter } from "./contexts/filterContext";
import { Preview } from "./Preview";
import { Filters } from "./filters/Filters";

const App = () => {
  const {filter, setFilter} = useFilter();
  const selectedDispatch = useSelectedDispatch();

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

      <Filters />
      <ThumbnailViewer/>
      <Preview />
    </div>
  );
};export default () => (
  <SelectedProvider>
    <FilterProvider>
      <App />
    </FilterProvider>
  </SelectedProvider>
);
