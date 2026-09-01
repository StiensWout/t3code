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

// With split chunks, a deploy (or desktop server swap) between page load and a
// lazy fetch can 404 the old hashed assets. Reload once to pick up the fresh
// index.html; the guard keeps a persistent failure from becoming a reload loop
// and instead lets the error surface through the normal paths.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded";
const readChunkReloadGuard = () => {
  // Blocked storage degrades to reloading on every chunk failure, which is
  // still better than stranding the page.
  try {
    return window.sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY) === "1";
  } catch {
    return false;
  }
};
const writeChunkReloadGuard = (reloaded: boolean) => {
  try {
    if (reloaded) {
      window.sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, "1");
    } else {
      window.sessionStorage.removeItem(CHUNK_RELOAD_GUARD_KEY);
    }
  } catch {
    // See readChunkReloadGuard.
  }
};
window.addEventListener("vite:preloadError", (event) => {
  if (readChunkReloadGuard()) {
    return;
  }
  writeChunkReloadGuard(true);
  event.preventDefault();
  window.location.reload();
});

const app = <AppRoot router={router} />;

// Managed auth is cloud-only, and the Electron Clerk provider bundles the full
// clerk-js runtime. Loading only the selected runtime as a split chunk keeps
// every Clerk byte out of the startup graph for local-mode users, and keeps
// the bundled clerk-js out of the browser build entirely.
const managedAuthShellModule =
  clerkPublishableKey && hasCloudPublicConfig()
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

// The index.html boot splash lives inside #root, and React's first commit
// clears it. Resolve everything that first commit needs — the selected
// managed-auth runtime and the initial route's split chunks — before
// rendering, so the splash holds until real UI paints instead of dropping to
// a blank window while chunks download.
void Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  router.load(),
]).then(([ManagedAuthShell]) => {
  writeChunkReloadGuard(false);
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {ManagedAuthShell && clerkPublishableKey ? (
        <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
      ) : (
        app
      )}
    </React.StrictMode>,
  );
});
