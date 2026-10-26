// ---------------------------------------------------------------------------
// EVM network plumbing for injected / Reown wallets.
//
// WHY THIS IS ITS OWN MODULE, WITH NO IMPORTS
//   The requirement is behavioural: when a connected wallet is not on Mezo
//   testnet, ask it to switch; when it does not know the chain at all, add it
//   first and then switch. That is three RPC calls with wallet-specific error
//   codes, and it is exactly the kind of logic that silently rots if it lives
//   inside a React component. Kept import-free, it can be unit tested in plain
//   Node against a fake provider — which is how this file is verified, since
//   there is no browser here to click MetaMask in.
//
//   Chain facts are duplicated from src/contracts/chain.json on purpose. That
//   file is a deploy artifact imported as JSON, which plain Node cannot load,
//   and a unit-testable module must not drag the artifact graph in with it.
//   `assertChainFactsAgree()` below is the guard: the wallet bridges call it at
//   startup and warn if the two sources ever drift.
// ---------------------------------------------------------------------------

/** Mezo testnet, chain id 31611. */
export const MEZO_TESTNET_ID = 31611;

/** `wallet_switchEthereumChain` / `eth_chainId` speak hex. 31611 === 0x7b7b. */
export const MEZO_TESTNET_HEX = "0x7b7b";

/**
 * Privy publishes a wallet's chain in CAIP-2 (`eip155:31611`); EIP-1193
 * publishes hex (`0x7b7b`). Both spellings of the same chain live here so
 * neither caller has to invent a conversion.
 */
export const MEZO_TESTNET_CAIP2 = `eip155:${MEZO_TESTNET_ID}`;

/** Payload for `wallet_addEthereumChain` (EIP-3085). */
export const MEZO_TESTNET_ADD_PARAMS = {
  chainId: MEZO_TESTNET_HEX,
  chainName: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: ["https://rpc.test.mezo.org"],
  blockExplorerUrls: ["https://explorer.test.mezo.org"],
};

/**
 * Tolerant chain-id parser.
 *
 * Every layer in the stack spells a chain id differently: Privy's wallet object
 * carries CAIP-2 (`eip155:31611`), `eth_chainId` carries hex (`0x7b7b`), Reown
 * and ethers hand back numbers, and some connectors stringify. Unparseable input
 * becomes **null**, never NaN and never 0, so a caller can tell "I could not
 * read the chain" apart from "the chain is wrong" — a distinction the navbar
 * depends on, because only the second one deserves a switch button.
 */
export function parseChainId(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "bigint") return Number(value);
  const raw = String(value).trim();
  // CAIP-2: take the reference after the colon, and reject a non-EVM namespace.
  if (raw.includes(":")) {
    const [namespace, reference] = raw.split(":");
    if (namespace && namespace !== "eip155") return null;
    return parseChainId(reference);
  }
  const n = /^0x/i.test(raw) ? parseInt(raw, 16) : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Wallets disagree about how to normalise a chain id, so compare numerically.
 * Accepts `eip155:31611`, `0x7b7b`, `31611`, `"31611"` and `"0x7B7B"` alike.
 * Unknown on either side is NOT equal — never guess that a chain matches.
 */
export function sameChainId(a, b) {
  const x = parseChainId(a);
  const y = parseChainId(b);
  return x !== null && y !== null && x === y;
}

/** Ask a provider what chain it is on. null when it cannot or will not say. */
export async function readChainId(eip1193) {
  if (!eip1193 || typeof eip1193.request !== "function") return null;
  try {
    return parseChainId(await eip1193.request({ method: "eth_chainId" }));
  } catch {
    return null;
  }
}

export function toHexChainId(id) {
  return `0x${Number(id).toString(16)}`;
}

/** The wallet-specific error code that means "I have never heard of this chain". */
export const UNRECOGNIZED_CHAIN = 4902;

/** Some wallets report an unrecognized chain as a generic internal error. */
const GENERIC_INTERNAL = -32603;

export function chainErrorCode(err) {
  return err?.code ?? err?.error?.code ?? err?.data?.originalError?.code ?? null;
}

/** True when the wallet said "unknown chain" rather than "user refused". */
export function isUnrecognizedChain(err) {
  const code = chainErrorCode(err);
  if (code === UNRECOGNIZED_CHAIN) return true;
  // MetaMask sometimes wraps the 4902 in a -32603 with a message; trust the
  // message only when the code is the generic one, so a plain refusal is never
  // mistaken for a missing chain and we do not spam add-requests at the user.
  if (code === GENERIC_INTERNAL) {
    const msg = String(err?.message || err?.error?.message || "").toLowerCase();
    return msg.includes("unrecognized chain") || msg.includes("unknown chain");
  }
  return false;
}

/** True when the user clicked "reject" in the wallet prompt. */
export function isUserRejection(err) {
  const code = chainErrorCode(err);
  return code === 4001 || code === 4100 || String(err?.message || "").toLowerCase().includes("user rejected");
}

/**
 * Make sure the wallet is on Mezo testnet, switching and adding as needed.
 *
 * @param eip1193 anything with `request({ method, params })` — window.ethereum,
 *   an ethers BrowserProvider's `.provider`, or a WalletConnect provider.
 * @returns {{ wasOnChain: boolean, switched: boolean, added: boolean, chainId: number|null }}
 * @throws when the user rejects, or the wallet supports neither call.
 */
