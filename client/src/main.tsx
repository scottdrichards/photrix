import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import * as React from "react";
import * as ReactDOM from "react-dom/client";
import "./styles.css";
import App from "./App";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    <FluentProvider theme={webLightTheme}>
      <App />
    </FluentProvider>
  </React.StrictMode>
);
