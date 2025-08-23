import "./App.css";
import { useStyles } from "./App.styles";
import { Preview } from "./Preview";
import { ThumbnailViewer } from "./ThumbnailViewer";
import { FilterProvider } from "./contexts/filterContext";
import {
  SelectedProvider
} from "./contexts/selectedContext";
import { Filters } from "./filters/Filters";

const App = () => {

  const styles = useStyles();

  return (
    <div
      className={styles.root}
      style={{
        "backgroundImage": "linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)"
      }}
    >
      <Filters />
      <ThumbnailViewer/>
      <Preview />
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
