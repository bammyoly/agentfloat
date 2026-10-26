// ---------------------------------------------------------------------------
// Shared app data: one poller for the whole UI.
//
// Everything the pages need about the chain and the gateway is fetched HERE and
// shared through context, so seven pages polling independently cannot desync or
// hammer the RPC.
//
// WHY THIS IS NOT IN App.jsx
//   vite-plugin-react's Fast Refresh requires a module to export *only*
//   components. App.jsx exporting `useAppData` alongside its default component
//   made the plugin bail out:
//     [vite] hmr invalidate /src/App.jsx Could not Fast Refresh
//            ("useAppData" export is incompatible)
//   An invalidate on the app shell cascades into a full re-import of main.jsx,
//   which called createRoot() a second time on the same container — and mounted
//   a second PrivyProvider. Separating the hook from the components removes the
//   invalidate at its source.
//
// The operator identity comes from the wallet session (Privy), falling back to
// the legacy injected-wallet connect when Privy is not configured.
// ---------------------------------------------------------------------------

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { useSession } from "./session.jsx";
import { getHealth, getReceipts, getChainRecords } from "./gateway.js";
import { IS_DEPLOYED, TREASURY_OWNER } from "../contracts/index.js";
import { connectOperator } from "./chain.js";

const POLL_MS = 6000;

/**
 * How many of the treasury's receipts to read per poll.
 *
 * It used to be 25, which is plenty for a "recent activity" list and nowhere
 * near enough for a chart: a per-day series built from 25 records covers a
 * couple of days at best, and the dashboard now draws exactly that. 100 is the
 * ceiling the gateway enforces (`Math.min(limit, 100)`), so this asks for the
 * most it will give. Still ONE call per poll, shared by every page through this
 * provider — the reason app-data exists.
 *
 * And it is still a WINDOW, not history. Anything drawn from it says so, because
 * a truncated series that looks complete is a lie with a gradient on it.
 */
const RECORD_WINDOW = 100;

export const AppDataContext = createContext(null);
export const useAppData = () => useContext(AppDataContext);

export function AppDataProvider({ children }) {
  const session = useSession();
  const [health, setHealth] = useState(null);
  const [chainRecords, setChainRecords] = useState(null);
  const [localRecords, setLocalRecords] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  // Legacy operator connection, used only when Privy is not configured.
  const [legacyOperator, setLegacyOperator] = useState({ address: null, signer: null, provider: null });
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const [h, cr, lr] = await Promise.all([
      getHealth(),
      IS_DEPLOYED ? getChainRecords(RECORD_WINDOW) : Promise.resolve(null),
      getReceipts(),
    ]);
    if (!mounted.current) return;
    setHealth(h);
    if (cr && cr.ok) setChainRecords(cr);
    if (lr && lr.ok) setLocalRecords(lr);
    setLoading(false);
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const connectLegacy = useCallback(async () => {
    setBusy(true);
    try {
      const { provider, signer, address } = await connectOperator();
      setLegacyOperator({ address, signer, provider });
    } finally {
      setBusy(false);
      refresh();
    }
  }, [refresh]);

  // One source of truth for "can this browser sign owner-only transactions".
  // Privy wins when configured; otherwise the legacy injected wallet is used.
  // Ownership is always verified against the on-chain owner, never assumed.
  const operator = useMemo(() => {
    if (session.configured && session.isOperator) {
      return { signer: session.operatorSigner, source: "privy", isOwner: true };
    }
    if (!session.configured && legacyOperator.signer) {
      const isOwner = TREASURY_OWNER
        ? legacyOperator.address?.toLowerCase() === TREASURY_OWNER.toLowerCase()
        : false;
      return {
        signer: legacyOperator.signer,
        provider: legacyOperator.provider,
        address: legacyOperator.address,
        source: "injected",
        isOwner,
      };
    }
    return { signer: null, isOwner: false, source: null };
  }, [session.configured, session.isOperator, session.operatorSigner, legacyOperator]);

  const value = useMemo(
    () => ({
      health, chainRecords, localRecords, loading, tick, refresh,
      operator, connectLegacy, busy, recordWindow: RECORD_WINDOW,
      gatewayOnline: Boolean(health && !health.unreachable),
      deployed: IS_DEPLOYED && health?.deploymentFound !== false,
    }),
    [health, chainRecords, localRecords, loading, tick, refresh, operator, connectLegacy, busy]
    // RECORD_WINDOW is a module constant, so it needs no dependency of its own.
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}
