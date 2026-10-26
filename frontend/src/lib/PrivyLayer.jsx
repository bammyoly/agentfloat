// ---------------------------------------------------------------------------
// Privy layer — loaded ONLY when VITE_PRIVY_APP_ID is configured.
//
// main.jsx pulls this in with a dynamic import(). That matters for two reasons:
//
//   1. Bundle/memory. Privy drags in WalletConnect, the MetaMask SDK and a
//      Solana tree — ~1.5GB of node_modules. Importing it statically made Vite's
//      esbuild dep pre-bundler get OOM-killed and made `vite build` exhaust the
//      heap. Keeping it in its own lazily-imported chunk means an app with no
//      App ID never touches it at all.
//   2. Hook safety. usePrivy/useWallets throw outside <PrivyProvider>. Provider
//      and bridge live in this one module, so they can never be separated.
//
// The session shape published here is identical to InertSessionProvider's, so no
// page needs a special case for "Privy is off".
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { PrivyProvider, usePrivy, useLogin, useWallets } from "@privy-io/react-auth";
import { BrowserProvider } from "ethers";

import { PRIVY_APP_ID, privyConfig, canSignX402 } from "./privy.js";
import { classifyAuthError } from "./auth-errors.js";
import { privyStructuralFault } from "./privy-dom.js";
import { MEZO_TESTNET_ID, parseChainId, ensureWalletChain, describeChainError } from "./evm-network.js";
import { SessionContext } from "./session.jsx";
import { TREASURY_ADDRESS, IS_DEPLOYED } from "../contracts/index.js";

