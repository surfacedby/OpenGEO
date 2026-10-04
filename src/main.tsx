import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./styles.css";
import "./workspace.css";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import identity from "../brand/identity.json";
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary fullScreen title={identity.name + " could not open this view"}>
    <App />
  </ErrorBoundary>,
);
