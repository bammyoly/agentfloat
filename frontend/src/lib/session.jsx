// ---------------------------------------------------------------------------
// Wallet session.
//
// One abstraction over "who is signed in and what can they sign", so the navbar
// and pages never import Privy directly. Two reasons that matters:
//
//   1. Bundle weight. Privy drags in WalletConnect, the MetaMask SDK and a
//      Solana tree. Importing it from a module the whole app depends on put all
//      of that in the main graph — enough to OOM Vite's dep pre-bundler. So the
//      Privy implementation lives in ./PrivyLayer.jsx, which main.jsx loads with
//      a dynamic import() only when an App ID is configured.
//   2. Privy's hooks throw outside <PrivyProvider>. With the provider mounted
//      conditionally, pages must not call those hooks at all — they consume this
//      context, whose shape is identical whether Privy is on or off.
//
// The two wallet roles, which the whole multi-user design turns on:
//
//   AGENT     every signed-in user's own embedded EOA. Receives faucet MUSD and
//             signs x402 payments. Created once by Privy, reattached on later
//             logins, so the address and balance persist per identity.
//
//   OPERATOR  the treasury owner. Only this wallet can register agents, release
//             float, change caps or pause. Detected by comparing the connected
//             address to treasury.owner() on chain — never granted by a toggle.
// ---------------------------------------------------------------------------

import React, { createContext, useContext, useMemo } from "react";

/** Published by PrivyLayer when configured, by InertSessionProvider when not. */
export const SessionContext = createContext(null);

export const useSession = () => useContext(SessionContext);

/**
 * Fallback used when VITE_PRIVY_APP_ID is absent. Every field is inert but the
 * shape matches PrivyLayer's exactly, so no page needs a special case.
 */
export function InertSessionProvider({ children }) {
  const value = useMemo(
    () => ({
      configured: false,
      ready: true,
      authenticating: false,
      user: null,
      agentWallet: null,
      agentAddress: null,
      canSignX402: false,
      isOperator: false,
      operatorSigner: null,
      externalWallets: [],
      login: async () => {},
      logout: async () => {},
      // Shape parity with PrivyLayer: pages and the navbar read these without
      // checking which provider is mounted, so both must expose them.
      authError: null,
      clearAuthError: () => {},
      chainId: null,
      // null, not false: "no wallet to ask" is not "wallet on the wrong chain".
      // A false here would put a switch button in the navbar that can never do
      // anything, because there is no provider configured to switch.
      chainOk: null,
      networkBusy: false,
      fixNetwork: async () => ({ wasOnChain: false, switched: false, added: false }),
      providerKind: "none",
      signMessage: async () => {
        throw new Error("Privy is not configured — set VITE_PRIVY_APP_ID to enable signing in.");
      },
      getAccessToken: async () => null,
    }),
    []
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
