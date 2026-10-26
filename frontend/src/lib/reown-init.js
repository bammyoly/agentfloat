// ---------------------------------------------------------------------------
// Reown AppKit initialisation — created ONCE, at module scope, lazily.
//
// WHY A SIDE-EFFECT MODULE
//   createAppKit() registers web components and a global controller; calling it
//   twice throws, and calling it from render is a bug. Keeping it here means it
//   runs exactly when this module is first imported — which SessionLayer only
//   does when the Reown path is actually selected — and exactly once.
//
// WHY LAZY AT ALL
//   AppKit drags in WalletConnect's transport tree. Importing it statically
//   would put all of that in the main graph, which is the same mistake this
//   project already paid for with Privy (see lib/PrivyLayer.jsx). A dynamic
//   import keeps it out of the bundle for anyone not using this path.
//
// PROJECT ID
//   Reown requires a free Project ID from https://cloud.reown.com. It is a
//   public client-side value, like the Privy App ID. Without it AppKit cannot
//   initialise, so SessionLayer falls back to the bare injected transport —
//   which needs no signup at all.
// ---------------------------------------------------------------------------

import { createAppKit } from "@reown/appkit/react";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { defineChain } from "@reown/appkit/networks";

/**
 * Mezo testnet as an AppKit network.
 *
 * The `caipNetworkId` / `chainNamespace` pair is what AppKit adds on top of a
 * viem chain; without them defineChain produces a chain the controllers reject.
 * The remaining fields mirror src/lib/evm-network.js exactly — and
 * assertChainFactsAgree() warns at startup if the two ever drift.
 */
export const mezoAppKitChain = defineChain({
  id: 31611,
  caipNetworkId: "eip155:31611",
  chainNamespace: "eip155",
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.test.mezo.org"] } },
  blockExplorers: { default: { name: "Mezo Explorer", url: "https://explorer.test.mezo.org" } },
  testnet: true,
});

let initialised = false;

export function initReown(projectId) {
  if (initialised) return;
  initialised = true;

  createAppKit({
    adapters: [new EthersAdapter()],
    networks: [mezoAppKitChain],
    defaultNetwork: mezoAppKitChain,
    projectId,
    metadata: {
      name: "AgentFloat",
      description: "Budget-controlled MUSD wallet for AI agents on Mezo.",
      url: typeof window !== "undefined" ? window.location.origin : "http://localhost:5173",
      icons: [],
    },
    themeMode: "dark",
    // WalletConnect telemetry off. Nothing about a demo user's wallet belongs
    // in a third-party analytics pipeline.
    features: { analytics: false },
  });
}
