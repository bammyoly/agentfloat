// ---------------------------------------------------------------------------
// "Enable payments" — the Permit2 approval, as a popup a normal user can use.
//
// WHY IT IS A POPUP AND NOT A DOC
//   The refusal `permit2_not_approved` used to print
//
//       fix with: cd contract && node scripts/grant-permit2.js
//
//   That is a developer command needing a checkout and a private key. The person
//   who hit it signed in with Google. So the remedy now lives in the product: the
//   wallet signs, the wallet sends, and neither this app nor the gateway ever sees
//   a key.
//
// THE TWO CHOICES, because they are a real trade-off and not a detail
//   * this payment only — approve exactly the quoted amount. Tightest. Consumed by
//     the payment it was granted for, so a different price needs a new signature.
//   * all future payments — approve the maximum. One signature now, none later.
//     Permit2 still needs a fresh signature per spender, and the treasury caps are
//     enforced by the contract on every payment either way.
//
// THE THIRD PROBLEM NOBODY MENTIONS: GAS
//   An approval is a transaction, and a Privy-created agent wallet has never held
//   native BTC. On Mezo testnet the wallet of a brand-new user reads
//   `MUSD 10.0 · allowance 0 · BTC 0.0`, so an "Approve" button alone fails with
//   insufficient funds for gas — a dead end with a Latin error. This popup
//   therefore checks the balance first and offers the two ways out: a drip from
//   the operator wallet (nonce + signature, capped, cooldown — see server/gas.js),
//   or Mezo's own BTC faucet. When the gateway is unreachable it says it cannot
//   check and lets the user try anyway, rather than blocking on a service that may
//   simply be offline.
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useState } from "react";

import { Badge, Button, Dot, Note, Spinner, TxLink } from "./ui.jsx";
import { gasChallenge, gasRequest, gasStatus } from "../lib/gateway.js";
import {
  PERMIT2_ADDRESS, approvePermit2, approvalExplainer, readAllowance, waitForAllowance,
} from "../lib/permit2.js";
import { fmtMusd } from "../lib/chain.js";

/** Mezo's own testnet BTC faucet — the no-operator-cost way to get gas. */
export const MEZO_BTC_FAUCET = "https://faucet.test.mezo.org";

function describeError(e) {
  const text = String(e?.shortMessage || e?.message || e);
  if (/user (rejected|denied)|4001|rejected the request/i.test(text)) {
    return { title: "You declined — nothing changed", detail: "No approval was sent and no allowance moved. Open this again when you are ready." };
  }
  if (/insufficient funds|not enough balance|gas required|invalid balance/i.test(text)) {
    return {
      title: "Not enough BTC for gas",
      detail: "An approval is a transaction, and this wallet holds no native BTC. Request gas below (or use Mezo's faucet), then approve.",
    };
  }
  return { title: "The approval did not go through", detail: text.slice(0, 400) };
}

/** One selectable option in the choice list. */
function Choice({ selected, onSelect, title, what, detail, risk, tag }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`w-full cursor-pointer rounded-lg border p-3 text-left transition-colors ${
        selected ? "border-btc bg-panel-2" : "border-line-soft bg-ink-dim hover:border-line"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-3 w-3 shrink-0 rounded-full border ${
            selected ? "border-btc bg-btc" : "border-dim"
          }`}
          aria-hidden="true"
        />
        <span className="text-[14px] font-medium text-text">{title}</span>
        {tag ? <Badge tone={selected ? "ok" : "neutral"}>{tag}</Badge> : null}
      </div>
      <p className="mt-1.5 pl-5 text-[13.5px] leading-relaxed text-muted">{what}</p>
      <p className="mt-1 pl-5 text-[12.5px] leading-relaxed text-dim">{detail}</p>
      {risk ? <p className="mt-1 pl-5 text-[12.5px] leading-relaxed text-warn">{risk}</p> : null}
    </button>
  );
}

