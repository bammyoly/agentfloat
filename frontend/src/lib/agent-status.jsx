// ---------------------------------------------------------------------------
// useAgentStatus — one shared read of a user's OWN agent, straight from the
// treasury contract.
//
// WHY IT IS SHARED
//   The dashboard hero, the onboarding rail, the Spend page's budget panel and
//   the Operate page's current-caps row all need the same four numbers for the
//   same address. Four components polling `agentStatus()` independently means
//   four RPC calls every ten seconds for one answer, and — worse — four copies of
//   the revert handling, which is the subtle part:
//
//     agentStatus() REVERTS for an address that is not registered yet.
//
//   That revert is not an error. It is the signal that a brand-new user has a
//   wallet but no float, and the UI should point them at the faucet instead of
//   showing a failure. Every caller used to re-derive that; now it is derived
//   once, and `registered: null | true | false` is the contract.
//
// It reads the chain rather than the gateway because the treasury is the
// authority on caps: the gateway's mirror of them exists to refuse fast, not to
// be believed over the contract.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { treasuryRead } from "./chain.js";
import { IS_DEPLOYED } from "../contracts/index.js";

const IDLE = { loading: false, status: null, registered: null, error: null };

/**
 * @param address agent wallet address, or null while Privy provisions one
 * @param opts.intervalMs poll interval; 0 disables polling (read once)
 * @returns {{ loading: boolean, status: object|null, registered: boolean|null,
 *             error: string|null, refresh: () => Promise<void> }}
 *
 * `refresh` exists because a payment changes these numbers NOW and the poll only
 * notices ten seconds later. The automated-spending panel reads the budget after
 * every single run, and a gauge that lags the run it is describing looks broken
 * in a demo and is misleading in production. Calling it is always safe: an
 * in-flight read that resolves after unmount is discarded.
 */
export function useAgentStatus(address, { intervalMs = 10_000 } = {}) {
  const [state, setState] = useState(IDLE);
  const cancelled = useRef(false);

  const read = useCallback(async () => {
    if (!address || !IS_DEPLOYED) {
      if (!cancelled.current) setState(IDLE);
      return;
    }
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const t = treasuryRead();
      const s = await t.agentStatus(address);
      if (!cancelled.current) setState({ loading: false, status: s, registered: true, error: null });
    } catch (e) {
      // A revert here means "not registered", which is the expected state for a
      // wallet that has never claimed. Anything else is a read failure worth
      // distinguishing, because it should NOT be rendered as "unfunded".
      const msg = String(e?.shortMessage || e?.message || e);
      const notRegistered = /revert|_requireAgent|execution reverted/i.test(msg);
      if (!cancelled.current) {
        setState({
          loading: false,
          status: null,
          registered: notRegistered ? false : null,
          error: notRegistered ? null : msg.slice(0, 200),
        });
      }
    }
  }, [address]);

  useEffect(() => {
    cancelled.current = false;
    read();
    const id = intervalMs ? setInterval(read, intervalMs) : null;
    return () => {
      cancelled.current = true;
      if (id) clearInterval(id);
    };
  }, [read, intervalMs]);

  return { ...state, refresh: read };
}

/** Plain-language label for the policy rule that stopped a payment. */
export const REASON_LABEL = {
  per_call_max: "over per-call max",
  daily_cap: "over today's spending cap",
  spend_read_failed: "today's spend could not be read",
  insufficient_float: "not enough float in wallet",
  permit2_not_approved: "Permit2 allowance missing",
  paused: "gateway paused",
  paused_onchain: "treasury paused on-chain",
  not_registered: "agent not registered",
  agent_inactive: "agent frozen",
  not_allowlisted: "endpoint not approved",
  wrong_asset: "seller asked for a non-MUSD asset",
  wrong_network: "seller asked for another network",
  ssrf_blocked: "internal address blocked",
  bad_protocol: "seller is not https",
  dns_failed: "seller hostname did not resolve",
  payer_mismatch: "payment signed by a different wallet",
  no_agent_key: "agent key not configured",
  no_agent: "no agent wallet supplied",
  charged_without_delivery: "settled but seller returned no resource",
};
