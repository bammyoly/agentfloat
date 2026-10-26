// ---------------------------------------------------------------------------
// Faucet — claim 10 MUSD for your own agent wallet, once per 48 hours.
//
// The MUSD comes from the OPERATOR wallet's balance, so this endpoint is a
// real liability: without controls, anyone could create accounts in a loop and
// drain it. Three things stop that, all enforced server-side:
//
//   1. A signature. The client signs a challenge containing its own address and
//      a nonce; the server recovers the signer and refuses on mismatch. You
//      cannot claim for an address you do not control.
//   2. A per-address 48h cooldown, persisted on disk so restarting the gateway
//      does not reset it.
//   3. Global caps on total and per-day outflow, so a worst case is bounded
//      instead of open-ended.
//
// The client cannot influence any of these — it only asks and signs.
//
// WHAT ELSE A CLAIM DOES, and why this page shows it
//   On a first claim the gateway also registers the wallet as an agent in the
//   treasury with a per-call max and a daily cap. That is the moment a brand-new
//   user becomes governed rather than merely funded, so the page reads those caps
//   back from the chain afterwards and points at Operate, where they can be
//   reshaped. Reading them from the contract rather than from the faucet's
//   response keeps the chain the single source of truth.
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useState } from "react";
import { Faucet as FaucetIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { useAppData } from "../lib/app-data.jsx";
import { useSession } from "../lib/session.jsx";
import { useAgentStatus } from "../lib/agent-status.jsx";
import {
  AddressLink, Badge, Button, Card, Dot, Note, PageHeader, Stat, TxLink,
} from "../components/ui.jsx";
import { faucetStatus, faucetChallenge, faucetRequest } from "../lib/gateway.js";
import ApprovalModal from "../components/ApprovalModal.jsx";
import { fmtMusd } from "../lib/chain.js";
import { ethers } from "ethers";

export default function Faucet() {
  const { health, refresh } = useAppData();
  const session = useSession();

  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  // The claim leaves the wallet with MUSD and no gas, and no Permit2 approval — so
  // it cannot pay for anything yet. The popup handles both, and checks for itself
  // whether the approval is already in place.
  const [approvalOpen, setApprovalOpen] = useState(false);

  const address = session.agentAddress;
  // Read the wallet's own state from the treasury: registered?, float, caps.
  // `registered: false` is the useful signal here — it is exactly the "you have
  // a wallet but no float yet" case this page exists to fix.
  const mine = useAgentStatus(address);

  const load = useCallback(async () => {
    if (!address) { setStatus(null); return; }
    const s = await faucetStatus(address);
    setStatus(s);
  }, [address]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  async function claim() {
    setBusy(true); setErr(null); setResult(null);
    try {
      setStep("asking the gateway for a challenge…");
      const ch = await faucetChallenge(address);
      if (!ch.ok) throw new Error(ch.error || "could not get a challenge");

      setStep("waiting for you to sign in your wallet…");
      const signature = await session.signMessage(ch.message);

      setStep("submitting — the gateway verifies your signature, registers your wallet, then sends MUSD…");
      const r = await faucetRequest({ address, signature, message: ch.message });
      setResult(r);
      if (!r.ok) setErr(r.error || "claim failed");
      refresh();
      load();
    } catch (e) {
      const text = String(e?.message || e);
      setErr(/user (rejected|denied)|4001/i.test(text)
        ? "You declined the signature, so nothing was claimed. Ask again when ready — signing costs nothing and authorizes no transfer."
        : text);
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  const amount = status?.amountMusd ?? 10;
  const eligible = status?.eligible;
  const nextAt = status?.nextClaimAt ? new Date(status.nextClaimAt) : null;
  const registered = mine.registered === true;
  const floatMusd = mine.status ? fmtMusd(mine.status.walletBalance, 4) : null;

  return (
    <div className="animate-fade space-y-6 pb-10">
      <PageHeader
        icon={FaucetIcon}
        eyebrow="Testnet funds"
        title="MUSD faucet"
        sub={`Claim ${amount} MUSD for your own agent wallet, once every 48 hours. It is airdropped from the operator wallet and registered in the treasury with on-chain spending caps, so it behaves exactly like a funded agent.`}
        aside={
          registered
            ? <Badge tone="ok"><Dot tone="ok" /> registered agent</Badge>
            : mine.registered === false
              ? <Badge tone="warn"><Dot tone="warn" /> not registered yet</Badge>
              : null
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <Card title="Claim">
          {!session.configured ? (
            <Note tone="warn">
              <b>Sign-in is disabled.</b> The faucet issues MUSD to a per-user agent wallet, so it
              needs Privy. Set <span className="code">VITE_PRIVY_APP_ID</span> in{" "}
              <span className="code">frontend/.env</span> and restart the dev server.
            </Note>
          ) : !session.ready ? (
            <div className="space-y-3">
              <div className="animate-shimmer h-4 w-2/3 rounded bg-ink-dim" />
              <div className="animate-shimmer h-4 w-1/2 rounded bg-ink-dim" />
              <p className="text-[12.5px] text-dim">Loading your session…</p>
            </div>
          ) : !address ? (
            <>
              <p className="text-[14px] leading-relaxed text-muted">
                Sign in with Google or email. Privy creates an embedded wallet for you on first
                login — an EOA, because x402 authorization is an EIP-712 permit2 signature that a
                contract wallet cannot produce. The same identity gets the same wallet and the same
                balance every time you return.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button variant="primary" onClick={session.login} disabled={session.authenticating}>
                  {session.authenticating ? "Opening…" : "Sign in to claim"}
                </Button>
                {session.authenticating && (
                  <span className="text-[13.5px] text-dim">
                    Creating a wallet through Google can take noticeably longer than email — it is
                    provisioned in a TEE on Privy's side, not locally.
                  </span>
                )}
              </div>
            </>
          ) : status?.ok === false ? (
            <Note tone="bad">
              Faucet unavailable: {status.error || "the gateway could not report its state."}
            </Note>
          ) : (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13.5px]">
                <dt className="text-dim">your wallet</dt>
                <dd><AddressLink address={address} /></dd>
                <dt className="text-dim">amount</dt>
                <dd className="tnum text-text">{amount} MUSD</dd>
                <dt className="text-dim">cooldown</dt>
                <dd className="text-muted">{status?.cooldownHours ?? 48} hours between claims</dd>
                <dt className="text-dim">status</dt>
                <dd>
                  {eligible
                    ? <Badge tone="ok"><Dot tone="ok" /> ready to claim</Badge>
                    : nextAt
                      ? <Badge tone="warn">next claim {nextAt.toLocaleString()}</Badge>
                      : <Badge tone="neutral">checking…</Badge>}
                </dd>
                {status?.operatorBalance !== undefined && (
                  <>
                    <dt className="text-dim">operator float</dt>
                    <dd className="tnum text-muted">
                      {fmtMusd(status.operatorBalance, 2)} MUSD left to distribute
                    </dd>
                  </>
                )}
              </dl>

              {mine.status && (
                <div className="mt-5 grid grid-cols-2 gap-4 rounded-xl border border-line-soft bg-ink-dim/50 p-4 sm:grid-cols-4">
                  <Stat label="Your float" value={floatMusd} unit="MUSD" />
                  <Stat
                    label="Per-call max"
                    value={Number(ethers.formatUnits(mine.status.perCallMax, 18))}
                    unit="MUSD"
                  />
                  <Stat
                    label="Daily cap"
                    value={Number(ethers.formatUnits(mine.status.dailyCap, 18))}
                    unit="MUSD"
                    hint="resets 00:00 UTC"
                  />
                  <Stat label="Funding left today" value={fmtMusd(mine.status.remainingToday, 2)} unit="MUSD"
                        hint="float the treasury may still release today — not a spend budget" />
                </div>
              )}
              {mine.status && (
                <p className="mt-2.5 text-[12.5px] text-dim">
                  Read from the treasury contract, not from the gateway. Reshape those caps any time
                  on the{" "}
                  <Link to="/operate" className="text-info underline decoration-line underline-offset-2 hover:decoration-info">
                    Operate
                  </Link>{" "}
                  page — you sign, the protocol applies it inside a published ceiling.
                </p>
              )}

              {!eligible && nextAt && (
                <Note tone="warn" className="mt-4">
                  You already claimed within the last {status?.cooldownHours ?? 48} hours. The
                  cooldown is per wallet address and is stored on the gateway, so it survives a
                  restart. Come back <Countdown to={nextAt} />.
                </Note>
              )}

              {status?.budgetExhausted && (
                <Note tone="bad" className="mt-4">
                  The faucet budget is exhausted ({status.budgetReason || status.reason}). The
                  operator wallet is not drained by design — global caps bound total and daily
                  outflow.
                </Note>
              )}

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Button variant="primary" onClick={claim} disabled={busy || !eligible}>
                  {busy ? step || "…" : `Claim ${amount} MUSD`}
                </Button>
                {busy && step && <span className="max-w-sm text-[13.5px] leading-relaxed text-muted">{step}</span>}
              </div>

              <Note className="mt-4">
                Claiming asks you to sign a short message. That signature is how the gateway knows
                you control this address — without it, anyone could POST an address and drain the
                operator wallet. Nothing is spent by signing; it authorizes no transfer.
              </Note>

              {err && <Note tone="bad" className="mt-4">{err}</Note>}

              {result?.ok && (
                <Note tone="ok" className="mt-4">
                  <b>Sent {result.amountMusd ?? amount} MUSD.</b>
                  {result.txHash && <> Transfer: <TxLink hash={result.txHash} /></>}
                  {result.confirmed === false && (
                    <span className="text-dim">
                      {" "}· broadcast, confirmation not observed within 25s — the Mezo testnet RPC
                      often reports receipts late, so trust the explorer link.
                    </span>
                  )}
                  {result.registered
                    ? <> Your wallet is now registered as an agent in the treasury.</>
                    : <> Your wallet was already registered as an agent.</>}
                  <p className="mt-2.5 text-[13.5px] leading-relaxed text-muted">
                    Before the first payment: x402 settles through Permit2, which needs one approval signed by this wallet —
                    and that approval is a transaction, so a brand-new wallet also needs a little BTC for gas. Both are
                    handled in the popup; neither needs a terminal.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" onClick={() => setApprovalOpen(true)}>Enable payments →</Button>
                    <Link to="/spend"><Button size="sm">Spend it with x402 →</Button></Link>
                    <Link to="/alerts"><Button size="sm">Get Telegram alerts →</Button></Link>
                    <Link to="/operate"><Button size="sm">Set my caps →</Button></Link>
                  </div>
                </Note>
              )}
            </>
          )}
        </Card>

        <div className="space-y-5">
          <Card title="Faucet state">
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Per claim" value={amount} unit="MUSD" />
              <Stat label="Cooldown" value={status?.cooldownHours ?? 48} unit="hours" />
              <Stat label="Claims served" value={status?.totalClaims ?? "—"} />
              <Stat label="Distributed" value={status?.totalDistributed !== undefined ? fmtMusd(status.totalDistributed, 2) : "—"} unit="MUSD" />
            </div>
            {status?.caps && (
              <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13.5px]">
                <dt className="text-dim">daily cap</dt>
                <dd className="tnum text-muted">{status.caps.dailyMusd} MUSD</dd>
                <dt className="text-dim">total cap</dt>
                <dd className="tnum text-muted">{status.caps.totalMusd} MUSD</dd>
                <dt className="text-dim">today</dt>
                <dd className="tnum text-muted">{status.caps.distributedTodayMusd} MUSD</dd>
              </dl>
            )}
          </Card>

          <Card title="What the claim does">
            <ol className="space-y-2.5 text-[13.5px] leading-relaxed text-muted">
              <Step n={1}>Verifies your signature recovers to your wallet address.</Step>
              <Step n={2}>Checks the 48h cooldown and the global caps.</Step>
              <Step n={3}>Registers your wallet as an agent in the treasury with a per-call max and a daily cap, so it is governed like any other agent.</Step>
              <Step n={4}>Transfers {amount} MUSD from the operator wallet to you.</Step>
            </ol>
            <Note className="mt-4">
              Registration is what makes this more than a giveaway: your wallet appears in the ledger,
              its payments and refusals are recorded on chain, alerts can be bound to it, and the
              operator can pause or recall it.
            </Note>
          </Card>

          {health?.faucet?.operatorAddress && (
            <Card title="Source wallet">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13.5px]">
                <dt className="text-dim">operator</dt>
                <dd><AddressLink address={health.faucet.operatorAddress} /></dd>
                <dt className="text-dim">MUSD balance</dt>
                <dd className="tnum text-muted">{fmtMusd(health.faucet.operatorBalance, 2)}</dd>
              </dl>
              <Note tone="warn" className="mt-4">
                This is the same wallet that owns the treasury. On testnet that is fine and keeps the
                demo simple; in production the faucet should be funded from its own wallet with a
                hard budget, so a drained faucet cannot touch treasury ownership.
              </Note>
            </Card>
          )}
        </div>
      </div>
      <ApprovalModal
        open={approvalOpen}
        onClose={() => setApprovalOpen(false)}
        wallet={session.agentWallet}
        address={session.agentAddress}
        signMessage={session.signMessage}
      />
    </div>
  );
}

function Step({ n, children }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 grid h-4.5 w-4.5 shrink-0 place-items-center rounded-full border border-line bg-ink-soft text-[11.5px] text-btc">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

function Countdown({ to }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const ms = to.getTime() - Date.now();
  if (ms <= 0) return <b className="text-ok">now</b>;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return <b className="tnum text-text">in {h}h {m}m</b>;
}