export default function ApprovalModal({
  open,
  onClose,
  wallet,
  address,
  signMessage,
  amountWei = null,
  onApproved = null,
}) {
  const [phase, setPhase] = useState("loading"); // loading | ready | confirming | done
  const [status, setStatus] = useState(null);    // GET /api/gas/status
  const [allowance, setAllowance] = useState(null);
  const [choice, setChoice] = useState("unlimited");
  const [busy, setBusy] = useState(null);        // "gas" | "approve" | "loading"
  const [err, setErr] = useState(null);
  const [tx, setTx] = useState(null);
  const [gasTx, setGasTx] = useState(null);

  const unlimited = choice === "unlimited";
  const explainer = approvalExplainer({ unlimited, amountWei });
  const amountLabel = amountWei ? `${fmtMusd(amountWei, 4)} MUSD` : null;

  /** Read both sources: the gateway (gas + drip eligibility) and the chain (allowance). */
  const load = useCallback(async () => {
    if (!address) return;
    setBusy("loading");
    const [st, allow] = await Promise.all([gasStatus(address), readAllowance(address)]);
    setStatus(st?.ok ? st : st);
    setAllowance(allow);
    setPhase(allow && allow > 0n && (!amountWei || allow >= BigInt(amountWei)) ? "done" : "ready");
    setBusy(null);
  }, [address, amountWei]);

  useEffect(() => {
    if (!open) return;
    setErr(null); setTx(null); setGasTx(null);
    load();
  }, [open, load]);

  // Escape closes; the backdrop does too. A popup you can only leave by finding
  // the ✕ is a popup people abandon.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape" && busy === null) onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  // --- derived, after the hooks (a hook below an early return is a time bomb) --
  const gatewayReachable = Boolean(status?.ok);
  const needsGas = gatewayReachable ? Boolean(status.needsGas) : null;
  const gasBtc = gatewayReachable ? status.balanceBtc : null;
  const costBtc = status?.estimate?.costBtc ?? null;
  const drip = status?.claim || null;
  const allowanceMusd = allowance === null ? null : Number(allowance / 10n ** 18n);
  const sufficient = Boolean(allowance && allowance > 0n && (!amountWei || allowance >= BigInt(amountWei)));
  const canApprove = Boolean(wallet?.address) && phase !== "done" && needsGas !== true && busy === null;

  async function requestGas() {
    setBusy("gas"); setErr(null);
    try {
      const ch = await gasChallenge(address);
      if (!ch.ok) throw Object.assign(new Error(ch.error || "the gateway would not issue a gas challenge"), { hint: ch.hint });
      const signature = await signMessage(ch.message);
      const r = await gasRequest({ address, signature, message: ch.message });
      if (!r.ok) throw Object.assign(new Error(r.error || "the gas request was refused"), { hint: r.hint, code: r.code });
      setGasTx(r.txHash);
      await load();
    } catch (e) {
      const d = describeError(e);
      setErr({ ...d, detail: e?.hint ? `${d.detail} — ${e.hint}` : d.detail });
    } finally {
      setBusy(null);
    }
  }

  async function onApprove() {
    setBusy("approve"); setErr(null);
    try {
      const sent = await approvePermit2(wallet, unlimited ? { unlimited: true } : { amountWei });
      setTx(sent.hash);
      setPhase("confirming");
      const done = await waitForAllowance({
        agent: address,
        minWei: unlimited ? 1n : BigInt(amountWei || 1),
        timeoutMs: 60_000,
        onTick: ({ allowance: a }) => { if (a !== null) setAllowance(a); },
      });
      if (!done.ok) {
        setPhase("ready");
        setErr({
          title: "Sent, but the allowance has not shown up yet",
          detail:
            "This RPC is slow to report receipts, so the approval may still land. Close this, retry the payment in a few seconds, and check the transaction if it still refuses.",
        });
        return;
      }
      setAllowance(done.allowance);
      setPhase("done");
      onApproved?.({ hash: sent.hash, unlimited, ms: done.ms });
    } catch (e) {
      setPhase("ready");
      setErr(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[9990] grid place-items-center overflow-y-auto bg-ink/80 px-4 py-8" style={{ backdropFilter: "blur(3px)" }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Enable x402 payments"
        className="animate-fade w-[min(600px,100%)] rounded-xl border border-line bg-panel shadow-2xl"
      >
        {/* --- header --- */}
        <div className="flex items-start justify-between gap-3 border-b border-line-soft px-5 py-4">
          <div>
            <p className="font-mono text-[12.5px] uppercase tracking-[0.14em] text-dim">one approval</p>
            <h2 className="mt-1 text-[15px] font-semibold text-text">Enable x402 payments</h2>
            <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
              x402 settles through Permit2, so this wallet must approve it once. You sign it; AgentFloat never sees a key.
            </p>
          </div>
          <button
            type="button"
            onClick={() => busy === null && onClose?.()}
            className="cursor-pointer text-[15px] leading-none text-dim transition-colors hover:text-text"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* --- what the wallet looks like right now --- */}
          <div className="flex flex-wrap items-center gap-2">
            {sufficient
              ? <Badge tone="ok"><Dot tone="ok" /> approved</Badge>
              : allowance === null
                ? <Badge tone="neutral"><Dot tone="warn" /> allowance unknown</Badge>
                : <Badge tone="warn"><Dot tone="warn" /> not approved</Badge>}
            {needsGas === true && <Badge tone="bad"><Dot tone="bad" /> no gas</Badge>}
            {needsGas === false && <Badge tone="neutral"><Dot tone="ok" /> gas ok</Badge>}
            {needsGas === null && <Badge tone="neutral"><Dot tone="warn" /> gas unchecked</Badge>}
            {amountLabel && <span className="font-mono text-[12.5px] text-dim">this payment {amountLabel}</span>}
          </div>

          {allowance !== null && allowance > 0n && !sufficient && (
            <Note tone="warn">
              Current allowance is {allowanceMusd?.toFixed(4)} MUSD, which is less than this payment
              {amountLabel ? ` (${amountLabel})` : ""}. Approve again to raise it.
            </Note>
          )}

          {phase === "loading" && (
            <div className="flex items-center gap-2 py-6 text-[14px] text-muted">
              <Spinner /> reading your wallet…
            </div>
          )}

          {err && (
            <Note tone="bad">
              <b className="text-text">{err.title}</b>
              <br />
              {err.detail}
            </Note>
          )}

          {/* --- gas: the blocker nobody mentions --- */}
          {needsGas === true && phase !== "done" && (
            <div className="rounded-lg border border-bad/40 bg-bad-dim p-3.5">
              <p className="text-[14px] font-medium text-text">This wallet has no BTC for gas</p>
              <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
                Balance {gasBtc ?? 0} BTC. An approval is a transaction, and on Mezo testnet transactions cost native BTC —
                {costBtc !== null ? ` roughly ${costBtc} for this one.` : " a fraction of a cent."}
                Your MUSD cannot pay for it.
              </p>

              {drip?.eligible ? (
                <div className="mt-3">
                  <Button variant="primary" size="sm" onClick={requestGas} disabled={busy !== null}>
                    {busy === "gas" ? "sending…" : `Send me ${status?.amountBtc ?? "0.00005"} BTC for gas`}
                  </Button>
                  <p className="mt-2 text-[12.5px] leading-relaxed text-dim">
                    Sent by the operator wallet. You sign a one-time request proving you control this address; nothing else
                    is authorized. Capped at {status?.used ? `${status.used.todayBtc} BTC used today` : "a daily budget"},
                    one request per {status?.claim ? "24h" : "24h"} per wallet.
                  </p>
                </div>
              ) : (
                <Note tone="warn" className="mt-3">
                  {drip?.hint || "The operator gas drip is not available right now."}
                  {drip?.nextClaimAt ? ` Next request at ${new Date(drip.nextClaimAt).toLocaleString()}.` : ""}
                </Note>
              )}

              <p className="mt-3 text-[13.5px] leading-relaxed text-muted">
                Or take BTC from Mezo's own testnet faucet — paste your agent address (copy it from the top-right of this
                app), then come back and refresh this box.{" "}
                <a href={MEZO_BTC_FAUCET} target="_blank" rel="noreferrer" className="text-info hover:underline">
                  faucet.test.mezo.org →
                </a>
              </p>

              {gasTx && <p className="mt-2 text-[13.5px] text-muted">gas sent: <TxLink hash={gasTx} /></p>}
            </div>
          )}

          {needsGas === null && phase !== "done" && (
            <Note tone="warn">
              The gateway is not answering, so this popup could not check your BTC balance or offer a gas drip. Try the
              approval anyway — if it fails with "insufficient funds for gas", start the gateway
              (<span className="code">npm run gateway</span>) and reopen this.
            </Note>
          )}

          {/* --- the choice --- */}
          {phase !== "done" && (
            <div role="radiogroup" aria-label="How much to approve" className="space-y-2">
              <Choice
                selected={unlimited}
                onSelect={() => setChoice("unlimited")}
                tag="fewest prompts"
                title="All future payments"
                what={approvalExplainer({ unlimited: true }).what}
                detail={approvalExplainer({ unlimited: true }).detail}
                risk={approvalExplainer({ unlimited: true }).risk}
              />
              <Choice
                selected={!unlimited}
                onSelect={() => setChoice("exact")}
                tag="tightest"
                title="This payment only"
                what={explainer.unlimited ? approvalExplainer({ unlimited: false, amountWei }).what : explainer.what}
                detail={approvalExplainer({ unlimited: false, amountWei }).detail}
                risk={null}
              />
              {!amountWei && !unlimited && (
                <p className="text-[12.5px] text-dim">
                  Get a quote first to approve an exact amount — without one there is nothing to size the approval to.
                </p>
              )}
            </div>
          )}

          {/* --- done --- */}
          {phase === "done" && (
            <div className="rounded-lg border border-ok/40 bg-ok-dim p-3.5">
              <p className="text-[14px] font-medium text-text">
                {tx ? "Payments are enabled." : "This wallet is already approved."}
              </p>
              <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
                Allowance {allowanceMusd === null ? "confirmed" : allowanceMusd > 1e12 ? "unlimited" : `${allowanceMusd.toFixed(4)} MUSD`} from{" "}
                <span className="font-mono text-[12.5px]">{address?.slice(0, 8)}…</span> to Permit2{" "}
                <span className="font-mono text-[12.5px]">{PERMIT2_ADDRESS.slice(0, 10)}…</span>.
              </p>
              {tx && <p className="mt-2 text-[13.5px] text-muted">approval tx: <TxLink hash={tx} /></p>}
              {phase === "done" && !tx && (
                <button
                  type="button"
                  onClick={() => { setPhase("ready"); setAllowance(allowance); }}
                  className="btn btn-sm mt-3 cursor-pointer"
                >
                  Change the allowance
                </button>
              )}
            </div>
          )}

          {phase === "confirming" && (
            <div className="flex items-center gap-2 py-2 text-[14px] text-muted">
              <Spinner /> waiting for the allowance to appear on chain…
              {tx && <TxLink hash={tx} />}
            </div>
          )}
        </div>

        {/* --- footer --- */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft px-5 py-4">
          <p className="max-w-[36ch] text-[12.5px] leading-relaxed text-dim">
            Your caps still apply to every payment: per-call max and daily cap are enforced by the treasury contract, not
            by this allowance.
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onClose} disabled={busy !== null}>Close</Button>
            {phase !== "done" && (
              <Button variant="primary" size="sm" onClick={onApprove} disabled={!canApprove || (choice === "exact" && !amountWei)}>
                {busy === "approve" ? "waiting for your wallet…" : `Approve ${unlimited ? "all payments" : amountLabel || "exact amount"}`}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
