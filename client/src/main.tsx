import * as React from "react";
import * as ReactDOM from "react-dom/client";
import "./styles.css";
import App from "./App";
import { applyTheme, getInitialTheme } from "./theme";
import { initInstall, registerServiceWorker } from "./install";

applyTheme(getInitialTheme());

// Installable as an app (PWA). The service worker only runs in production builds:
// under the Vite dev server it would intercept dev navigations for no benefit.
initInstall();
if (import.meta.env.PROD) registerServiceWorker();

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
