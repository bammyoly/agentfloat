// ---------------------------------------------------------------------------
// App entry. Bootstrap only — no components are defined or exported here.
//
// That constraint is load-bearing, not stylistic. vite-plugin-react's Fast
// Refresh requires a module to export only components; when it bails out it
// invalidates the module, and invalidating the ENTRY re-imports it. A second
// import of this file used to call createRoot() again on #root, mounting a
// second React tree over the first — which for Privy means a second
// PrivyProvider and a second iframe sharing one cross-window message queue:
//
//   Warning: You are calling ReactDOMClient.createRoot() on a container that
//            has already been passed to createRoot() before.
//   Uncaught Error: cannot dequeue privy:iframe:ready event: no event found
//
// Both are now prevented: components live in ./lib/SessionLayer.jsx and
// ./lib/app-data.jsx, and the root itself is memoised on the container.
//
// WHY THERE IS NO <React.StrictMode>
//   StrictMode deliberately mounts, unmounts and remounts every component in
//   development. PrivyProvider owns an iframe and an id-keyed event queue, and
//   the remount leaves the second instance waiting on an event the first
//   already consumed — the same `cannot dequeue privy:iframe:ready` failure,
//   with no second root involved. The login modal opens, spins, and vanishes.
//   StrictMode is a dev-only aid; the app is not worse without it, and Privy is
//   not usable with it. Re-enable it around <App/> only if Privy is unmounted
//   (no VITE_PRIVY_APP_ID) and you want the extra render checks back.
// ---------------------------------------------------------------------------

import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App.jsx";
import SessionLayer from "./lib/SessionLayer.jsx";

import "./index.css";

const container = document.getElementById("root");

// Memoised on the container so a re-executed entry module re-renders the
// existing root instead of creating a rival one.
if (!container.__agentfloatRoot) {
  container.__agentfloatRoot = createRoot(container);
}

container.__agentfloatRoot.render(
  <BrowserRouter>
    <SessionLayer>
      <App />
    </SessionLayer>
  </BrowserRouter>
);
