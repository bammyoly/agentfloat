// ---------------------------------------------------------------------------
// Session layer: decides which wallet session the app gets, and contains Privy
// failures so they cannot take the product down.
//
// WHY THIS IS ITS OWN MODULE (and not in main.jsx)
//   main.jsx is the entry. Defining components in it made vite-plugin-react's
//   Fast Refresh bail out ("Could not Fast Refresh"), which cascaded into a full
//   re-import of the entry — and a second createRoot() on the same container.
//   Two React roots means two PrivyProviders, two iframes, and a corrupted
//   cross-window message queue:
//     Uncaught Error: cannot dequeue privy:iframe:ready event: no event found
//   The entry module now contains nothing but the bootstrap.
//
// THE ERROR BOUNDARY
//   Privy is the only part of this app that can fail for reasons entirely outside
//   our code: a bad App ID, an origin not allowlisted in the Privy dashboard, an
//   offline auth API, a wallet extension interfering with WebCrypto. The
//   dashboard, ledger, spend and faucet pages need none of it, so a failure
//   degrades to operator-wallet mode behind a banner instead of white-screening.
// ---------------------------------------------------------------------------

import React, { Component, Suspense, lazy } from "react";

import { IS_PRIVY_CONFIGURED } from "./privy.js";
import { resolveWalletProvider } from "./wallet-choice.js";
import { InertSessionProvider } from "./session.jsx";
import { BootScreen } from "./RingSpinner.jsx";

// Resolved only when an App ID is configured — see the guard below. Keeping this
// a dynamic import() is also what keeps WalletConnect, the MetaMask SDK and a
// Solana tree out of the initial bundle.
const PrivyLayer = lazy(() => import("./PrivyLayer.jsx"));
const WalletLayer = lazy(() => import("./WalletLayer.jsx"));

export class SessionErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the real cause in the console — the banner is deliberately short.
    console.error("[AgentFloat] wallet provider failed; falling back to operator-wallet mode.", error);
    if (info && info.componentStack) console.error(info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const msg = String(error && (error.message || error)).slice(0, 240);
    return (
      <>
        <div className="border-b border-bad/30 bg-bad-dim px-4 py-2.5 text-[12.5px] leading-relaxed text-bad" role="alert">
          <strong>Sign-in unavailable.</strong> The wallet provider failed to load, so AgentFloat is
          running in operator-wallet mode — the dashboard, ledger, spend and faucet pages all still work.
          <div className="mt-1 font-mono text-[11.5px] opacity-80">{msg}</div>
          {typeof window !== "undefined" && !window.isSecureContext && (
            <div className="mt-1.5">
              This page is not a <em>secure context</em>. The browser disables WebCrypto and injected
              wallet APIs on plain HTTP over a LAN IP — open{" "}
              <span className="font-mono">http://localhost:5173/</span> instead.
            </div>
          )}
        </div>
        <InertSessionProvider>{this.props.children}</InertSessionProvider>
      </>
    );
  }
}

export default function SessionLayer({ children }) {
  // The provider is chosen once per page load by lib/wallet-choice.js: an
  // external wallet (Reown or injected) when one can actually work, Privy when
  // it cannot, inert when nothing is configured. See that file for the order
  // and for the VITE_WALLET_PROVIDER override.
  const kind = resolveWalletProvider();
  if (kind === "none") {
    return <InertSessionProvider>{children}</InertSessionProvider>;
  }
  const Layer = kind === "privy" ? PrivyLayer : WalletLayer;

  // The fallback is the ring and nothing else — see lib/RingSpinner.jsx. The
  // provider-specific explanation (Google sign-in is slower the first time while
  // Privy creates the wallet) belongs on the sign-in surface, where the user can
  // act on it, not on a first paint they are waiting through.
  return (
    <SessionErrorBoundary>
      <Suspense fallback={<BootScreen />}>
        <Layer>{children}</Layer>
      </Suspense>
    </SessionErrorBoundary>
  );
}
