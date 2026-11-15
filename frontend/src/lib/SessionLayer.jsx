// ---------------------------------------------------------------------------
// Session layer — Wave 2: Reown and injected only. Privy removed.
// ---------------------------------------------------------------------------

import React, { Component, Suspense, lazy } from "react";
import { resolveWalletProvider } from "./wallet-choice.js";
import { InertSessionProvider } from "./session.jsx";
import { BootScreen } from "./RingSpinner.jsx";

const WalletLayer = lazy(() => import("./WalletLayer.jsx"));

export class SessionErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error("[AgentFloat] wallet provider failed; falling back to operator-wallet mode.", error);
    if (info?.componentStack) console.error(info.componentStack);
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <>
        <div className="border-b border-bad/30 bg-bad-dim px-4 py-2.5 text-[12.5px] leading-relaxed text-bad" role="alert">
          <strong>Sign-in unavailable.</strong> The wallet provider failed to load.
          <div className="mt-1 font-mono text-[11.5px] opacity-80">
            {String(error?.message || error).slice(0, 240)}
          </div>
        </div>
        <InertSessionProvider>{this.props.children}</InertSessionProvider>
      </>
    );
  }
}

export default function SessionLayer({ children }) {
  const kind = resolveWalletProvider();
  if (kind === "none") {
    return <InertSessionProvider>{children}</InertSessionProvider>;
  }
  return (
    <SessionErrorBoundary>
      <Suspense fallback={<BootScreen />}>
        <WalletLayer>{children}</WalletLayer>
      </Suspense>
    </SessionErrorBoundary>
  );
}