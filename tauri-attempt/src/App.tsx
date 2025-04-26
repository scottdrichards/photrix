import { useState } from "react";
import "./App.css";
import { FiltersComponent } from "./FiltersComponent";
import { Gallery } from "./Gallery";
import { Properties } from "./Properties";

function App() {
  const [filters, setFilters] = useState<{folder?:string}|{}>({});

  return (<div style={{ display: "grid", gridTemplateColumns: "1fr 3fr 1fr" }}>
    <FiltersComponent setFilters={setFilters} filters={filters} />
    <Gallery filters={filters}/>
    <Properties />
  </div>
  );
}

export default App;
