// ---------------------------------------------------------------------------
// Shared session logic for non-Privy wallets (Reown AppKit and bare injected).
//
// THE SHAPE IS THE CONTRACT
//   Everything downstream — navbar, pages, the x402 payer — reads
//   SessionContext and never asks which provider produced it. PrivyLayer
//   publishes that shape; so does InertSessionProvider; so must these bridges.
//   Adding a wallet provider to AgentFloat is therefore *only* writing one of
//   these bridges; nothing else in the app changes.
//
// WHY A PRIVY-SHAPED WALLET SHIM
//   `lib/x402-browser.js` builds its viem payer from `wallet.address` and
//   `await wallet.getEthereumProvider()`. Those two members are all it touches,
//   so an injected wallet wearing that shape routes permit2 signing through
//   MetaMask (or any EIP-1193 wallet) with no change to the payer at all.
//
// THE NETWORK REQUIREMENT
//   AgentFloat only exists on Mezo testnet. A connected wallet on Ethereum
//   mainnet is useless here, so on connect — and on demand via the navbar badge
//   — we call ensureChain(): switch if the chain is known, add it (EIP-3085)
//   and switch if it is not. A rejection is the user's answer and is surfaced,
//   never retried silently.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider } from "ethers";

import { MEZO_TESTNET_ID, describeChainError, ensureChain, parseChainId, sameChainId } from "./evm-network.js";
import { TREASURY_ADDRESS, IS_DEPLOYED } from "../contracts/index.js";

/**
 * Minimal stand-in for a Privy wallet object.
 * @param getEip1193 returns the live EIP-1193 provider; a function because the
 *   underlying provider object is replaced when the wallet switches accounts.
 */
export function makeWalletShim(address, getEip1193, kind) {
  return {
    address,
    // Deliberately NOT "privy": canSignX402() accepts a small allowlist of EOA
    // kinds, and keeping the kind honest means the ledger and the UI can say
    // where a signature came from.
    walletClientType: kind,
    getEthereumProvider: async () => getEip1193(),
  };
}

/** The underlying EIP-1193 object behind an ethers BrowserProvider. */
export function rawEip1193(ethersProvider) {
  if (ethersProvider && typeof ethersProvider.provider?.request === "function") return ethersProvider.provider;
  if (ethersProvider && typeof ethersProvider.request === "function") return ethersProvider;
  if (typeof window !== "undefined" && window.ethereum) return window.ethereum;
  return null;
}

/** Wrap a raw EIP-1193 provider as an ethers BrowserProvider, tolerantly. */
export function toBrowserProvider(raw) {
  if (!raw) return null;
  if (raw instanceof BrowserProvider) return raw;
  try {
    // "any" disables ethers' own chain-change guard: we manage chain changes
    // ourselves and want events, not thrown errors, when the wallet moves.
    return new BrowserProvider(raw, "any");
  } catch {
    return null;
  }
}

/**
 * Build the SessionContext value for a connected external wallet.
 *
 * @param kind        "injected" | "reown"
 * @param address     connected account, or null
 * @param raw         live EIP-1193 provider, or null
 * @param openConnect opens the provider's connect UI
 * @param disconnect  provider logout
 */
