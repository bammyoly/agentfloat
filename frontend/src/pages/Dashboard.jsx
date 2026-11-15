import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity, Bell, Check, CircleAlert, CircleCheck, Clock, Coins, Gauge,
  KeyRound, Landmark, LayoutDashboard, Lock, PlugZap, ReceiptText,
  ShieldCheck, TrendingUp, Wallet, Zap, ArrowUpRight,
} from "lucide-react";
import { useAppData } from "../lib/app-data.jsx";
import { telegramStatus } from "../lib/gateway.js";
import { useSession } from "../lib/session.jsx";
import { useAgentStatus } from "../lib/agent-status.jsx";
import { readAllowance } from "../lib/permit2.js";
import { approveAgentPermit2 } from "../lib/agent-permit2.js";
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
  const agentStatus = useAgentStatus(session.agentAddress);

  const [allowance, setAllowance] = useState(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState("");

  const refreshAllowance = useCallback(async () => {
    if (!session.agentAddress) { setAllowance(null); return; }
    try {
      setAllowance(await readAllowance(session.agentAddress));
    } catch {
      setAllowance(0n);
    }
  }, [session.agentAddress]);

  useEffect(() => { refreshAllowance(); }, [refreshAllowance]);

  const approved = Boolean(allowance && allowance > 0n);

  async function onEnablePayments() {
    setApproveError("");
    setApproving(true);
    try {
      // Server signs + sends MUSD.approve(Permit2) from the AGENT key
      await approveAgentPermit2();
      await refreshAllowance();
    } catch (e) {
      setApproveError(e.message || "Approval failed");
    } finally {
      setApproving(false);
    }
  }

  const payments = chainRecords?.payments || [];
  const denials = chainRecords?.denials || [];
  const mine = useMemo(
    () => ({
      payments: forAgent(payments, session.agentAddress),
      denials: forAgent(denials, session.agentAddress),
    }),
    [payments, denials, session.agentAddress]
  );
  const windowNote = (count) =>
    count >= recordWindow
      ? `last ${recordWindow} on-chain records`
      : `${count} on-chain record${count === 1 ? "" : "s"}`;

  if (!deployed) {
    return (
      <Note tone="warn" icon={Lock} title="No deployment found">
        Run <span className="code">npm run deploy</span> from the repo root.
      </Note>
    );
  }

  return (
    <div className="animate-fade space-y-8 pb-12">
      <PageHeader
        icon={LayoutDashboard}
        eyebrow="your agent"
        title="Dashboard"
        sub="Borrow MUSD on Earn, fund your agent, enable Permit2, then spend via x402 — all self-funded."
        aside={
          <>
            {session.agentAddress && (
              <Badge tone="btc" icon={Wallet} title="Server-side agent EOA">
                <AddressLink address={session.agentAddress} chars={4} explore={false} />
              </Badge>
            )}
            {session.primaryAddress && (
              <Badge tone="neutral" icon={KeyRound} title="Connected wallet">
                <AddressLink address={session.primaryAddress} chars={4} explore={false} />
              </Badge>
            )}
            <Badge tone={health && !health.unreachable ? "ok" : "bad"} icon={Activity}>
              <Dot tone={health && !health.unreachable ? "ok" : "bad"} pulse={!health || health.unreachable} />
              {health && !health.unreachable ? "gateway online" : "gateway offline"}
            </Badge>
          </>
        }
      />

      {approveError && (
        <Note tone="bad" icon={CircleAlert} title="Permit2 approval failed">
          {approveError}
        </Note>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <YourAgent
            session={session}
            agentStatus={agentStatus}
            allowance={allowance}
            approved={approved}
            approving={approving}
            onEnable={onEnablePayments}
          />
        </div>
        <div className="lg:col-span-1">
          <NextSteps
            session={session}
            agentStatus={agentStatus}
            approved={approved}
            approving={approving}
            onEnable={onEnablePayments}
          />
        </div>
      </div>

      <ActivityPanel
        scope="you"
        icon={Wallet}
        tone="btc"
        title="Your activity"
        sub="Payments and refusals for this agent — read from the treasury, not a browser counter."
        payments={mine.payments}
        denials={mine.denials}
        windowNote={windowNote(mine.payments.length + mine.denials.length)}
        emptyTo="/earn"
        emptyCta="Fund via Earn"
      />

      <AlertsTeaser address={session.agentAddress} registered={agentStatus.registered} />

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
// Your agent
// ---------------------------------------------------------------------------

function YourAgent({ session, agentStatus, allowance, approved, approving, onEnable }) {
  if (!session.configured) {
    return (
      <Card icon={Wallet} title="Your agent" aside={<Badge tone="neutral" icon={Lock}>sign-in disabled</Badge>}>
        <Note icon={KeyRound}>
          Configure <span className="code">VITE_REOWN_PROJECT_ID</span> to connect a wallet.
        </Note>
      </Card>
    );
  }

  if (!session.agentAddress) {
    return (
      <Card
        icon={Wallet}
        title="Creating agent wallet"
        aside={<Badge tone="warn"><Dot tone="warn" pulse /> processing</Badge>}
      >
        <p className="text-[14.5px] leading-relaxed text-muted">
          AgentFloat is generating a server-side EOA tied to your connected wallet.
          The key is encrypted in MongoDB and never touches this browser — required
          because x402 on Mezo settles with Permit2 (EIP-712), which only an EOA can sign.
        </p>
        <div className="mt-6 animate-pulse rounded-xl border border-line-soft bg-ink-dim p-4">
          <div className="mb-4 h-11 w-52 rounded-lg bg-line-soft" />
          <div className="flex gap-4">
            <div className="h-20 w-full rounded-lg bg-line-soft" />
            <div className="h-20 w-full rounded-lg bg-line-soft" />
            <div className="h-20 w-full rounded-lg bg-line-soft" />
          </div>
        </div>
      </Card>
    );
  }

  const s = agentStatus.status;
  const isLoading = agentStatus.loading;

  return (
    <Card
      className="relative overflow-hidden"
      icon={Wallet}
      tone="btc"
      title={
        <span className="flex flex-wrap items-center gap-2.5">
          Your Agent Wallet
          <Badge tone="info" icon={KeyRound} title="Server-side EOA — signs x402 Permit2">
            server EOA
          </Badge>
          {allowance !== null && (
            approved
              ? <Badge tone="ok" icon={ShieldCheck}>payments enabled</Badge>
              : <Badge tone="warn" icon={Lock}>approval needed</Badge>
          )}
        </span>
      }
      aside={
        isLoading ? (
          <Badge tone="warn"><Dot tone="warn" pulse /> reading chain</Badge>
        ) : (
          <Badge tone="ok" icon={Landmark}><Dot tone="ok" /> live</Badge>
        )
      }
    >
      <div className="mt-1 flex flex-col justify-between gap-6 border-b border-line-soft pb-6 md:flex-row md:items-end">
        <div className="min-w-0">
          <div className="stat-label">spendable float</div>
          {isLoading ? (
            <div className="mt-2 h-11 w-56 animate-pulse rounded-lg bg-line-soft" />
          ) : (
            <div className="tnum mt-1 text-[40px] leading-none font-light tracking-tight text-text">
              {fmtMusd(s?.walletBalance ?? 0n, 4)}{" "}
              <span className="text-[20px] font-medium text-muted">MUSD</span>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <div className="inline-flex items-center gap-2 rounded-lg border border-line-soft bg-ink-dim px-3 py-1.5">
              <Icon as={Wallet} size={13} className="text-dim" />
              <AddressLink address={session.agentAddress} chars={8} size={13} />
            </div>
            {session.primaryAddress && (
              <div className="inline-flex items-center gap-2 rounded-lg border border-line-soft bg-ink-dim px-3 py-1.5 text-[12px] text-dim">
                owner <AddressLink address={session.primaryAddress} chars={4} size={12} />
              </div>
            )}
          </div>
        </div>

        <div className="flex w-full flex-col gap-2.5 sm:flex-row md:w-auto">
          <Link to="/earn" className="w-full sm:w-auto">
            <Button variant="primary" size="lg" icon={Coins} className="w-full">
              Earn · Borrow MUSD
            </Button>
          </Link>
          <Link to="/spend" className="w-full sm:w-auto">
            <Button size="lg" icon={PlugZap} className="w-full" disabled={!approved}
              title={!approved ? "Enable payments first" : "Pay with x402"}>
              Pay an API
            </Button>
          </Link>
          {!approved && (
            <Button
              size="lg"
              variant="ghost"
              className="w-full border border-warn/40 text-warn hover:bg-warn/10 sm:w-auto"
              icon={ShieldCheck}
              onClick={onEnable}
              busy={approving}
              disabled={approving}
              title="Server-side MUSD.approve(Permit2) from your agent EOA"
            >
              {approving ? "Approving…" : "Enable payments"}
            </Button>
          )}
        </div>
      </div>

      {/* caps */}
      <div className="mt-6 rounded-xl border border-line-soft bg-ink-dim/50 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-[12.5px] font-semibold tracking-[0.06em] text-dim uppercase">
            <Icon as={Gauge} size={14} />
            budgets &amp; caps
          </span>
          <MoreLink to="/operate">Manage</MoreLink>
        </div>
        {isLoading ? (
          <div className="flex gap-4 animate-pulse">
            <div className="h-16 w-full rounded-lg bg-line-soft" />
            <div className="h-16 w-full rounded-lg bg-line-soft" />
            <div className="h-16 w-full rounded-lg bg-line-soft" />
          </div>
        ) : (
          <Grid cols={3} className="gap-6">
            <Stat icon={Coins} label="Agent float" value={fmtMusd(s?.walletBalance ?? 0n, 2)} unit="MUSD"
                  hint="MUSD held by the agent EOA" />
            <Stat icon={Gauge} label="Daily spend cap" value={fmtMusd(s?.dailyCap ?? 0n, 2)} unit="MUSD"
                  hint="MongoDB + on-chain ceiling" />
            <Stat icon={ShieldCheck} label="Per-call max" value={fmtMusd(s?.perCallMax ?? 0n, 2)} unit="MUSD"
                  hint="single payment limit" />
          </Grid>
        )}
        <div className="mt-5 border-t border-line-soft pt-4">
          <p className="text-[13.5px] leading-relaxed text-dim">
            Float comes from <Link to="/earn" className="text-info hover:underline">Earn</Link> (deposit BTC → borrow MUSD → fund agent).
            Daily spending is enforced by the gateway against on-chain receipts on{" "}
            <Link to="/spend" className="text-info hover:underline">Spend</Link>.
          </p>
        </div>
      </div>

      {s && (
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2.5 border-t border-line-soft pt-4 text-[13px] text-dim">
          <span className="flex items-center gap-2">
            <Icon as={CircleCheck} size={13} className="text-ok" />
            payments <b className="tnum text-muted">{s.payments?.toString() || "0"}</b>
          </span>
          <span className="flex items-center gap-2">
            <Icon as={ShieldCheck} size={13} className="text-bad" />
            refusals <b className="tnum text-muted">{s.denials?.toString() || "0"}</b>
          </span>
          {allowance !== null && (
            <span className="flex items-center gap-2">
              <Icon as={Lock} size={13} className={approved ? "text-ok" : "text-warn"} />
              permit2 {approved ? "approved" : "not approved"}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Onboarding — Wave 2 (no faucet)
// ---------------------------------------------------------------------------

const STEP_ICONS = [Wallet, Coins, ShieldCheck, PlugZap, ReceiptText];

function NextSteps({ session, agentStatus, approved, approving, onEnable }) {
  const s = agentStatus.status;
  const hasWallet = Boolean(session.agentAddress);
  const hasFloat = Boolean(s && BigInt(s.walletBalance || 0) > 0n);
  const hasPaid = Boolean(s && BigInt(s.payments || 0) > 0n);

  const steps = [
    {
      title: "Connect & create agent",
      body: "Reown connects your wallet. The gateway creates an encrypted server-side EOA tied to it.",
      done: hasWallet,
      to: null,
      cta: hasWallet ? null : "Connect from the navbar",
    },
    {
      title: "Borrow MUSD on Earn",
      body: "Deposit BTC as collateral via Mezo BorrowerOperations, borrow MUSD, send it to your agent.",
      done: hasFloat,
      to: "/earn",
      cta: hasFloat ? null : "Open Earn",
    },
    {
      title: "Enable payments",
      body: "One server-side MUSD.approve(Permit2) from your agent EOA. No browser signature from the wrong wallet.",
      done: approved,
      onClick: onEnable,
      cta: !hasWallet || approved ? null : (approving ? "Approving…" : "Enable Permit2"),
    },
    {
      title: "First x402 payment",
      body: "Pay for an HTTP resource with permit2-settled MUSD, bounded by your daily cap.",
      done: hasPaid,
      to: "/spend",
      cta: hasPaid ? null : "Spend",
    },
    {
      title: "Verify on ledger",
      body: "Every payment and refusal, classified against the chain.",
      done: hasPaid,
      to: "/ledger",
      cta: "Open ledger",
      always: true,
    },
  ];

  const current = steps.findIndex((st) => !st.done);
  const doneCount = steps.filter((st) => st.done).length;

  return (
    <Card
      icon={TrendingUp}
      tone="ok"
      title="Onboarding"
      sub="Self-funded path from connect → x402 payment."
      className="h-full"
      aside={
        <Badge tone={current === -1 ? "ok" : "btc"}>
          {current === -1 ? "ready" : `step ${current + 1} of ${steps.length}`}
        </Badge>
      }
    >
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
                          disabled={approving}
                          busy={approving && isCurrent}
                        >
                          {st.cta}
                        </Button>
                      ) : st.to ? (
                        <Link to={st.to}>
                          <Button
                            size="sm"
                            variant={isCurrent ? "primary" : "ghost"}
                            className={isCurrent ? "" : "border border-line-soft"}
                            iconRight={isCurrent ? ArrowUpRight : undefined}
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
// Protocol section (treasury + demo agent + contracts)
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
      <ActivityPanel
        scope="protocol"
        icon={Activity}
        tone="info"
        title="Protocol activity"
        sub="Every agent wallet on this treasury — from receipts the contract stored."
        payments={payments}
        denials={denials}
        windowNote={windowNote}
      />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card
          icon={Landmark}
          tone="btc"
          title="Master Treasury"
          sub="On-chain vault at the address verified on the explorer."
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
        </Card>

        <Card
          icon={Zap}
          title="Operator Demo Agent"
          sub="The gateway's own wallet — not yours, not your budget."
          aside={
            <Badge tone={agent.registered ? "neutral" : "warn"} icon={agent.registered ? Lock : CircleAlert}>
              {agent.registered ? "gateway owned · not yours" : "not registered"}
            </Badge>
          }
        >
          {agent.registered ? (
            <>
              <Grid cols={3} className="gap-4 border-b border-line-soft pb-5">
                <Stat icon={Coins} label="Float" value={fmtMusd(agent.walletBalance, 4)} unit="MUSD" />
                <Stat icon={Gauge} label="Per-call" value={fmtMusd(policy.perCallMax, 2)} unit="MUSD" />
                {policy.leftToday ? (
                  <Stat icon={TrendingUp} label="Left to spend today" value={fmtMusd(policy.leftToday, 4)} unit="MUSD" />
                ) : (
                  <Stat icon={Clock} label="Funding left today" value={fmtMusd(policy.remainingToday, 2)} unit="MUSD" />
                )}
              </Grid>
              <dl className="dl mt-5 text-[13.5px]">
                <dt>address</dt>
                <dd className="text-right">{<AddressLink address={health?.agentWallet} />}</dd>
                <dt>permit2 auth</dt>
                <dd className="flex justify-end">
                  {permit2.ready
                    ? <Badge tone="ok" icon={ShieldCheck}>granted</Badge>
                    : <Badge tone="bad" icon={Lock}>missing</Badge>}
                </dd>
              </dl>
            </>
          ) : (
            <Note tone="warn" icon={Wallet} title="No demo agent configured">
              Your personal agent still works via Earn → Fund → Spend.
            </Note>
          )}
        </Card>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card
            icon={TrendingUp}
            title="Savings vault (sMUSD)"
            sub="Idle agent float above the sweep threshold is deposited automatically."
            aside={
              <Badge tone={SAVINGS_VAULT?.available ? "ok" : "warn"} icon={SAVINGS_VAULT?.available ? CircleCheck : Lock}>
                {SAVINGS_VAULT?.available ? "live on testnet" : "check config"}
              </Badge>
            }
          >
            <p className="mb-4 text-[14px] leading-relaxed text-muted">
              Vault <span className="font-mono text-[13px]">{SAVINGS_VAULT?.address || "0x6f46…e16"}</span>.
              Gateway sweeps excess MUSD every few minutes and withdraws on demand before payments.
            </p>
            <Grid cols={2} className="gap-3">
              <div className="rounded-lg border border-line-soft bg-ink-dim p-3.5">
                <span className="mb-1.5 flex items-center gap-2 text-[13.5px] font-semibold text-text">
                  <Icon as={CircleCheck} size={14} className="text-ok" /> Auto-sweep
                </span>
                <p className="text-[13px] leading-relaxed text-dim">
                  Threshold 50 MUSD · interval 5 min · withdraw-before-sign on <span className="code">/api/pay</span>.
                </p>
              </div>
              <div className="rounded-lg border border-line-soft bg-ink-dim p-3.5">
                <span className="mb-1.5 flex items-center gap-2 text-[13.5px] font-semibold text-text">
                  <Icon as={CircleCheck} size={14} className="text-ok" /> Self-funded
                </span>
                <p className="text-[13px] leading-relaxed text-dim">
                  No faucet. Users deposit BTC on Earn, borrow MUSD, and fund their agent directly.
                </p>
              </div>
            </Grid>
          </Card>
        </div>

        <Card icon={Landmark} title="System contracts" sub="Addresses this deployment is built on.">
          <div className="space-y-4">
            <div>
              <div className="mb-1 text-[12.5px] text-dim">Canonical MUSD</div>
              <a href={explorerToken(MUSD_ADDRESS)} target="_blank" rel="noreferrer"
                 className="font-mono text-[14px] text-info transition-colors hover:text-info/80">
                {MUSD_ADDRESS.slice(0, 8)}…{MUSD_ADDRESS.slice(-6)}
              </a>
            </div>
            <div>
              <div className="mb-1 text-[12.5px] text-dim">Treasury</div>
              <div className="font-mono text-[14px] text-muted">0xf10e…Df79</div>
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
                BTC is gas. x402 settlement is facilitator-sponsored — float is never spent on fees.
              </div>
            </div>
          </div>
        </Card>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Alerts teaser
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

function AlertsTeaser({ address }) {
  const tg = useTelegramBinding(address);
  if (!address) return null;

  const copy = !tg
    ? "Reading your alert binding…"
    : !tg.enabled
      ? "No bot connected yet. Setup steps are on the Alerts page."
      : tg.subscribed
        ? `Connected${tg.chatUsername ? ` as @${tg.chatUsername}` : ""}. Payments and refusals arrive in Telegram live.`
        : "Not connected. Binding takes one signature — until then events are silent.";

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
        <Button size="sm" variant={tg?.subscribed ? "ghost" : "primary"} icon={Bell}
                className={tg?.subscribed ? "border border-line-soft" : ""}>
          {tg?.subscribed ? "Manage" : tg?.enabled ? "Connect" : "Set up"}
        </Button>
      </Link>
    </div>
  );
}

