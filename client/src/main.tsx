import * as React from "react";
import * as ReactDOM from "react-dom/client";
import "./styles.css";
import App from "./App";
import { applyTheme, getInitialTheme } from "./theme";

applyTheme(getInitialTheme());

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
