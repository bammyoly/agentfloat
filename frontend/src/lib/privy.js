// ---------------------------------------------------------------------------
// Privy configuration.
//
// WHY PRIVY HERE
//   AgentFloat originally had one agent wallet whose key lived in the gateway.
//   That is fine for a demo but it means only the operator can use the product.
//   Privy gives every visitor their OWN agent wallet behind a Google or email
//   login: created once on first sign-in, then reattached on every later login.
//
// THE CONSTRAINT THAT SHAPES THIS CONFIG
//   x402 on Mezo settles with `assetTransferMethod: permit2`, which is an
//   EIP-712 signature. Only an EOA can produce one — a smart contract wallet
//   cannot. So embedded wallets MUST stay plain EOAs:
//
//     - do NOT enable smart wallets / ERC-4337
//     - do NOT enable Privy gas sponsorship (it delegates the wallet via
//       EIP-7702, giving the address contract code and forcing ERC-1271
//       signature mode, which the x402 client does not use)
//
//   Privy's default embedded wallet is an EOA secured by TEE + Shamir's Secret
//   Sharing, which is exactly what we need. `walletClientType === "privy"`.
//
// SETUP
//   Create an app at https://dashboard.privy.io and put the App ID in
//   frontend/.env as VITE_PRIVY_APP_ID. Without it the app still runs, in
//   operator-wallet mode, and the login button explains what is missing.
//   The App ID is a PUBLIC client-side value — it is not a secret. Do not put
//   the app *secret* anywhere near this folder.
// ---------------------------------------------------------------------------

import { mezoTestnet } from "./mezo.js";

export const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID || "";

/** True once an App ID is configured. Gates the whole Privy provider. */
export const IS_PRIVY_CONFIGURED = Boolean(PRIVY_APP_ID);

export const privyConfig = {
  // Google and email are what the brief asks for. `wallet` is kept so the
  // treasury operator can still sign in with MetaMask and reach the controls.
  loginMethods: ["google", "email", "wallet"],

  // Create an embedded wallet for every user on first login, and reuse it
  // thereafter — Privy reattaches the same wallet to the same identity, so a
  // returning Google account gets the same agent address and the same balance.
  //
  // THE NESTING HERE IS LOAD-BEARING. In @privy-io/react-auth 3.x the key lives
  // at `embeddedWallets.ethereum.createOnLogin`, NOT at `embeddedWallets.
  // createOnLogin`. The top-level spelling is simply not in the config type, so
  // it is silently dropped and the value falls back to its default of "off" —
  // users sign in successfully and get NO agent wallet, which breaks the whole
  // product while looking like it works. Privy's own app-config endpoint reports
  // the effective value back as `embedded_wallet_config.ethereum.
  // create_on_login`, which is how this was caught.
  embeddedWallets: {
    ethereum: {
      createOnLogin: "all-users",
    },
    // No "export private key" or seed-phrase UI. The key never leaves Privy's
    // TEE, which is the point: neither the browser bundle nor our gateway ever
    // holds a user's key.
    showWalletUIs: false,
  },

  // Mezo is not in viem/chains, so it is passed as a defineChain object.
  // Privy requires defaultChain to also appear in supportedChains.
  defaultChain: mezoTestnet,
  supportedChains: [mezoTestnet],

  // Allow external wallets (MetaMask) so the operator can connect the treasury
  // owner key through the same navbar.
  externalWallets: {
    walletConnect: { enabled: false },
  },

  appearance: {
    theme: "dark",
    accentColor: "#f7931a", // Mezo/BTC orange, matches the console palette
    loginMessage: "Sign in to get your AgentFloat agent wallet.",
    logo: "",
    // Belongs under `appearance`, not at the top level — the top-level spelling
    // is not in the config type and is silently ignored, which would leave Privy
    // offering Solana wallets in an EVM-only product.
    walletChainType: "ethereum-only",

    // Web2 methods first. The modal still offers "continue with wallet" (it is
    // the treasury operator's door — see PrivyLayer's owner check), but a new
    // user's eye lands on Google and email, which is what this product onboards
    // with. Set loginMethods: ["google", "email"] to remove wallet entirely;
    // read the operator caveat in the README first.
    showWalletLoginFirst: false,
  },
};

/**
 * Human-readable label for a Privy wallet, used to tell the user's own EOA apart
 * from a connected external wallet.
 */
export function walletKind(wallet) {
  if (!wallet) return "none";
  // "privy" = embedded EOA (what x402 needs). Anything else is an external
  // wallet such as MetaMask, or a smart wallet we deliberately do not create.
  if (wallet.walletClientType === "privy") return "embedded EOA";
  if (wallet.walletClientType === "privy_smart_wallet") return "smart wallet";
  return wallet.walletClientType || "external";
}

/**
 * Wallet kinds that are plain EOAs and can therefore produce the EIP-712
 * permit2 signature x402 on Mezo requires. "privy" is the embedded wallet;
 * "injected" and "reown" are external wallets the user brought (MetaMask,
 * Rabby, WalletConnect). A smart wallet is none of these and is refused.
 */
export const X402_CAPABLE_KINDS = new Set(["privy", "injected", "reown"]);

/** True if this wallet can sign an x402 permit2 authorization. */
export function canSignX402(wallet) {
  return Boolean(wallet) && X402_CAPABLE_KINDS.has(wallet.walletClientType);
}

/**
 * Translate a PrivyErrorCode into the thing that actually needs changing.
 *
 * WHY THIS EXISTS
 *   `usePrivy().login()` returns void, so every failure is silent: the button
 *   does nothing and the console says nothing. `useLogin({ onError })` hands us a
 *   code instead, but the codes are terse — `invalid_origin` does not tell you
 *   *which* origin or that opening the app over a LAN IP is the cause. These are
 *   Privy's documented client-side codes
 *   (docs.privy.io/basics/troubleshooting/error-handling/client-errors), each
 *   paired with the fix that applies to THIS app.
 */
// ---------------------------------------------------------------------------
// Error copy moved to ./auth-errors.js.
//
// It used to live here as one developer-facing sentence per code. Two problems
// with that, both observed in the field:
//
//   1. It could not distinguish "the person closed the popup" from "the provider
//      was torn down mid-handshake", because Privy reports BOTH as
//      `exited_auth_flow`. Cancelling a sign-in therefore produced a red
//      "Sign-in failed" alert and a console error — a false alarm that trains
//      everyone to ignore the real ones.
//   2. Every string was written for whoever maintains this repo (VITE_PRIVY_APP_ID,
//      frontend/.env, `npm run check:privy`, loginMethods in src/lib/privy.js) and
//      was shown verbatim to the person using the app.
//
// auth-errors.js owns both layers now — `user` for the toast, `dev` behind a
// disclosure — and classifyAuthError() takes the structural-fault verdict from
// lib/privy-dom.js to settle (1). Re-exported here so existing importers of
// explainPrivyError keep working against one copy of the text.
// ---------------------------------------------------------------------------
export { AUTH_OUTCOME, classifyAuthError, explainPrivyError, isCancellation } from "./auth-errors.js";
