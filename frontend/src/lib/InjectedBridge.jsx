// ---------------------------------------------------------------------------
// Bare injected transport: window.ethereum, no vendor, no signup, no bundle.
//
// WHEN THIS RUNS
//   Reown AppKit needs a free Project ID from cloud.reown.com. Without one this
//   transport is the fallback, so `Sign in` still works on a machine with
//   MetaMask or Rabby and nothing else configured. It is also the transport to
//   use when debugging, because there is exactly one moving part.
//
// HONESTY ABOUT LOGOUT
//   EIP-1193 has no logout. "Sign out" here forgets the session in this tab;
//   the wallet stays authorised for the origin until the user revokes it in
//   the wallet's own settings. Saying otherwise would be a lie in the UI.
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useState } from "react";

import { SessionContext } from "./session.jsx";
import { useWalletSession } from "./wallet-session.js";
import { assertChainFactsAgree } from "./evm-network.js";
import { mezoTestnet } from "./mezo.js";

assertChainFactsAgree(mezoTestnet);

const injected = () => (typeof window !== "undefined" ? window.ethereum || null : null);

export default function InjectedBridge({ children }) {
  const [address, setAddress] = useState(null);
  const raw = injected();

  // Adopt a session the wallet already authorised on a previous visit, and keep
  // following it. eth_accounts is the non-prompting read; eth_requestAccounts
  // (in openConnect) is the one that asks.
  useEffect(() => {
    if (!raw) return;
    let cancelled = false;
    (async () => {
      try {
        const acc = await raw.request({ method: "eth_accounts" });
        if (!cancelled) setAddress(acc?.[0] || null);
      } catch {
        if (!cancelled) setAddress(null);
      }
    })();
    if (typeof raw.on !== "function") return () => {};
    const onAccounts = (acc) => setAddress(acc?.[0] || null);
    raw.on("accountsChanged", onAccounts);
    return () => { raw.removeListener?.("accountsChanged", onAccounts); };
  }, [raw]);

  const openConnect = useCallback(async () => {
    const p = injected();
    if (!p) {
      const err = new Error(
        "No injected wallet found. Install MetaMask or Rabby, or set " +
        "VITE_REOWN_PROJECT_ID to enable the Reown modal, which also offers " +
        "WalletConnect from a phone."
      );
      err.code = "no_injected_wallet";
      throw err;
    }
    const acc = await p.request({ method: "eth_requestAccounts" });
    if (acc?.[0]) setAddress(acc[0]);
  }, []);

  const disconnect = useCallback(async () => {
    setAddress(null);
  }, []);

  const value = useWalletSession({ kind: "injected", address, raw, openConnect, disconnect });

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
