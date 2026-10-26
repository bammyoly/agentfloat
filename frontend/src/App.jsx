// ---------------------------------------------------------------------------
// App shell: routes, guards, and the global banners.
//
// This module exports ONLY components. vite-plugin-react's Fast Refresh bails
// out on a module that mixes components with other exports, and the resulting
// `hmr invalidate` used to cascade into a second createRoot() — see main.jsx.
// The data provider and its hook live in ./lib/app-data.jsx for that reason.
//
// Navigation model
//   signed out  →  the marketing surface: Home, How it works, Protocol
//   signed in   →  the product: Dashboard, Spend, Ledger, Alerts, Faucet, Operate
//   a fresh interactive sign-in redirects to /dashboard
//   a RESTORED session does not — reopening the app on /faucet stays on /faucet
// ---------------------------------------------------------------------------

import React, { useEffect, useRef } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";

import Navbar from "./components/Navbar.jsx";
import { useSession } from "./lib/session.jsx";
import { AppDataProvider, useAppData } from "./lib/app-data.jsx";
import { useRevealObserver, useHashScroll } from "./lib/useReveal.jsx";

import Home from "./pages/Home.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Spend from "./pages/Spend.jsx";
import Ledger from "./pages/Ledger.jsx";
import Faucet from "./pages/Faucet.jsx";
import Operate from "./pages/Operate.jsx";
import Alerts from "./pages/Alerts.jsx";
import Architecture from "./pages/Architecture.jsx";
import Diagnose from "./pages/Diagnose.jsx";

/**
 * Browsers restrict WebCrypto (`crypto.randomUUID`, `crypto.subtle`) and injected
 * wallet APIs to SECURE CONTEXTS: HTTPS, or http://localhost / 127.0.0.1.
 *
 * `npm run dev:lan` binds 0.0.0.0 and Vite then prints a Network URL like
 * http://192.168.1.x:5173. Opening that breaks Privy and wallet extensions with
 * errors such as `crypto.randomUUID is not a function`, which look like app bugs
 * and are not. `npm run dev` binds 127.0.0.1 to make the safe URL the obvious one.
 */
function InsecureContextWarning() {
  if (typeof window === "undefined" || window.isSecureContext) return null;
  const host = window.location.hostname;
  return (
    <div className="border-b border-warn/30 bg-warn-dim px-4 py-2.5 text-[12.5px] leading-relaxed text-warn">
      <strong>Not a secure context.</strong> This page is served over plain HTTP from{" "}
      <span className="font-mono">{host}</span>, so the browser disables WebCrypto and injected
      wallet APIs — sign-in and wallet extensions will fail here (commonly{" "}
      <span className="font-mono">crypto.randomUUID is not a function</span>). Open{" "}
      <a className="font-mono underline decoration-warn/50 underline-offset-2" href="http://localhost:5173/">
        http://localhost:5173/
      </a>{" "}
      on this machine instead. Read-only pages below still work.
    </div>
  );
}

/**
 * Sends a user to the dashboard the moment they finish signing in — but only for
 * an INTERACTIVE sign-in.
 *
 * Privy restores a previous session asynchronously after `ready`. Redirecting on
 * any appearance of `user` would yank a returning visitor off whatever deep link
 * they opened, so we wait until we have observed `ready && !user` at least once.
 * That state only occurs when nobody was signed in, i.e. the login was fresh.
 */
function PostLoginRedirect() {
  const session = useSession();
  const navigate = useNavigate();
  const sawSignedOut = useRef(false);

  useEffect(() => {
    if (!session.ready) return;
    if (!session.user) {
      sawSignedOut.current = true;
      return;
    }
    if (sawSignedOut.current) {
      sawSignedOut.current = false;
      navigate("/dashboard", { replace: true });
    }
  }, [session.ready, session.user, navigate]);

  return null;
}

/**
 * Gate for the product pages.
 *
 * Deliberately permissive when Privy is NOT configured: in operator-wallet mode
 * there is no sign-in to require, and blocking would make the app unusable. The
 * on-chain owner check in app-data still decides who may actually transact, so
 * this is navigation hygiene, not authorization.
 */
function RequireSession({ children }) {
  const session = useSession();
  const { operator } = useAppData();
  const allowed = Boolean(session.user) || !session.configured || operator.isOwner;
  if (!allowed) return <Navigate to="/" replace />;
  return children;
}

function Footer() {
  return (
    <footer className="mt-auto border-t border-line-soft">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 px-5 py-6 text-[11.5px] text-dim">
        <span>
          <span className="font-semibold text-muted">AgentFloat</span> · budget-controlled MUSD for
          AI agents
        </span>
        <span className="font-mono">
          Mezo Buildathon Wave 1 · Track 2 (Access &amp; Distribution) · eip155:31611
        </span>
      </div>
    </footer>
  );
}

function Shell() {
  const { health } = useAppData();
  const location = useLocation();

  // Installs the single IntersectionObserver that drives every .reveal element,
  // and scrolls to /#how-it-works when the navbar link is used while already on
  // the landing page (a hash-only change remounts nothing).
  useRevealObserver();
  useHashScroll([location.pathname, location.hash]);

  return (
    <div className="flex min-h-full flex-col">
      <InsecureContextWarning />
      <Navbar health={health} />
      <PostLoginRedirect />
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-5 py-7">
        <Routes>
          {/* public / marketing surface */}
          <Route path="/" element={<Home />} />
          <Route path="/architecture" element={<Architecture />} />
          {/* Public on purpose — this page is only interesting when sign-in is broken. */}
          <Route path="/diagnose" element={<Diagnose />} />

          {/* product — requires a session once Privy is configured */}
          <Route path="/dashboard" element={<RequireSession><Dashboard /></RequireSession>} />
          <Route path="/spend" element={<RequireSession><Spend /></RequireSession>} />
          <Route path="/ledger" element={<RequireSession><Ledger /></RequireSession>} />
          <Route path="/faucet" element={<RequireSession><Faucet /></RequireSession>} />
          <Route path="/alerts" element={<RequireSession><Alerts /></RequireSession>} />
          <Route path="/operate" element={<RequireSession><Operate /></RequireSession>} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}

export default function App() {
  return (
    <AppDataProvider>
      <Shell />
    </AppDataProvider>
  );
}
