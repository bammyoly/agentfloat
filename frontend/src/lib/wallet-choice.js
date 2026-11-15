// ---------------------------------------------------------------------------
// Wallet provider selection — Wave 2: Reown is the primary provider.
// Privy is removed. The choice is now: Reown → injected → none.
// ---------------------------------------------------------------------------

export const REOWN_PROJECT_ID = (import.meta.env.VITE_REOWN_PROJECT_ID || "").trim();
export const WALLET_PROVIDER_OVERRIDE = (import.meta.env.VITE_WALLET_PROVIDER || "").trim().toLowerCase();

export function hasInjectedWallet() {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

/** @returns {"reown"|"injected"|"none"} */
export function resolveWalletProvider() {
  const o = WALLET_PROVIDER_OVERRIDE;
  if (o === "reown") return REOWN_PROJECT_ID ? "reown" : hasInjectedWallet() ? "injected" : "none";
  if (o === "injected") return "injected";

  if (REOWN_PROJECT_ID) return "reown";
  if (hasInjectedWallet()) return "injected";
  return "none";
}

export function describeWalletProvider(kind) {
  switch (kind) {
    case "reown": return "Reown AppKit";
    case "injected": return "injected wallet";
    default: return "none (operator-wallet mode)";
  }
}

