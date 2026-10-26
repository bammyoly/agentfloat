// ---------------------------------------------------------------------------
// Reown AppKit transport: the Reown modal, WalletConnect, and any installed
// wallet AppKit lists — all funnelled into AgentFloat's SessionContext.
//
// WHAT THE USER GETS
//   One button opens AppKit's modal; they pick MetaMask, Rabby, WalletConnect
//   mobile, whatever. On connect, wallet-session.js reads the chain and asks
//   the wallet to move to Mezo testnet — switching if the chain is known,
//   adding it first (EIP-3085) if it is not. That is the requirement this
//   integration exists to satisfy.
//
// WHY open() IS NOT AWAITED FOR THE SESSION
//   AppKit's open() resolves when the modal opens, not when the user finishes
//   connecting. The session therefore tracks `useAppKitAccount()` reactively:
//   the navbar flips to the address the moment AppKit reports a connection,
//   which is also what makes a wallet connected in another tab just work.
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAppKit, useAppKitAccount, useAppKitProvider, useDisconnect } from "@reown/appkit/react";

import { SessionContext } from "./session.jsx";
import { rawEip1193, useWalletSession } from "./wallet-session.js";
import { assertChainFactsAgree } from "./evm-network.js";
import { initReown, mezoAppKitChain } from "./reown-init.js";
import { mezoTestnet } from "./mezo.js";
import { REOWN_PROJECT_ID } from "./wallet-choice.js";

// Module scope, on purpose: createAppKit() must run before any AppKit hook
// renders, exactly once, and only when this lazy chunk actually loads.
initReown(REOWN_PROJECT_ID);
assertChainFactsAgree(mezoTestnet);

export default function ReownBridge({ children }) {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider("eip155");
  const { disconnect } = useDisconnect();
  const [opened, setOpened] = useState(false);

  // walletProvider is an ethers provider with the EthersAdapter; what the
  // network logic needs is the EIP-1193 object underneath it.
  const raw = useMemo(() => rawEip1193(walletProvider), [walletProvider]);

  // The account hook lags the provider by a render on some wallets; prefer the
  // provider's own address when the hook has not caught up yet.
  const [providerAddress, setProviderAddress] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const acc = raw ? await raw.request({ method: "eth_accounts" }) : null;
        if (!cancelled) setProviderAddress(acc?.[0] || null);
      } catch {
        if (!cancelled) setProviderAddress(null);
      }
    })();
    return () => { cancelled = true; };
  }, [raw]);

  const account = address || (isConnected ? providerAddress : null) || providerAddress;

  const openConnect = useCallback(async () => {
    setOpened(true);
    await open();
    // The modal is open; the connection itself arrives through the hooks above.
    // Do not resolve early enough to flip the button back while AppKit is up.
  }, [open]);

  const value = useWalletSession({
    kind: "reown",
    address: account || null,
    raw,
    openConnect,
    disconnect: async () => { setOpened(false); await disconnect(); },
  });

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
