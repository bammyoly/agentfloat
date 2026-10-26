// ---------------------------------------------------------------------------
// Dashboard — YOUR agent first, shared protocol state last.
//
// LAYOUT IS A PRODUCT DECISION, NOT COSMETICS.
//   The earlier version opened with the treasury and the gateway's demo agent,
//   which read to a brand-new user as "I already have a balance I did not put
//   there". They do not: the treasury is shared protocol state and the demo
//   agent belongs to the operator's gateway. So the page opens with the three
//   things that are actually the visitor's — their wallet, their activity, and
//   the next step — and everything shared sits below a labelled divider.
//
//   The signed-in user's wallet is still read straight from the treasury
//   contract, not from the gateway: agentStatus() reverts for an unregistered
//   address, and that revert is the signal that points them at the faucet
//   instead of an error to surface.
//
// ANALYTICS, AND WHERE THE NUMBERS COME FROM
//   The activity panels are drawn from the treasury's own receipts via
//   /api/chain-records — payments and denials the contract stored — never from a
//   counter the frontend keeps. Two consequences worth stating on the page:
//     • the figures survive a reload, a different device and a gateway restart,
//       because they are on chain;
//     • they are a WINDOW (the last `recordWindow` records), so the panel says
//       how many it read rather than implying it has all of history.
//   The same <ActivityPanel /> renders both scopes with different inputs, so
//   "your activity" and "protocol activity" cannot drift apart in colour, empty
//   state or arithmetic.
//
// EVERY STATE IS EXPLICIT.
//   provisioning → hero skeleton, no numbers at all
//   reading      → skeleton bars, never a zero that could be read as a balance
//   unfunded     → a real 0.0000 plus the one action that changes it
//   funded       → the caps grid and a live meter
//   A dashboard that shows 0.0000 while it is still loading teaches the user
//   that their money vanished; that is why the loading branch has no number.
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity, Bell, Check, CircleAlert, CircleCheck, Clock, Coins, Gauge, KeyRound,
  Landmark, LayoutDashboard, Lock, PlugZap, ReceiptText, ShieldCheck,
  TrendingUp, Wallet, Zap,
} from "lucide-react";
import { useAppData } from "../lib/app-data.jsx";
import { telegramStatus } from "../lib/gateway.js";
import { useSession } from "../lib/session.jsx";
// Shared with Spend, Operate and Faucet: one read of agentStatus(), one copy of
// the revert-means-unregistered handling.
import { useAgentStatus } from "../lib/agent-status.jsx";
import { readAllowance } from "../lib/permit2.js";
import ApprovalModal from "../components/ApprovalModal.jsx";
import ActivityPanel from "../components/Analytics.jsx";
import {
  AddressLink, Badge, Button, Card, Dot, Grid, Icon, Meter, MoreLink, Note,
  PageHeader, SectionDivider, Stat,
} from "../components/ui.jsx";
import { forAgent } from "../lib/charts-data.js";
import { fmtMusd } from "../lib/chain.js";
import { CHAIN, SAVINGS_VAULT, explorerToken, MUSD_ADDRESS } from "../contracts/index.js";

