
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
