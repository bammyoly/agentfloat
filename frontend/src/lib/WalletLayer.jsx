// ---------------------------------------------------------------------------
// Wallet layer: picks the external-wallet transport for this session.
//
// Both transports are lazy. That is not premature optimisation — it is the
// same lesson this project learned twice already (Privy, then x402): heavy SDK
// trees belong behind a dynamic import() or they end up in the main graph and
// in Vite's dep pre-bundler. Reown drags in WalletConnect's relay client; the
// injected transport drags in nothing, so a machine without a Project ID never
// even downloads AppKit.
//
// The chosen kind is resolved once per page load by lib/wallet-choice.js; the
// navbar and /diagnose report which one is live.
// ---------------------------------------------------------------------------

import React, { Suspense, lazy } from "react";

import { resolveWalletProvider } from "./wallet-choice.js";
import { BootScreen } from "./RingSpinner.jsx";

const ReownBridge = lazy(() => import("./ReownBridge.jsx"));
const InjectedBridge = lazy(() => import("./InjectedBridge.jsx"));

function Loading() {
  return <BootScreen />;
}

export default function WalletLayer({ children }) {
  const kind = resolveWalletProvider();

  if (kind === "reown") {
    // ReownBridge calls initReown() at its own module scope, so createAppKit()
    // runs exactly once and only when this chunk actually loads.
    return (
      <Suspense fallback={<Loading />}>
        <ReownBridge>{children}</ReownBridge>
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<Loading />}>
      <InjectedBridge>{children}</InjectedBridge>
    </Suspense>
  );
}
