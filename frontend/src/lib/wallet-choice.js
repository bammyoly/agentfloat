// ---------------------------------------------------------------------------
// Which wallet provider serves this session.
//
// THE DECISION, IN ORDER
//   1. VITE_WALLET_PROVIDER overrides everything: "privy", "reown" or "injected".
//   2. Otherwise, if VITE_REOWN_PROJECT_ID is set → Reown AppKit (its modal
//      lists installed wallets AND WalletConnect).
//   3. Otherwise, if a wallet is injected (window.ethereum) → the bare
//      injected transport. No vendor, no signup.
//   4. Otherwise, if Privy is configured → Privy, as before.
//   5. Otherwise → inert operator-wallet mode.
//
// WHY THE FALLBACK ORDER IS THIS WAY
//   Privy is the only provider here that can CREATE a wallet for someone who
//   has none — but it is also the one that is currently failing in the field
//   with exited_auth_flow, and the failure is inside Privy's own bundle. So a
//   machine that CAN use a real wallet should not be held hostage by it, while
//   a machine with no wallet at all still gets the Privy path rather than a
//   dead end. The env override exists for the day Privy is fixed and someone
//   wants it back as the default: VITE_WALLET_PROVIDER=privy.
// ---------------------------------------------------------------------------

import { IS_PRIVY_CONFIGURED } from "./privy.js";

export const REOWN_PROJECT_ID = (import.meta.env.VITE_REOWN_PROJECT_ID || "").trim();
export const WALLET_PROVIDER_OVERRIDE = (import.meta.env.VITE_WALLET_PROVIDER || "").trim().toLowerCase();

export function hasInjectedWallet() {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

/** @returns {"reown"|"injected"|"privy"|"none"} */
export function resolveWalletProvider() {
  const o = WALLET_PROVIDER_OVERRIDE;
  if (o === "privy") return IS_PRIVY_CONFIGURED ? "privy" : "none";
  if (o === "reown") return REOWN_PROJECT_ID ? "reown" : hasInjectedWallet() ? "injected" : "none";
  if (o === "injected") return "injected";

  if (REOWN_PROJECT_ID) return "reown";
  if (hasInjectedWallet()) return "injected";
  return IS_PRIVY_CONFIGURED ? "privy" : "none";
}

/** One line for the navbar / diagnose page. Never contains a secret. */
export function describeWalletProvider(kind) {
  switch (kind) {
    case "reown": return "Reown AppKit";
    case "injected": return "injected wallet";
    case "privy": return "Privy";
    default: return "none (operator-wallet mode)";
  }
}