function Bridge({ children }) {
  const { user, ready, authenticated, logout, getAccessToken, error: sdkError } = usePrivy();
  // `useWallets()` has its OWN readiness flag, separate from usePrivy()'s. Privy's
  // docs are explicit that wallet work must wait for both: usePrivy().ready means
  // the SDK initialized, useWallets().ready means the embedded-wallet proxy is up
  // and `wallets` is populated. Reading only the first is how you end up with a
  // "creating wallet…" spinner that never resolves — and it is also the documented
  // cause of `Wallet proxy not initialized`.
  const { wallets, ready: walletsReady } = useWallets();
  const [operatorSigner, setOperatorSigner] = useState(null);
  const [authenticating, setAuthenticating] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [networkBusy, setNetworkBusy] = useState(false);

  /**
   * Turn a Privy failure into everything the UI needs to say about it.
   *
   * THE PART THAT MATTERS: `exited_auth_flow` is Privy's code for BOTH "the person
   * closed the popup" and "the provider was torn down mid-handshake". Nothing in
   * the code string separates them, so the DOM probe does — mount counts, unmount
   * counts and iframe count, the same measurements /diagnose shows a human.
   *
   * Getting this wrong is not cosmetic. Treating a dismissal as a failure puts a red
   * alert and a console error in front of someone who clicked the X on purpose,
   * which is how people learn to ignore the alerts that matter.
   */
  const makeAuthError = useCallback((codeOrMessage, extra = {}) => {
    const code = String(codeOrMessage || "unknown");
    const { fault, reasons } = privyStructuralFault();
    const v = classifyAuthError(code, {
      structuralFault: fault,
      secureContext: typeof window === "undefined" ? true : Boolean(window.isSecureContext),
    });
    return {
      code,
      kind: v.kind,
      tone: v.tone,
      title: v.title,
      user: v.user,
      // `hint` keeps carrying the USER sentence, not the technical one: the toast
      // and /diagnose both already read this field, and a stale field name is far
      // cheaper than a stale field value. `dev` is the technical layer.
      hint: v.user,
      dev: v.dev,
      log: v.log,
      autoDismissMs: v.autoDismissMs,
      structuralFault: fault,
      structuralReasons: reasons,
      at: Date.now(),
      ...extra,
    };
  }, []);


  // WHY useLogin() INSTEAD OF usePrivy().login
  //   Both open the same modal, but usePrivy().login returns **void**. Every
  //   failure path — origin not allowlisted, login method disabled in the
  //   dashboard, iframe blocked, WebCrypto unavailable on an insecure context —
  //   therefore looks identical to the user: the button does nothing at all and
  //   the console says nothing useful. useLogin() takes onError/onComplete
  //   callbacks that receive a PrivyErrorCode, which turns a silent no-op into a
  //   named reason. That difference is the whole point of this hook.
  const { login } = useLogin({
    onError: (error) => {
      setAuthError(makeAuthError(error));
      setAuthenticating(false);
    },
    onComplete: ({ isNewUser, loginMethod }) => {
      setAuthError(null);
      setAuthenticating(false);
      if (isNewUser) {
        console.info(`[AgentFloat] new user via ${loginMethod} — Privy is creating the agent wallet.`);
      }
    },
  });

  // Both readiness flags must be true before a page trusts `wallets`.
  const sessionReady = ready && walletsReady;

  // MOUNT COUNTERS — the only reliable way to detect StrictMode from inside the
  // running app.
  //
  // StrictMode's dev behaviour is mount → unmount → remount, and a second React
  // root mounts a second provider outright. Both leave PrivyProvider constructed
  // more than once while only one instance survives, which strands the iframe's
  // id-keyed event queue and produces the "modal opens, loads, disappears"
  // symptom with no useful error. Neither is visible in the source at runtime, so
  // count it: healthy is exactly 1 mount and 0 unmounts. Anything else is
  // reported on /diagnose.
  useEffect(() => {
    window.__agentfloatBridgeMounts = (window.__agentfloatBridgeMounts || 0) + 1;
    return () => {
      window.__agentfloatBridgeUnmounts = (window.__agentfloatBridgeUnmounts || 0) + 1;
    };
  }, []);

  // The agent wallet is the embedded EOA. Privy reattaches the same one for the
  // same identity, which is what makes "created once, used on subsequent logins"
  // true without us storing any mapping ourselves.
  const agentWallet = useMemo(
    () => (walletsReady ? wallets.find((w) => canSignX402(w)) || null : null),
    [wallets, walletsReady]
  );

  // An EXTERNAL wallet (MetaMask) that is the treasury owner gets operator
  // powers. Detected by reading owner() off the contract, so nobody can claim
  // those controls by editing local state.
  const ownerCandidate = useMemo(() => {
    if (!IS_DEPLOYED || !TREASURY_ADDRESS) return null;
    return wallets.find((w) => w.walletClientType !== "privy") || null;
  }, [wallets]);

  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      if (!ownerCandidate) {
        if (!cancelled) setOperatorSigner(null);
        return;
      }
      try {
        const provider = await ownerCandidate.getEthereumProvider();
        const ethersProvider = new BrowserProvider(provider);
        const signer = await ethersProvider.getSigner();
        const addr = await signer.getAddress();
        const { treasuryRead } = await import("./chain.js");
        const t = treasuryRead();
        const owner = t ? await t.owner() : null;
        if (!cancelled) {
          setOperatorSigner(owner && owner.toLowerCase() === addr.toLowerCase() ? signer : null);
        }
      } catch {
        if (!cancelled) setOperatorSigner(null);
      }
    }
    resolve();
    return () => { cancelled = true; };
  }, [ownerCandidate, authenticated]);

  // -------------------------------------------------------------------------
  // NETWORK STATE — read, not assumed.
  //
  // This used to be hardcoded (`chainId: MEZO_TESTNET_ID`,
  // `chainOk: Boolean(agentWallet)`, `fixNetwork: async () => ({ wasOnChain:
  // true })`) on the theory that the embedded wallet is created on
  // privyConfig.defaultChain so it cannot be wrong. Two real cases broke that:
  //
  //   1. An OPERATOR signs in with MetaMask through the same modal. That wallet
  //      is an external wallet on whatever chain the extension happens to be on,
  //      and nothing here ever moved it.
  //   2. While the embedded wallet is still provisioning there is no agent
  //      wallet, so `chainOk` was false and the navbar offered "wrong network
  //      (31611) — switch to Mezo": a button whose handler resolved a fake
  //      success and changed nothing. Clicking it looked exactly like a broken
  //      button, which is what it was.
  //
  // So chainOk is now TRI-STATE: true / false / null (no wallet to ask yet).
  // Only a measured `false` earns a switch button.
  // -------------------------------------------------------------------------
  const chainWallet = useMemo(() => {
    if (agentWallet) return agentWallet;
    return wallets.find((w) => w.walletClientType !== "privy") || null;
  }, [agentWallet, wallets]);

  const chainId = useMemo(() => {
    const parsed = parseChainId(chainWallet?.chainId);
    if (parsed !== null) return parsed;
    // Some Privy builds leave `chainId` unset on the embedded wallet, which is
    // created on privyConfig.defaultChain (Mezo). Falling back to the configured
    // chain beats declaring a healthy wallet to be on the wrong network.
    return chainWallet?.walletClientType === "privy" ? MEZO_TESTNET_ID : null;
  }, [chainWallet]);

  const chainOk = chainWallet ? chainId === MEZO_TESTNET_ID : null;

  /**
   * Move the wallet that matters onto Mezo testnet.
   *
   * Delegates to ensureWalletChain(), which prefers Privy's own
   * `wallet.switchChain()` — the only route that works for an embedded wallet,
   * since there is no extension to prompt and the embedded provider does not
   * implement EIP-3085 — and falls back to switch/add through the provider for
   * external wallets. Failures land in authError so the navbar toast can name
   * the cause; a rejection is never retried behind the user's back.
   */
  const fixNetwork = useCallback(async () => {
    const target = agentWallet || wallets.find((w) => w.walletClientType !== "privy") || null;
    if (!target) {
      // Nothing to switch. Say so out loud instead of resolving a success that
      // changed nothing — that silence is the bug this replaces.
      setAuthError({
        code: "network_no_wallet",
        hint:
          "There is no wallet to switch yet. Privy creates your agent wallet right after sign-in; once it appears here the network is Mezo testnet by construction. If it has been more than a minute, sign out and back in.",
        at: Date.now(),
      });
      return { wasOnChain: false, switched: false, added: false, chainId: null };
    }
    setNetworkBusy(true);
    try {
      const result = await ensureWalletChain(target);
      setAuthError(null);
      return result;
    } catch (err) {
      setAuthError({
        code: `network_${String(err?.code ?? "error")}`,
        hint: describeChainError(err),
        at: Date.now(),
      });
      throw err;
    } finally {
      setNetworkBusy(false);
    }
  }, [agentWallet, wallets]);

  const signMessage = useCallback(async (message) => {
    if (!agentWallet) throw new Error("No agent wallet yet — finish signing in first.");
    const provider = await agentWallet.getEthereumProvider();
    return provider.request({ method: "personal_sign", params: [message, agentWallet.address] });
  }, [agentWallet]);

  const doLogin = useCallback(() => {
    // `login()` returns void, so there is nothing to await. Completion arrives
    // through the useLogin callbacks above. Clearing any previous error first
    // matters: a stale hint would otherwise sit under the button and describe a
    // failure that is no longer happening.
    setAuthError(null);
    setAuthenticating(true);
    login();
  }, [login]);

  // Privy publishes an SDK-level error (bad App ID, blocked iframe, failed
  // initialization) separately from the login flow. Surface it too — this is the
  // field that explains a modal that never opens at all, as opposed to one that
  // opens and then fails.
  useEffect(() => {
    if (!sdkError) return;
    setAuthenticating(false);
    setAuthError(
      makeAuthError(sdkError.name || sdkError.message, {
        detail: String(sdkError.message || "").slice(0, 240),
      })
    );
  }, [sdkError, makeAuthError]);

  // WATCHDOG. Privy exposes no modal-dismissed callback, so a user who opens the
  // modal and closes it without finishing would leave the button stuck on
  // "Opening…" forever. After a bounded wait we return the button to a clickable
  // state without inventing an error — nothing actually went wrong, the flow was
  // just abandoned.
  useEffect(() => {
    if (!authenticating) return;
    if (authenticated) { setAuthenticating(false); return; }
    const t = setTimeout(() => setAuthenticating(false), 25000);
    return () => clearTimeout(t);
  }, [authenticating, authenticated]);

  const value = useMemo(() => ({
    configured: true,
    // usePrivy().ready alone is not enough — see the walletsReady note above.
    ready: sessionReady,
    authenticating,
    user: authenticated ? user : null,
    agentWallet,
    agentAddress: agentWallet?.address || null,
    // A wallet sitting on another chain cannot settle a Mezo payment, so the
    // chain is part of the answer — but only a MEASURED wrong chain blocks it
    // (chainOk === null just means provisioning has not finished).
    canSignX402: Boolean(agentWallet) && chainOk !== false,
    isOperator: Boolean(operatorSigner),
    operatorSigner,
    externalWallets: wallets.filter((w) => w.walletClientType !== "privy"),
    login: doLogin,
    logout: async () => { setOperatorSigner(null); await logout(); },
    signMessage,
    getAccessToken,
    authError,
    clearAuthError: () => setAuthError(null),
    chainId,
    chainOk,
    networkBusy,
    fixNetwork,
    providerKind: "privy",
  }), [authenticating, user, authenticated, agentWallet, operatorSigner, wallets, doLogin, logout, signMessage, getAccessToken, sessionReady, authError, chainId, chainOk, networkBusy, fixNetwork]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export default function PrivyLayer({ children }) {
  return (
    <PrivyProvider appId={PRIVY_APP_ID} config={privyConfig}>
      <Bridge>{children}</Bridge>
    </PrivyProvider>
  );
}
