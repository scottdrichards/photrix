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
import { MapView } from "./MapView";
import { Filters } from "./filters/Filters";

const App = () => {
  const {filter, setFilter} = useFilter();
  const selectedDispatch = useSelectedDispatch();
  const [viewMode, setViewMode] = useState<'thumbnails' | 'map'>('thumbnails');

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
        
        <div style={{ marginTop: "10px" }}>
          <label style={{ marginRight: "10px" }}>
            <input
              type="radio"
              name="viewMode"
              checked={viewMode === 'thumbnails'}
              onChange={() => setViewMode('thumbnails')}
            />
            Thumbnails
          </label>
          <label>
            <input
              type="radio"
              name="viewMode"
              checked={viewMode === 'map'}
              onChange={() => setViewMode('map')}
            />
            Map
          </label>
        </div>
        
        <FolderExplorer/>
      </div>

      <Filters />
      {viewMode === 'thumbnails' ? (
        <>
          <ThumbnailViewer/>
          <Preview />
        </>
      ) : (
        <MapView />
      )}
    </div>
  );
};export default () => (
  <SelectedProvider>
    <FilterProvider>
      <App />
    </FilterProvider>
  </SelectedProvider>
);