export default function Dashboard() {
  const { health, loading, deployed, chainRecords, recordWindow } = useAppData();
  const session = useSession();

  // BEFORE the !deployed return, not after it. A hook below an early return
  // changes the hook count between renders the moment `deployed` flips — React
  // then throws "Rendered more hooks than during the previous render" and takes
  // the whole page down, which is what an artifact file appearing late does.
  const agentStatus = useAgentStatus(session.agentAddress);

  // The MUSD → Permit2 allowance. Read here, above the !deployed return, for the
  // same reason as agentStatus: a hook below an early return changes the hook count
  // between renders and takes the page down.
  const [allowance, setAllowance] = useState(null);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const refreshAllowance = useCallback(async () => {
    if (!session.agentAddress) { setAllowance(null); return; }
    setAllowance(await readAllowance(session.agentAddress));
  }, [session.agentAddress]);
  useEffect(() => { refreshAllowance(); }, [refreshAllowance]);

  // --- the receipts this page charts ---------------------------------------
  const payments = chainRecords?.payments || [];
  const denials = chainRecords?.denials || [];
  const mine = useMemo(
    () => ({
      payments: forAgent(payments, session.agentAddress),
      denials: forAgent(denials, session.agentAddress),
    }),
    [payments, denials, session.agentAddress]
  );
  // Honest window labelling: if fewer records came back than we asked for, the
  // panel says how many it has rather than claiming the full window.
  const windowNote = (count) =>
    count >= recordWindow
      ? `last ${recordWindow} on-chain records`
      : `${count} on-chain record${count === 1 ? "" : "s"}`;

  if (!deployed) {
    return (
      <Note tone="warn" icon={Lock} title="No deployment found">
        Run <span className="code">npm run deploy</span> from the repo root, which writes the
        artifacts the frontend reads. Until then there is no treasury to show you a balance from.
      </Note>
    );
  }

  return (
    <div className="animate-fade space-y-8 pb-12">
      <PageHeader
        icon={LayoutDashboard}
        eyebrow="your agent"
        title="Dashboard"
        sub="Your wallet, your budget, your payments. Everything shared — the treasury and the operator's demo agent — is separated below a divider that says so."
        aside={
          <>
            {session.agentAddress && (
              <Badge tone="btc" icon={Wallet} title="The wallet Privy created for this login">
                <AddressLink address={session.agentAddress} chars={4} explore={false} />
              </Badge>
            )}
            <Badge tone={health && !health.unreachable ? "ok" : "bad"} icon={Activity}>
              <Dot tone={health && !health.unreachable ? "ok" : "bad"} pulse={!health || health.unreachable} />
              {health && !health.unreachable ? "gateway online" : "gateway offline"}
            </Badge>
          </>
        }
      />

      {/* --- yours: the wallet, then what to do next ------------------------ */}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <YourAgent
            session={session}
            agentStatus={agentStatus}
            allowance={allowance}
            approved={Boolean(allowance && allowance > 0n)}
            onEnable={() => setApprovalOpen(true)}
          />
        </div>
        <div className="lg:col-span-1">
          <NextSteps
            session={session}
            agentStatus={agentStatus}
            approved={Boolean(allowance && allowance > 0n)}
            onEnable={() => setApprovalOpen(true)}
          />
        </div>
      </div>

      {/* --- yours: what this wallet has actually done, from the chain ------ */}
      <ActivityPanel
        scope="you"
        icon={Wallet}
        tone="btc"
        title="Your activity"
        sub="Every payment and refusal this wallet has on the treasury — read from the chain, not from a counter in this browser."
        payments={mine.payments}
        denials={mine.denials}
        windowNote={windowNote(mine.payments.length + mine.denials.length)}
        emptyTo="/spend"
        emptyCta="Make your first payment"
      />

      <AlertsTeaser address={session.agentAddress} registered={agentStatus.registered} />

      <ApprovalModal
        open={approvalOpen}
        onClose={() => setApprovalOpen(false)}
        wallet={session.agentWallet}
        address={session.agentAddress}
        signMessage={session.signMessage}
        amountWei={null}
        onApproved={() => refreshAllowance()}
      />

      {/* Divider that says in words where "yours" stops and "shared" starts. */}
      <SectionDivider>Shared Protocol Infrastructure</SectionDivider>

      <ProtocolSection
        health={health}
        loading={loading}
        payments={payments}
        denials={denials}
        windowNote={windowNote(payments.length + denials.length)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Your agent — hero wallet
// ---------------------------------------------------------------------------

function YourAgent({ session, agentStatus, allowance, approved = false, onEnable = null }) {
  // Sign-in is gated by RequireSession, but the provider can still be off
  // entirely (no VITE_PRIVY_APP_ID), in which case there is no wallet to show.
  if (!session.configured) {
    return (
      <Card icon={Wallet} title="Your agent" aside={<Badge tone="neutral" icon={Lock}>sign-in disabled</Badge>}>
        <Note icon={KeyRound}>
          Configure <span className="code">VITE_PRIVY_APP_ID</span> to give every visitor their own agent wallet behind a
          Google or email login.
        </Note>
      </Card>
    );
  }

  // Privy creates the embedded wallet asynchronously after login. Google takes
  // visibly longer than email because of the OAuth round-trip before
  // provisioning starts; saying so turns a scary blank into a wait.
  if (!session.agentAddress) {
    return (
      <Card
        icon={Wallet}
        title="Provisioning wallet"
        aside={<Badge tone="warn"><Dot tone="warn" pulse /> processing</Badge>}
      >
        <p className="text-[14.5px] leading-relaxed text-muted">
          Privy is generating your embedded wallet now, inside its TEE — the key never reaches this browser or our
          gateway. Google sign-in usually takes a little longer than email because of the OAuth round-trip, and creation
          runs once per identity: the same login gets the same address and the same balance on every later visit.
        </p>

        {/* Skeleton of the hero that is about to appear, so the shape of the
            page does not jump when the wallet lands. */}
        <div className="mt-6 animate-pulse rounded-xl border border-line-soft bg-ink-dim p-4">
          <div className="mb-4 h-11 w-52 rounded-lg bg-line-soft" />
          <div className="flex gap-4">
            <div className="h-20 w-full rounded-lg bg-line-soft" />
            <div className="h-20 w-full rounded-lg bg-line-soft" />
            <div className="h-20 w-full rounded-lg bg-line-soft" />
          </div>
        </div>

        <Note className="mt-4" icon={Clock}>
          Nothing to click — this page re-reads your session on its own. If it is still provisioning after a minute or
          two, sign out and back in; Privy reattaches the wallet it started rather than making a second one.
        </Note>
      </Card>
    );
  }

  const s = agentStatus.status;
  const isUnregistered = agentStatus.registered === false;
  const isLoading = agentStatus.loading || (!s && !isUnregistered);

  return (
    <Card
      className="relative overflow-hidden"
      icon={Wallet}
      tone="btc"
      title={
        // A <span>, not a <div>: Card renders `title` inside an <h2>, and a div
        // in a heading is invalid flow content even though browsers allow it.
        <span className="flex flex-wrap items-center gap-2.5">
          Your Agent Wallet
          <Badge
            tone="info"
            icon={KeyRound}
            title="x402 authorization is an EIP-712 permit2 signature, which a contract wallet cannot produce"
          >
            embedded EOA
          </Badge>
          {allowance !== null && (
            approved
              ? <Badge tone="ok" icon={ShieldCheck} title="This wallet has approved Permit2, so x402 can settle">payments enabled</Badge>
              : <Badge tone="warn" icon={Lock} title="Without one approval from this wallet every payment is refused">approval needed</Badge>
          )}
        </span>
      }
      aside={
        isUnregistered ? (
          <Badge tone="warn" icon={Coins}>wallet created · unfunded</Badge>
        ) : isLoading ? (
          <Badge tone="warn"><Dot tone="warn" pulse /> reading chain</Badge>
        ) : (
          <Badge tone="ok" icon={Landmark}><Dot tone="ok" /> live on-chain</Badge>
        )
      }
    >
      {/* --- hero: the float, the address, and the two primary operations --- */}
      <div className="mt-1 flex flex-col justify-between gap-6 border-b border-line-soft pb-6 md:flex-row md:items-end">
        <div className="min-w-0">
          <div className="stat-label">spendable float</div>

          {isUnregistered ? (
            // A genuine zero: an unregistered wallet cannot hold float, because
            // the faucet registers and funds in the same transaction.
            <div className="mt-1 text-[36px] leading-none font-light text-dim">
              0.0000 <span className="text-[20px]">MUSD</span>
            </div>
          ) : isLoading ? (
            // No number while the chain read is in flight. A pulsing 0.0000 is
            // indistinguishable from "your balance is gone".
            <div className="mt-2 h-11 w-56 animate-pulse rounded-lg bg-line-soft" />
          ) : (
            <div className="tnum mt-1 text-[40px] leading-none font-light tracking-tight text-text">
              {fmtMusd(s?.walletBalance, 4)} <span className="text-[20px] font-medium text-muted">MUSD</span>
            </div>
          )}

          <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-line-soft bg-ink-dim px-3 py-1.5">
            <Icon as={Wallet} size={13} className="text-dim" />
            <AddressLink address={session.agentAddress} chars={8} size={13} />
          </div>
        </div>

        {/* Operations live beside the wallet they operate on. */}
        <div className="flex w-full flex-col gap-2.5 sm:flex-row md:w-auto">
          <Link to="/faucet" className="w-full sm:w-auto">
            <Button variant="primary" size="lg" icon={Coins} className="w-full">
              {isUnregistered ? "Claim 10 MUSD" : "Top up faucet"}
            </Button>
          </Link>
          <Link to="/spend" className="w-full sm:w-auto">
            <Button
              size="lg"
              icon={PlugZap}
              className="w-full"
              disabled={isUnregistered}
              title={isUnregistered ? "Claim from the faucet first — spending needs a registered wallet" : "Pay for an HTTP resource with x402"}
            >
              Pay an API
            </Button>
          </Link>
          {!approved && onEnable && !isUnregistered && (
            <Button size="lg" variant="ghost" className="w-full border border-warn/40 text-warn hover:bg-warn/10 sm:w-auto"
                    icon={ShieldCheck} onClick={onEnable}
                    title="One approval from your wallet lets Permit2 settle x402 payments">
              Enable payments
            </Button>
          )}
        </div>
      </div>

      {/* --- the on-chain policy that bounds this wallet -------------------- */}
      {isUnregistered ? (
        <div className="mt-6">
          <Note tone="warn" icon={Coins} title="This wallet exists but holds no MUSD">
            It is not registered in the treasury yet either. The faucet fixes both in one step: it registers the wallet
            with on-chain caps and airdrops 10 MUSD.
          </Note>
        </div>
      ) : isLoading ? (
        <div className="mt-6 animate-pulse rounded-xl border border-line-soft bg-ink-dim/60 p-5">
          <div className="mb-3 h-3 w-40 rounded bg-line-soft" />
          <div className="flex gap-4">
            <div className="h-16 w-full rounded-lg bg-line-soft" />
            <div className="h-16 w-full rounded-lg bg-line-soft" />
            <div className="h-16 w-full rounded-lg bg-line-soft" />
          </div>
        </div>
      ) : (
        <div className="mt-6 rounded-xl border border-line-soft bg-ink-dim/50 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[12.5px] font-semibold tracking-[0.06em] text-dim uppercase">
              <Icon as={Gauge} size={14} />
              on-chain caps
            </span>
            <MoreLink to="/operate">Change your budget</MoreLink>
          </div>
          <Grid cols={3} className="gap-6">
            <Stat icon={Clock} label="Funding left today" value={fmtMusd(s?.remainingToday, 2)} unit="MUSD"
                  hint="float the treasury may still release today — not a spend budget" />
            <Stat icon={Gauge} label="Daily cap" value={fmtMusd(s?.dailyCap, 2)} unit="MUSD" hint="resets 00:00 UTC" />
            <Stat icon={ShieldCheck} label="Per-call max" value={fmtMusd(s?.perCallMax, 2)} unit="MUSD" hint="single payment limit" />
          </Grid>

          {/* NO METER HERE, deliberately. How much of today's cap has been
              SPENT is knowable only by summing the treasury's receipts, which the
              Spend page does against a live quote. Drawing a meter on the
              contract's funding counter instead is the exact confusion that
              produced the "daily cap that never capped anything" bug, so this row
              says where the real figure lives. */}
          <div className="mt-5 border-t border-line-soft pt-4">
            <p className="text-[13.5px] leading-relaxed text-dim">
              Today's <b className="text-muted">spending</b> against that cap is summed from the treasury's receipts on
              the <Link to="/spend" className="text-info hover:underline">Spend</Link> page, where a live quote makes it
              exact. The figure above is the contract's <b className="text-muted">funding</b> headroom — a different
              budget with a similar name, and not a spend meter.
            </p>
          </div>
        </div>
      )}

      {/* --- lifetime counters ---------------------------------------------- */}
      {s && (
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2.5 border-t border-line-soft pt-4 text-[13px] text-dim">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-btc/60" />
            lifetime funded <b className="tnum text-muted">{fmtMusd(s.lifetimeFunded, 4)}</b>
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-bad/60" />
            lifetime recalled <b className="tnum text-muted">{fmtMusd(s.lifetimeRecalled, 4)}</b>
          </span>
          <span className="flex items-center gap-2">
            <Icon as={CircleCheck} size={13} className="text-ok" />
            payments <b className="tnum text-muted">{s.payments?.toString() || "0"}</b>
          </span>
          <span className="flex items-center gap-2">
            <Icon as={ShieldCheck} size={13} className="text-bad" />
            refusals <b className="tnum text-muted">{s.denials?.toString() || "0"}</b>
          </span>
        </div>
      )}
    </Card>
  );
}


// ---------------------------------------------------------------------------
// Next steps — vertical timeline in the right rail
// ---------------------------------------------------------------------------

const STEP_ICONS = [Wallet, Coins, ShieldCheck, PlugZap, ReceiptText];

function NextSteps({ session, agentStatus, approved = false, onEnable = null }) {
  const s = agentStatus.status;
  const hasWallet = Boolean(session.agentAddress);
  const funded = agentStatus.registered === true;
  const hasPaid = Boolean(s && BigInt(s.payments || 0) > 0n);

  // `always` means "keep the link after the step is done" — the ledger is a
  // destination you return to, unlike the faucet claim you just made.
  const steps = [
    {
      title: "Create agent wallet",
      body: "Generated by Privy in a TEE — one wallet per identity, reattached on every login.",
      done: hasWallet,
      to: null,
      cta: hasWallet ? null : "Waiting on Privy…",
    },
    {
      title: "Claim 10 MUSD",
      body: "Registers you as an agent with on-chain caps and drops the float. One claim per wallet per 48h.",
      done: funded,
      to: "/faucet",
      cta: funded ? null : "Go to faucet",
    },
    {
      title: "Enable payments",
      // The step that used to be missing: without one approval from this wallet,
      // every payment is refused with permit2_not_approved and the only remedy on
      // offer was a developer script. It opens a popup, not a terminal.
      body: "One approval from your wallet lets Permit2 settle x402 payments. You choose: this payment only, or all future ones.",
      done: approved,
      to: null,
      onClick: onEnable,
      cta: !hasWallet || approved ? null : "Approve Permit2",
    },
    {
      title: "First x402 payment",
      body: "Pay for a real HTTP resource with permit2-settled MUSD, bounded by your caps.",
      done: hasPaid,
      to: "/spend",
      cta: hasPaid ? null : "Spend it",
    },
    {
      title: "Verify on ledger",
      body: "Every payment and refusal, classified against the chain — not against the seller's word.",
      done: hasPaid,
      to: "/ledger",
      cta: hasPaid ? "Open ledger" : "View ledger",
      always: true,
    },
  ];

  // The first incomplete step is the one worth drawing the eye to.
  const current = steps.findIndex((st) => !st.done);
  const doneCount = steps.filter((st) => st.done).length;

  return (
    <Card
      icon={TrendingUp}
      tone="ok"
      title="Onboarding"
      sub="Five steps from a login to a payment that is provably on chain."
      className="h-full"
      aside={
        <Badge tone={current === -1 ? "ok" : "btc"}>
          {current === -1 ? "ready" : `step ${current + 1} of ${steps.length}`}
        </Badge>
      }
    >
      {/* Progress, because "step 3 of 5" is a claim worth seeing as a bar. */}
      <div className="mb-5">
        <Meter
          pct={(doneCount / steps.length) * 100}
          tone={doneCount === steps.length ? "ok" : "btc"}
          height={6}
          label="onboarding steps completed"
        />
        <div className="mt-2 flex items-center justify-between text-[12.5px] text-dim">
          <span className="tnum">{doneCount} of {steps.length} complete</span>
          {current === -1
            ? <span className="text-ok">everything is set up</span>
            : <span>next: {steps[current].title.toLowerCase()}</span>}
        </div>
      </div>

      <div className="relative">
        {/* the rail the markers sit on */}
        <div className="absolute top-2 bottom-6 left-[13px] w-px bg-line-soft" />

        <div className="space-y-6">
          {steps.map((st, i) => {
            const isPast = st.done;
            const isCurrent = i === current;
            const isFuture = !isPast && !isCurrent;
            const showCta = st.cta && (!isPast || st.always);
            const Glyph = STEP_ICONS[i] || CircleCheck;

            return (
              <div key={st.title} className="group relative flex flex-col pl-11">
                {/* marker */}
                <div
                  className={`absolute top-0 left-0 grid h-[27px] w-[27px] place-items-center rounded-full border-2 bg-ink transition-colors ${
                    isPast
                      ? "border-ok text-ok"
                      : isCurrent
                        ? "border-btc bg-btc/12 text-btc shadow-[0_0_12px_rgba(247,147,26,0.28)]"
                        : "border-line-soft text-faint"
                  }`}
                >
                  {isPast
                    ? <Icon as={Check} size={14} />
                    : <Icon as={Glyph} size={13} className={isFuture ? "opacity-60" : ""} />}
                </div>

                {/* Done steps recede but stay readable on hover: they are the
                    record of what this wallet has already done. */}
                <div className={isPast ? "opacity-65 transition-opacity hover:opacity-100" : ""}>
                  <h4 className={`text-[14.5px] leading-snug font-semibold tracking-tight ${isFuture ? "text-dim" : "text-text"}`}>
                    {st.title}
                  </h4>
                  <p className="mt-1 pr-2 text-[13px] leading-relaxed text-dim">{st.body}</p>

                  {showCta && (
                    <div className="mt-3">
                      {st.onClick ? (
                        <Button
                          size="sm"
                          variant={isCurrent ? "primary" : "ghost"}
                          className={isCurrent ? "" : "border border-line-soft"}
                          icon={isCurrent ? ShieldCheck : undefined}
                          onClick={st.onClick}
                        >
                          {st.cta}
                        </Button>
                      ) : st.to ? (
                        <Link to={st.to}>
                          <Button
                            size="sm"
                            variant={isCurrent ? "primary" : "ghost"}
                            className={isCurrent ? "" : "border border-line-soft"}
                          >
                            {st.cta}
                          </Button>
                        </Link>
                      ) : (
                        <span className="inline-flex items-center gap-2 rounded-lg border border-line-soft bg-ink-dim px-2.5 py-1.5 text-[12.5px] font-medium text-muted">
                          <Icon as={Clock} size={12} />
                          {st.cta}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared protocol state — deliberately last
// ---------------------------------------------------------------------------

function ProtocolSection({ health, loading, payments, denials, windowNote }) {
  const treasury = health?.treasury || {};
  const agent = health?.agent || {};
  const policy = agent.policy || {};
  const permit2 = agent.permit2 || {};

  const held = BigInt(treasury.balance || 0);
  const funded = BigInt(treasury.totalFunded || 0);
  const total = held + funded;
  const pct = total > 0n ? Number((funded * 10000n) / total) / 100 : 0;

  return (
    <section className="space-y-6">
      {/* What the protocol as a whole has done. Same component as "your
          activity" above, different inputs — so the two cannot disagree about
          what a refusal looks like. */}
      <ActivityPanel
        scope="protocol"
        icon={Activity}
        tone="info"
        title="Protocol activity"
        sub="Every agent wallet on this treasury, from the receipts the contract itself stored."
        payments={payments}
        denials={denials}
        windowNote={windowNote}
      />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        {/* Treasury */}
        <Card
          icon={Landmark}
          tone="btc"
          title="Master Treasury"
          sub="The vault every agent's float comes from, and goes back to."
          aside={
            <>
              <Badge tone="info" icon={Lock}>on-chain vault</Badge>
              <Badge tone={treasury.paused ? "bad" : "ok"}>
                <Dot tone={treasury.paused ? "bad" : "ok"} pulse={!treasury.paused} />
                {treasury.paused ? "paused" : "active"}
              </Badge>
            </>
          }
        >
          <Grid cols={2} className="gap-4">
            <div className="rounded-xl border border-line-soft bg-gradient-to-br from-panel-2/60 to-ink-dim p-4">
              <Stat icon={Coins} label="MUSD vault balance" value={loading ? "…" : fmtMusd(treasury.balance, 2)} unit="MUSD" />
            </div>
            <div className="rounded-xl border border-line-soft bg-gradient-to-br from-panel-2/60 to-ink-dim p-4">
              <Stat icon={TrendingUp} label="Total released" value={loading ? "…" : fmtMusd(treasury.totalFunded, 2)} unit="MUSD" />
            </div>
          </Grid>

          <div className="mt-6 rounded-xl border border-line-soft bg-ink-dim p-4">
            <div className="mb-2.5 flex items-center justify-between text-[12.5px] font-medium text-dim">
              <span className="uppercase tracking-[0.06em]">Budget deployed to agents</span>
              <span className="tnum text-[15px] font-semibold text-text">{pct.toFixed(1)}%</span>
            </div>
            <Meter pct={pct} tone="btc" live height={10} label="share of the treasury released to agents" />
            <div className="mt-2.5 flex items-center justify-between text-[12.5px] text-dim">
              <span>recalled to treasury</span>
              <span className="tnum text-muted">{loading ? "…" : `${fmtMusd(treasury.totalRecalled, 2)} MUSD`}</span>
            </div>
          </div>

          {treasury.paused && (
            <Note tone="bad" className="mt-4" icon={Lock} title="Paused">
              No further releases until the owner unpauses. Agents already holding float can still spend it — use
              EMERGENCY STOP to sweep it back.
            </Note>
          )}
        </Card>
        <Card
          icon={Zap}
          title="Operator Demo Agent"
          sub="The gateway's own wallet. It is not yours, and its budget is not your budget."
          aside={
            <Badge tone={agent.registered ? "neutral" : "warn"} icon={agent.registered ? Lock : CircleAlert}>
              {agent.registered ? "gateway owned · not yours" : "not registered"}
            </Badge>
          }
        >
          {agent.registered ? (
            <>
              <Grid cols={3} className="gap-4 border-b border-line-soft pb-5">
                {/* 4dp: this agent spends 0.001 per call, so 2dp would round the
                    float away — the whole point of the number. */}
                <Stat icon={Coins} label="Float" value={fmtMusd(agent.walletBalance, 4)} unit="MUSD" />
                <Stat icon={Gauge} label="Per-call" value={fmtMusd(policy.perCallMax, 2)} unit="MUSD" />
                {/* This agent's spend IS known — the gateway sums the treasury's
                    on-chain receipts for it — so show the spending budget rather
                    than the contract's funding counter. Falls back for a gateway
                    too old to report it. */}
                {policy.leftToday ? (
                  <Stat icon={TrendingUp} label="Left to spend today" value={fmtMusd(policy.leftToday, 4)} unit="MUSD"
                        hint={`${fmtMusd(policy.spentToday, 4)} spent · on-chain receipts`} />
                ) : (
                  <Stat icon={Clock} label="Funding left today" value={fmtMusd(policy.remainingToday, 2)} unit="MUSD"
                        hint="float the treasury may still release today — not a spend budget" />
                )}
              </Grid>

              {policy.leftToday && policy.dailyCap && (
                <div className="mt-5 rounded-xl border border-line-soft bg-ink-dim p-4">
                  <div className="mb-2.5 flex items-center justify-between text-[12.5px] text-dim">
                    <span className="uppercase tracking-[0.06em]">today's spending cap</span>
                    <span className="tnum text-[14px] font-semibold text-text">
                      {fmtMusd(policy.spentToday, 4)} / {fmtMusd(policy.dailyCap, 4)}
                    </span>
                  </div>
                  <Meter
                    pct={Number(BigInt(policy.dailyCap) > 0n
                      ? (BigInt(policy.spentToday || 0) * 10000n) / BigInt(policy.dailyCap)
                      : 0n) / 100}
                    label="share of the demo agent's daily cap spent"
                  />
                </div>
              )}

              <dl className="dl mt-5 text-[13.5px]">
                <dt>address</dt>
                <dd className="text-right">{<AddressLink address={health?.agentWallet} />}</dd>
                <dt>permit2 auth</dt>
                <dd className="flex justify-end">
                  {permit2.ready
                    ? <Badge tone="ok" icon={ShieldCheck}>granted — x402 can settle</Badge>
                    : <Badge tone="bad" icon={Lock} title="Run: cd contract && npm run permit2:grant">missing — payments fail</Badge>}
                </dd>
                <dt>emergency recall</dt>
                <dd className="flex justify-end">
                  {BigInt(policy.recallAllowance || 0) > 0n
                    ? <Badge tone="ok" icon={CircleCheck}>granted</Badge>
                    : <Badge tone="warn" icon={Lock}>none — can pause, not sweep</Badge>}
                </dd>
                <dt>funding today</dt>
                <dd className="tnum text-right">
                  {fmtMusd(policy.dayFunded, 2)} of {fmtMusd(policy.dailyCap, 2)} MUSD
                </dd>
              </dl>
            </>
          ) : (
            <div className="flex h-full flex-col justify-center">
              <Note tone="warn" icon={Wallet} title="No agent wallet is configured in the gateway">
                Run <span className="code">npm run setup-agent</span> from the repo root. Until then the demo agent path on
                the Spend page has nothing to sign with — your own wallet still works.
              </Note>
            </div>
          )}
        </Card>
      </div>

      {/* sMUSD vault + chain facts */}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card
            icon={TrendingUp}
            title="Yield surplus (sMUSD)"
            sub="What idle float would earn, and why this app does not pretend it can."
            aside={<Badge tone="warn" icon={Lock}>unavailable on testnet</Badge>}
          >
            <p className="mb-4 text-[14px] leading-relaxed text-muted">
              {SAVINGS_VAULT.note || "The MUSD savings vault is not deployed on Mezo testnet."}
            </p>
            <Grid cols={2} className="gap-3">
              <div className="rounded-lg border border-line-soft bg-ink-dim p-3.5">
                <span className="mb-1.5 flex items-center gap-2 text-[13.5px] font-semibold text-text">
                  <Icon as={CircleCheck} size={14} className="text-ok" /> Not mocked
                </span>
                <p className="text-[13px] leading-relaxed text-dim">
                  The vault proxy holds 0 bytes of bytecode on testnet against 1,159 on mainnet, so there is nothing to
                  deposit into. Rather than show a synthetic APR, the panel says so.
                </p>
              </div>
              <div className="rounded-lg border border-line-soft bg-ink-dim p-3.5">
                <span className="mb-1.5 flex items-center gap-2 text-[13.5px] font-semibold text-text">
                  <Icon as={CircleCheck} size={14} className="text-ok" /> Not ERC-4626 either
                </span>
                <p className="text-[13px] leading-relaxed text-dim">
                  Every standard 4626 getter reverts on mainnet. The real interface is{" "}
                  <span className="code">deposit</span>/<span className="code">withdraw</span>/
                  <span className="code">token()</span>; yield accrues in the exchange rate, weekly.
                </p>
              </div>
            </Grid>
          </Card>
        </div>

        <Card icon={Landmark} title="System contracts" sub="The addresses this deployment is built on.">
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-[12.5px] text-dim">Canonical MUSD</div>
              <a
                href={explorerToken(MUSD_ADDRESS)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[14px] text-info transition-colors hover:text-info/80"
              >
                {MUSD_ADDRESS.slice(0, 8)}…{MUSD_ADDRESS.slice(-6)}
              </a>
            </div>
            <div>
              <div className="mb-1 text-[12.5px] text-dim">Network</div>
              <div className="text-[14px] leading-snug text-muted">
                {CHAIN.name} · <span className="tnum font-mono">{CHAIN.caip2}</span>
              </div>
            </div>
            <div>
              <div className="mb-1 text-[12.5px] text-dim">Gas</div>
              <div className="text-[14px] leading-snug text-muted">
                {CHAIN.nativeCurrency.symbol} is gas, and x402 payments are sponsored by the facilitator — your float is
                never spent on fees.
              </div>
            </div>
            {health?.deployment && (
              <div className="border-t border-line-soft pt-4">
                <div className="mb-1.5 text-[12.5px] text-dim">how this gateway is deployed</div>
                <div className="space-y-1.5 text-[13px] text-muted">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-dim">bind</span>
                    <span className="font-mono">{health.deployment.public ? "public" : "loopback"}:{health.deployment.port}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-dim">owner commands</span>
                    {health.deployment.adminLocked
                      ? <Badge tone="ok" icon={Lock}>token required</Badge>
                      : <Badge tone="warn" icon={Lock}>open — local mode</Badge>}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-dim">state files</span>
                    {health.deployment.persistentState
                      ? <Badge tone="ok" icon={CircleCheck}>persistent disk</Badge>
                      : <Badge tone="neutral">beside the code</Badge>}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Alerts teaser — one row under the wallet, so the notification path is
// discoverable from the page a user actually looks at.
//
// It READS the binding rather than assuming one. "Connected" is a claim about
// the gateway's state and about a chat id stored server-side, and a wrong claim
// here is worse than no claim: a user who believes alerts are on and gets none
// is exactly the failure mode the alerts exist to prevent.
//
// Hidden while the wallet is unfunded — at that point the faucet owns the
// page's attention, and there is nothing worth being alerted about yet.
// ---------------------------------------------------------------------------

function useTelegramBinding(address) {
  const [binding, setBinding] = useState(null);

  useEffect(() => {
    if (!address) { setBinding(null); return undefined; }
    let cancelled = false;
    telegramStatus(address)
      .then((r) => { if (!cancelled && r.ok) setBinding(r); })
      .catch(() => { if (!cancelled) setBinding(null); });
    return () => { cancelled = true; };
  }, [address]);

  return binding;
}

function AlertsTeaser({ address, registered }) {
  const tg = useTelegramBinding(address);
  if (!address || registered === false) return null;

  const copy = !tg
    ? "Reading your alert binding…"
    : !tg.enabled
      ? "No bot is connected to this gateway yet. The one-time setup steps are on the Alerts page."
      : tg.subscribed
        ? `Connected${tg.chatUsername ? ` as @${tg.chatUsername}` : ""}. Payments, refusals and cap changes arrive in Telegram as they happen.`
        : "Not connected. Until you bind a chat, payments and refusals happen silently — binding takes one signature and no key.";

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line-soft bg-ink-dim/50 px-5 py-4">
      <div className="flex min-w-0 items-start gap-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line-soft bg-ink-soft text-info">
          <Icon as={Bell} size={16} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5 text-[14.5px] font-semibold text-text">
            Telegram alerts
            {tg?.subscribed
              ? <Badge tone="ok" icon={CircleCheck}><Dot tone="ok" /> connected</Badge>
              : tg?.enabled
                ? <Badge tone="warn"><Dot tone="warn" /> not connected</Badge>
                : tg
                  ? <Badge tone="neutral"><Dot tone="warn" /> bot not configured</Badge>
                  : null}
          </div>
          <div className="mt-1 text-[13.5px] leading-relaxed text-dim">{copy}</div>
        </div>
      </div>
      <Link to="/alerts" className="shrink-0">
        <Button size="sm" variant={tg?.subscribed ? "ghost" : "primary"}
                icon={Bell}
                className={tg?.subscribed ? "border border-line-soft" : ""}>
          {tg?.subscribed ? "Manage" : tg?.enabled ? "Connect" : "Set up"}
        </Button>
      </Link>
    </div>
  );
}