export function useWalletSession({ kind, address, raw, openConnect, disconnect }) {
  const [authenticating, setAuthenticating] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [chainId, setChainId] = useState(null);
  // Tri-state: null = nothing connected yet, so there is no chain to be wrong
  // about. The navbar only offers a switch button on a measured `false`.
  const [chainOk, setChainOk] = useState(null);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [operatorSigner, setOperatorSigner] = useState(null);

  // --- network: switch / add on connect and whenever the wallet moves -------
  const fixNetwork = useCallback(async () => {
    if (!raw) return { wasOnChain: false, switched: false, added: false };
    setNetworkBusy(true);
    try {
      const result = await ensureChain(raw);
      setChainId(result.chainId);
      setChainOk(true);
      setAuthError(null);
      return result;
    } catch (err) {
      setChainOk(false);
      setAuthError({
        code: `network_${String(err?.code ?? "error")}`,
        hint: describeChainError(err),
        at: Date.now(),
      });
      throw err;
    } finally {
      setNetworkBusy(false);
    }
  }, [raw]);

  // Read the chain on connect; adopt it if already correct, otherwise ask the
  // wallet to move. Done in an effect (not inside login) so a wallet that was
  // already connected on a previous visit gets fixed on page load too.
  useEffect(() => {
    if (!raw || !address) { setChainId(null); setChainOk(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const current = await raw.request({ method: "eth_chainId" });
        if (cancelled) return;
        setChainId(parseChainId(current));
        if (sameChainId(current, MEZO_TESTNET_ID)) { setChainOk(true); return; }
        await fixNetwork();
      } catch {
        // Could not read the chain at all. Unknown, not wrong: claiming "wrong
        // network" here would offer a switch button for a wallet that may be
        // perfectly fine, and the switch itself would fail the same way.
        if (!cancelled) setChainOk(null);
      }
    })();
    return () => { cancelled = true; };
  }, [raw, address, fixNetwork]);

  // Follow the wallet if the user changes network or account by hand.
  useEffect(() => {
    if (!raw?.on) return;
    const onChain = (value) => {
      setChainId(parseChainId(value));
      setChainOk(sameChainId(value, MEZO_TESTNET_ID));
    };
    raw.on("chainChanged", onChain);
    return () => { raw.removeListener?.("chainChanged", onChain); };
  }, [raw]);

  // --- operator detection: identical rule to the Privy path -----------------
  // The treasury owner is whoever the contract says it is. Never a toggle.
  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      if (!address || !IS_DEPLOYED || !TREASURY_ADDRESS) {
        if (!cancelled) setOperatorSigner(null);
        return;
      }
      try {
        const bp = toBrowserProvider(raw);
        const signer = bp ? await bp.getSigner() : null;
        const addr = signer ? await signer.getAddress() : null;
        const { treasuryRead } = await import("./chain.js");
        const t = treasuryRead();
        const owner = t ? await t.owner() : null;
        if (!cancelled) setOperatorSigner(owner && addr && owner.toLowerCase() === addr.toLowerCase() ? signer : null);
      } catch {
        if (!cancelled) setOperatorSigner(null);
      }
    }
    resolve();
    return () => { cancelled = true; };
  }, [address, raw]);

  const signMessage = useCallback(async (message) => {
    if (!raw || !address) throw new Error("No wallet connected — sign in first.");
    return raw.request({ method: "personal_sign", params: [message, address] });
  }, [raw, address]);

  const login = useCallback(async () => {
    setAuthError(null);
    setAuthenticating(true);
    try {
      await openConnect();
    } catch (err) {
      setAuthError({
        code: String(err?.code ?? err?.name ?? "connect_failed"),
        hint:
          err?.code === 4001
            ? "The connection request was rejected in the wallet. Click Sign in again when ready."
            : `The wallet could not connect: ${String(err?.message || err).slice(0, 200)}`,
        at: Date.now(),
      });
    } finally {
      setAuthenticating(false);
    }
  }, [openConnect]);

  const wallet = useMemo(
    () => (address ? makeWalletShim(address, () => raw, kind) : null),
    [address, raw, kind]
  );

  const value = useMemo(() => ({
    configured: true,
    ready: true,
    authenticating,
    user: address ? { id: `eip155:${address}`, connectedWallet: true } : null,
    // The connected wallet IS the agent wallet on this path: it is an EOA the
    // user already controls, the faucet funds it, and it signs permit2 itself.
    agentWallet: wallet,
    agentAddress: address || null,
    // Strict on this path, unlike the Privy one: an injected wallet really can
    // be pointed at mainnet, and a permit2 signature meant for Mezo would be
    // presented to a wallet the user believes is elsewhere. Unknown (null) is
    // treated as not-yet-signable and resolves on the first chain read.
    canSignX402: Boolean(wallet) && chainOk === true,
    isOperator: Boolean(operatorSigner),
    operatorSigner,
    externalWallets: wallet ? [wallet] : [],
    login,
    logout: async () => { setOperatorSigner(null); await disconnect?.(); },
    signMessage,
    getAccessToken: async () => null,
    authError,
    clearAuthError: () => setAuthError(null),
    chainId,
    chainOk,
    networkBusy,
    fixNetwork,
    providerKind: kind,
  }), [authenticating, address, wallet, chainOk, chainId, networkBusy, operatorSigner, login, disconnect, signMessage, authError, fixNetwork, kind]);

  return value;
}