export async function ensureChain(eip1193) {
  if (!eip1193 || typeof eip1193.request !== "function") {
    throw new Error("ensureChain needs an EIP-1193 provider with request().");
  }

  const before = await eip1193.request({ method: "eth_chainId" });
  if (sameChainId(before, MEZO_TESTNET_ID)) {
    return { wasOnChain: true, switched: false, added: false, chainId: MEZO_TESTNET_ID };
  }

  try {
    await eip1193.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: MEZO_TESTNET_HEX }],
    });
    return { wasOnChain: false, switched: true, added: false, chainId: MEZO_TESTNET_ID };
  } catch (err) {
    if (!isUnrecognizedChain(err)) throw err; // a rejection is the user's answer
  }

  // The wallet does not know the chain. Add it, then switch: MetaMask adds and
  // switches in one step, but several wallets add without switching, and a
  // second switch on a now-known chain cannot hit the 4902 path again.
  await eip1193.request({
    method: "wallet_addEthereumChain",
    params: [MEZO_TESTNET_ADD_PARAMS],
  });
  try {
    await eip1193.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: MEZO_TESTNET_HEX }],
    });
  } catch (err) {
    // Already switched by the add itself is fine; a genuine refusal is not.
    if (isUserRejection(err)) throw err;
  }
  return { wasOnChain: false, switched: true, added: true, chainId: MEZO_TESTNET_ID };
}

/**
 * Ensure a WALLET OBJECT (Privy shape) is on Mezo testnet.
 *
 * WHY THIS EXISTS SEPARATELY FROM ensureChain()
 *   ensureChain() speaks EIP-1193: `wallet_switchEthereumChain` at an injected
 *   provider. That is the only route for MetaMask, and it is NO route at all for
 *   a Privy embedded wallet — the key lives in Privy's TEE, there is no browser
 *   extension to prompt, and the embedded provider does not implement the EIP-3085
 *   methods. Privy's own API for that wallet is `wallet.switchChain(chainId)`.
 *   So: try the wallet's method first, then fall back to EIP-3085 through its
 *   provider, which is what an external wallet connected *through* Privy needs.
 *
 * @param wallet Privy-shaped: `{ chainId?, switchChain?, getEthereumProvider? }`.
 *   Also satisfied by lib/wallet-session.js's shim, so both paths share this.
 * @returns {{ wasOnChain: boolean, switched: boolean, added: boolean, chainId: number|null }}
 * @throws when the user rejects, or nothing can be switched.
 */
export async function ensureWalletChain(wallet) {
  if (!wallet) throw new Error("ensureWalletChain needs a wallet to switch.");

  if (parseChainId(wallet.chainId) === MEZO_TESTNET_ID) {
    return { wasOnChain: true, switched: false, added: false, chainId: MEZO_TESTNET_ID };
  }

  if (typeof wallet.switchChain === "function") {
    try {
      await wallet.switchChain(MEZO_TESTNET_ID);
      // Privy documents that switchChain does NOT update existing provider
      // instances, and the wallet object we hold was captured before the call —
      // so confirm against a freshly requested provider rather than trusting
      // either stale value. Claiming success without confirming is how a button
      // ends up "not working" while reporting that it did.
      const fresh = await readChainId(
        typeof wallet.getEthereumProvider === "function" ? await wallet.getEthereumProvider() : null
      );
      const now = fresh ?? parseChainId(wallet.chainId);
      if (now === MEZO_TESTNET_ID) {
        return { wasOnChain: false, switched: true, added: false, chainId: MEZO_TESTNET_ID };
      }
      // Not there yet: fall through to EIP-3085, which can also ADD the chain.
    } catch (err) {
      // A rejection is the user's answer — surface it, never retry around it.
      if (isUserRejection(err)) throw err;
      // Anything else (unsupported method, chain not in supportedChains) may
      // still be fixable through the provider, so fall through.
    }
  }

  const provider =
    typeof wallet.getEthereumProvider === "function" ? await wallet.getEthereumProvider() : null;
  return ensureChain(provider);
}

/** Plain-language cause for a failed switch/add, for the toast. */
export function describeChainError(err) {
  if (isUserRejection(err)) {
    return (
      "The network change was rejected in the wallet. AgentFloat only works on " +
      "Mezo testnet (chain 31611) — accept the switch prompt, or click the " +
      "network badge to try again."
    );
  }
  if (isUnrecognizedChain(err)) {
    return (
      "The wallet refused to add Mezo testnet. Add it by hand: chain id 31611, " +
      `RPC ${MEZO_TESTNET_ADD_PARAMS.rpcUrls[0]}, symbol BTC, explorer ` +
      `${MEZO_TESTNET_ADD_PARAMS.blockExplorerUrls[0]}.`
    );
  }
  const code = chainErrorCode(err);
  return (
    `The wallet could not switch to Mezo testnet${code ? ` (code ${code})` : ""}. ` +
    "Older or non-EIP-3085 wallets cannot add chains programmatically — add " +
    "chain 31611 manually in the wallet's network settings."
  );
}

/**
 * Cross-check the duplicated facts against a viem chain object, so the two
 * sources cannot drift apart silently. Called once by the wallet bridges.
 */
export function assertChainFactsAgree(viemChain, log = console.warn) {
  const problems = [];
  if (viemChain?.id !== MEZO_TESTNET_ID) problems.push(`id ${viemChain?.id} !== ${MEZO_TESTNET_ID}`);
  const rpc = viemChain?.rpcUrls?.default?.http?.[0];
  if (rpc && rpc !== MEZO_TESTNET_ADD_PARAMS.rpcUrls[0]) problems.push(`rpc ${rpc}`);
  const sym = viemChain?.nativeCurrency?.symbol;
  if (sym && sym !== MEZO_TESTNET_ADD_PARAMS.nativeCurrency.symbol) problems.push(`symbol ${sym}`);
  if (problems.length) {
    log(`[AgentFloat] evm-network.js disagrees with the deployed chain config: ${problems.join(", ")}. Update MEZO_TESTNET_ADD_PARAMS.`);
    return false;
  }
  return true;
}
