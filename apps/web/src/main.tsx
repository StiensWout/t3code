import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const app = <AppRoot router={router} />;

// Managed auth is cloud-only, and the Electron Clerk provider bundles the full
// clerk-js runtime. Lazily loading only the selected runtime keeps every Clerk
// byte out of the startup graph for local-mode users, and keeps the bundled
// clerk-js out of the browser build entirely.
const ManagedAuthShell = React.lazy(() =>
  isElectron
    ? import("./components/clerk/ElectronManagedAuthShell")
    : import("./components/clerk/BrowserManagedAuthShell"),
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {clerkPublishableKey && hasCloudPublicConfig() ? (
      <React.Suspense fallback={null}>
        <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
      </React.Suspense>
    ) : (
      app
    )}
  </React.StrictMode>,
);
