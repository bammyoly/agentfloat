// ---------------------------------------------------------------------------
// Mezo chain definitions for viem / Privy.
//
// Derived from the GENERATED contracts/chain.json rather than hand-copied, so
// the wallet layer cannot drift from what deploy.js actually deployed. Mezo is
// not in viem/chains, which is fine — Privy documents defineChain for exactly
// this case ("Privy is compatible with any EVM-compatible chain").
// ---------------------------------------------------------------------------

import { defineChain } from "viem";
import CHAIN_JSON from "../contracts/chain.json" with { type: "json" };

/** Mezo Testnet (chainId 31611) as a viem chain object. */
export const mezoTestnet = defineChain({
  id: CHAIN_JSON.chainId,
  name: CHAIN_JSON.name,
  nativeCurrency: CHAIN_JSON.nativeCurrency,
  rpcUrls: {
    default: { http: [CHAIN_JSON.rpcUrl] },
  },
  blockExplorers: {
    default: { name: "Mezo Explorer", url: CHAIN_JSON.explorerUrl },
  },
  testnet: CHAIN_JSON.isTestnet,
});

/**
 * Mezo Mainnet (chainId 31612). Wave 2 target — defined now so switching is a
 * one-line change and so Privy's supportedChains can include both.
 */
export const mezoMainnet = defineChain({
  id: 31612,
  name: "Mezo",
  nativeCurrency: { name: "BTC", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://mezo-mainnet.boar.network"] },
  },
  blockExplorers: {
    default: { name: "Mezo Explorer", url: "https://explorer.mezo.org" },
  },
  testnet: false,
});

/** The chain this build targets. */
export const activeChain = mezoTestnet;

export { CHAIN_JSON };
