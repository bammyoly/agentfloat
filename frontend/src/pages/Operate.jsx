// ---------------------------------------------------------------------------
// Operate: everything about your agent in one place.
//
//   1. Agent wallet     what it holds and whether it is ready to pay
//   2. Move money       fund MUSD, send BTC gas, retrieve MUSD back
//   3. Spending budget  per call and daily caps, plus your own freeze switch
//   4. Protocol         treasury owner only
//
// Money movement rules
//   Fund and gas are signed by YOUR connected wallet in the browser.
//   Retrieve is signed by the agent's server held key, so it goes through the
//   gateway. The gateway takes the destination from your session, never from
//   the request, so retrieved MUSD can only ever land in your own wallet.
//
// Budget changes
//   setAgentLimits() is onlyOwner on purpose: an agent that can raise its own
//   ceiling is not budget controlled. So you sign a specific change, the gateway
//   checks the signature and applies it with the owner key inside a published
//   ceiling.
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle, ArrowLeft, ArrowRight, CircleCheck, Gauge, Landmark, Lock,
  Pause, Play, PlugZap, RefreshCw, Wallet, Zap,
} from "lucide-react";
import { ethers } from "ethers";
import { useAppData } from "../lib/app-data.jsx";
import { useSession } from "../lib/session.jsx";
import { useAgentStatus } from "../lib/agent-status.jsx";
import {
  AddressLink, Badge, Button, Card, Dot, Field, Grid, Note, PageHeader, Stat, TxLink,
} from "../components/ui.jsx";
import { TREASURY_ADDRESS, TREASURY_ABI, MUSD_ADDRESS, ERC20_ABI, CHAIN, TREASURY_OWNER } from "../contracts/index.js";
import { sendTx, fmtMusd, short } from "../lib/chain.js";
import { getMUSDBalance, getBTCBalance, fundAgent, fundAgentGas } from "../lib/trove.js";
import { retrieveFromAgent } from "../lib/agent-ops.js";
import {
  pauseGateway, unpauseGateway, limitsConfig, limitsChallenge, limitsApply, limitsHistory,
  ADMIN_TOKEN_CONFIGURED, isAdminLocked,
} from "../lib/gateway.js";

const GAS_READY_BTC = 0.0002;   // below this the agent may not afford a few transactions
const GAS_BUFFER_BTC = 0.0001;  // kept in the wallet when sending gas

const ADMIN_LOCKED_DETAIL =
  "This gateway is deployed with GATEWAY_ADMIN_TOKEN set, so owner only commands need it. " +
  "That token is a deployment secret and deliberately not something this browser bundle " +
  "carries: any VITE_ prefixed value is inlined into the shipped JavaScript, so publishing " +
  "it here would hand the pause switch to every visitor. Pause on chain instead. The " +
  "treasury's pause() needs the owner wallet and is the authority that survives a restart.";

const isRejection = (text) => /user (rejected|denied)|4001/i.test(String(text));

// ===========================================================================
// Page
// ===========================================================================

export default function Operate() {
  const { health, refresh } = useAppData();
  const session = useSession();
  const funds = useFunds(session.primaryAddress, session.agentAddress);

  return (
    <div className="animate-fade space-y-8 pb-10">
      <PageHeader
        icon={Gauge}
        eyebrow="your agent"
        title="Budget & Controls"
        sub="Fund your agent, pull money back, and set what it may spend. Protocol controls sit at the bottom for the treasury owner."
      />

      <SectionLabel>Agent wallet</SectionLabel>
      <AgentOverview session={session} funds={funds} />

      <SectionLabel>Move money</SectionLabel>
      <MoveMoney session={session} funds={funds} health={health} onDone={refresh} />

      <SectionLabel>Spending budget</SectionLabel>
      <YourBudget session={session} onChanged={refresh} />

      <SectionLabel>Protocol controls · treasury owner only</SectionLabel>
      <OwnerControls session={session} health={health} refresh={refresh} />
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div className="relative flex items-center">
      <div className="flex-grow border-t border-line-soft" />
      <span className="mx-4 flex-shrink-0 rounded-full border border-line-soft bg-ink-soft px-3 py-1 text-[11.5px] font-semibold uppercase tracking-widest text-dim">
        {children}
      </span>
      <div className="flex-grow border-t border-line-soft" />
    </div>
  );
}

// ===========================================================================
// Balances
// ===========================================================================

function useFunds(primary, agent) {
  const [f, setF] = useState({ walletMusd: null, walletBtc: null, agentMusd: null, agentBtc: null, vault: null });
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!primary) return;
    setLoading(true);
    const [wm, wb, am, ab, sv] = await Promise.allSettled([
      getMUSDBalance(primary),
      getBTCBalance(primary),
      agent ? getMUSDBalance(agent) : Promise.resolve(null),
      agent ? getBTCBalance(agent) : Promise.resolve(null),
      agent ? fetch(`/api/savings/status?agent=${agent}`).then((r) => r.json()) : Promise.resolve(null),
    ]);
    if (!alive.current) return;
    setF((prev) => ({
      walletMusd: wm.status === "fulfilled" ? wm.value : prev.walletMusd,
      walletBtc: wb.status === "fulfilled" ? wb.value : prev.walletBtc,
      agentMusd: am.status === "fulfilled" ? am.value : prev.agentMusd,
      agentBtc: ab.status === "fulfilled" ? ab.value : prev.agentBtc,
      vault:
        sv.status === "fulfilled" && sv.value?.ok && sv.value?.savings
          ? Number(sv.value.savings.assets) || 0
          : prev.vault,
    }));
    setLoading(false);
  }, [primary, agent]);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, 20_000);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);

  return { ...f, loading, reload: load };
}

// ===========================================================================
// 1. Agent wallet overview
// ===========================================================================

function AgentOverview({ session, funds }) {
  const address = session.agentAddress;

  if (!session.user) {
    return (
      <Card icon={Wallet} title="Your agent wallet" aside={<Badge tone="neutral">sign in required</Badge>}>
        <p className="text-[14px] leading-relaxed text-muted">
          Connect your wallet and AgentFloat creates a server side agent wallet for you. Its balances, budget and
          controls show up here.
        </p>
        <div className="mt-4">
          <Button variant="primary" onClick={session.login} disabled={session.authenticating}>
            {session.authenticating ? "Opening…" : "Sign in"}
          </Button>
        </div>
      </Card>
    );
  }

  if (!address) {
    return (
      <Card icon={RefreshCw} title="Your agent wallet" aside={<Badge tone="warn"><Dot tone="warn" pulse /> creating wallet</Badge>}>
        <p className="text-[14px] leading-relaxed text-muted">
          Your agent wallet is being created. This takes a few seconds on first sign in.
        </p>
      </Card>
    );
  }

  const musdTotal = (funds.agentMusd ?? 0) + (funds.vault ?? 0);
  const funded = funds.agentMusd !== null && musdTotal > 0;
  const gasReady = funds.agentBtc !== null && funds.agentBtc >= GAS_READY_BTC;

  return (
    <Card
      icon={Wallet}
      title="Your agent wallet"
      aside={
        <Button
          variant="ghost" size="sm" icon={RefreshCw} onClick={funds.reload} busy={funds.loading}
          className="border border-line-soft" title="Refresh balances"
        />
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="rounded border border-line-soft bg-ink-dim px-2.5 py-1 font-mono text-[13.5px] text-muted">
          <AddressLink address={address} chars={8} />
        </div>
        <span className="text-[12.5px] text-dim">server managed wallet, signs x402 payments</span>
      </div>

      <Grid cols={2} className="mt-5 gap-5 sm:grid-cols-4">
        <Stat icon={PlugZap} label="Agent MUSD" value={funds.agentMusd === null ? null : funds.agentMusd.toFixed(2)}
              unit="MUSD" loading={funds.agentMusd === null} tone={funded ? "ok" : "warn"} />
        <Stat icon={Landmark} label="In savings vault" value={funds.vault === null ? "0.00" : funds.vault.toFixed(2)}
              unit="sMUSD" hint="swept automatically above 50 MUSD" />
        <Stat icon={Zap} label="Agent BTC for gas" value={funds.agentBtc === null ? null : funds.agentBtc.toFixed(6)}
              unit="BTC" loading={funds.agentBtc === null} tone={gasReady ? "ok" : "warn"} />
        <Stat icon={Wallet} label="Your wallet MUSD" value={funds.walletMusd === null ? null : funds.walletMusd.toFixed(2)}
              unit="MUSD" loading={funds.walletMusd === null} />
      </Grid>

      <div className="mt-5 flex flex-wrap gap-2 border-t border-line-soft pt-4">
        <Badge tone="ok" icon={CircleCheck}><Dot tone="ok" /> wallet created</Badge>
        <Badge tone={funds.agentMusd === null ? "neutral" : funded ? "ok" : "warn"}>
          <Dot tone={funds.agentMusd === null ? "neutral" : funded ? "ok" : "warn"} />
          {funds.agentMusd === null ? "checking MUSD" : funded ? "MUSD funded" : "no MUSD yet"}
        </Badge>
        <Badge tone={funds.agentBtc === null ? "neutral" : gasReady ? "ok" : "warn"}>
          <Dot tone={funds.agentBtc === null ? "neutral" : gasReady ? "ok" : "warn"} />
          {funds.agentBtc === null ? "checking gas" : gasReady ? "gas ready" : "needs BTC gas"}
        </Badge>
      </div>
    </Card>
  );
}

// ===========================================================================
// 2. Move money
// ===========================================================================

function MoveMoney({ session, funds, health, onDone }) {
  const primary = session.primaryAddress;
  const agent = session.agentAddress;

  const [tab, setTab] = useState("fund");
  const [fundAmt, setFundAmt] = useState("");
  const [gasAmt, setGasAmt] = useState("");
  const [pullAmt, setPullAmt] = useState("");
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  if (!session.user || !agent) {
    return (
      <Card icon={ArrowRight} title="Move money" aside={<Badge tone="neutral">waiting for agent wallet</Badge>}>
        <p className="text-[14px] leading-relaxed text-muted">
          Sign in and wait for your agent wallet to exist. Then you can fund it, send it gas, and pull MUSD back.
        </p>
      </Card>
    );
  }

  const walletMusd = funds.walletMusd ?? 0;
  const walletBtc = funds.walletBtc ?? 0;
  const agentMusd = funds.agentMusd ?? 0;
  const agentBtc = funds.agentBtc ?? 0;
  const vault = funds.vault ?? 0;
  const available = agentMusd + vault;

  const fundN = parseFloat(fundAmt) || 0;
  const gasN = parseFloat(gasAmt) || 0;
  const pullN = parseFloat(pullAmt) || 0;
  const maxGas = Math.max(0, walletBtc - GAS_BUFFER_BTC);
  const fromVault = Math.max(0, pullN - agentMusd);
  const gwPaused = Boolean(health?.paused);

  async function getProvider() {
    if (!session.primaryWallet) throw new Error("No wallet connected");
    return session.primaryWallet.getEthereumProvider();
  }

  async function run(label, fn, detail) {
    setBusy(label); setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: true, label, hash: typeof r === "string" ? r : r?.txHash, detail: detail?.(r) });
    } catch (e) {
      const text = String(e?.shortMessage || e?.message || e);
      setMsg({
        ok: false,
        label,
        error: isRejection(text) ? "You declined the request in your wallet, so nothing was sent." : text,
      });
    } finally {
      setBusy(null);
      funds.reload();
      onDone?.();
    }
  }

  const doFund = () => run("Fund agent", async () => {
    const provider = await getProvider();
    const hash = await fundAgent(provider, primary, agent, fundAmt);
    setFundAmt("");
    return hash;
  }, () => `${fundN} MUSD sent to your agent`);

  const doGas = () => run("Send gas", async () => {
    const provider = await getProvider();
    const hash = await fundAgentGas(provider, primary, agent, gasAmt);
    setGasAmt("");
    return hash;
  }, () => `${gasN} BTC sent to your agent`);

  const doPull = () => run("Retrieve MUSD", async () => {
    const r = await retrieveFromAgent(pullAmt);
    setPullAmt("");
    return r;
  }, (r) => `${r.amount} MUSD sent to your wallet${r.fromVault ? " (part came from the savings vault)" : ""}`);

  return (
    <Card
      icon={ArrowRight}
      title="Move money"
      sub="Your wallet signs the funding. Retrieval is signed by the agent and can only go back to your wallet."
    >
      <div className="flex flex-wrap gap-2">
        <TabButton active={tab === "fund"} onClick={() => { setTab("fund"); setMsg(null); }}>
          <PlugZap size={14} className="mr-1.5 inline" /> Fund agent
        </TabButton>
        <TabButton active={tab === "gas"} onClick={() => { setTab("gas"); setMsg(null); }}>
          <Zap size={14} className="mr-1.5 inline" /> Send BTC gas
        </TabButton>
        <TabButton active={tab === "retrieve"} onClick={() => { setTab("retrieve"); setMsg(null); }}>
          <ArrowLeft size={14} className="mr-1.5 inline" /> Retrieve MUSD
        </TabButton>
      </div>

      {/* route line */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-ink-dim/50 px-3 py-2 text-[12.5px] text-dim">
        {tab === "retrieve" ? (
          <>
            <span>agent</span><span className="font-mono">{short(agent, 4)}</span>
            <ArrowRight size={13} />
            <span>your wallet</span><span className="font-mono">{short(primary, 4)}</span>
          </>
        ) : (
          <>
            <span>your wallet</span><span className="font-mono">{short(primary, 4)}</span>
            <ArrowRight size={13} />
            <span>agent</span><span className="font-mono">{short(agent, 4)}</span>
          </>
        )}
      </div>

      {tab === "fund" && (
        <div className="mt-5">
          <Field label="MUSD to agent" hint={`Your wallet holds ${walletMusd.toFixed(2)} MUSD`}>
            <div className="flex gap-2.5">
              <input
                className="input flex-1" type="number" step="10" min="0" value={fundAmt} placeholder="500"
                onChange={(e) => { setFundAmt(e.target.value); setMsg(null); }}
                disabled={funds.walletMusd === null || busy !== null}
              />
              <Button
                variant="ghost" size="sm" className="shrink-0 border border-line-soft"
                onClick={() => setFundAmt(walletMusd > 0 ? String(Math.floor(walletMusd * 100) / 100) : "")}
                disabled={funds.walletMusd === null || walletMusd <= 0 || busy !== null}
              >
                MAX
              </Button>
              <Button
                variant="primary" icon={PlugZap} className="shrink-0" onClick={doFund} busy={busy === "Fund agent"}
                disabled={busy !== null || fundN <= 0 || fundN > walletMusd}
              >
                {busy === "Fund agent" ? "Sending…" : "Fund agent"}
              </Button>
            </div>
          </Field>
          {fundN > walletMusd && <Note tone="warn" className="mt-3">That is more MUSD than your wallet holds.</Note>}
          <Note className="mt-4">
            MUSD above the sweep threshold is moved into the savings vault automatically, and pulled back out before
            a payment needs it.
          </Note>
        </div>
      )}

      {tab === "gas" && (
        <div className="mt-5">
          <Field
            label="BTC gas to agent"
            hint="The agent pays gas in BTC for its approvals, vault moves and retrievals. A small amount lasts a long time."
          >
            <div className="flex gap-2.5">
              <input
                className="input flex-1" type="number" step="0.0001" min="0" value={gasAmt} placeholder="0.001"
                onChange={(e) => { setGasAmt(e.target.value); setMsg(null); }}
                disabled={funds.walletBtc === null || busy !== null}
              />
              <Button
                variant="ghost" size="sm" className="shrink-0 border border-line-soft"
                onClick={() => setGasAmt("0.001")} disabled={funds.walletBtc === null || busy !== null}
              >
                0.001
              </Button>
              <Button
                variant="primary" icon={Zap} className="shrink-0" onClick={doGas} busy={busy === "Send gas"}
                disabled={busy !== null || gasN <= 0 || gasN > maxGas}
              >
                {busy === "Send gas" ? "Sending…" : "Send gas"}
              </Button>
            </div>
          </Field>
          <dl className="dl mt-4 text-[13px]">
            <dt>your wallet BTC</dt>
            <dd>{walletBtc.toFixed(6)} BTC</dd>
            <dt>agent BTC now</dt>
            <dd>{agentBtc.toFixed(6)} BTC</dd>
          </dl>
          {gasN > maxGas && (
            <Note tone="warn" className="mt-3">
              That leaves your own wallet without BTC for gas. The most you can send is {maxGas.toFixed(6)} BTC.
            </Note>
          )}
        </div>
      )}

      {tab === "retrieve" && (
        <div className="mt-5">
          <Field
            label="MUSD back to your wallet"
            hint={`Available: ${agentMusd.toFixed(2)} liquid + ${vault.toFixed(2)} in the savings vault`}
          >
            <div className="flex gap-2.5">
              <input
                className="input flex-1" type="number" step="10" min="0" value={pullAmt} placeholder="100"
                onChange={(e) => { setPullAmt(e.target.value); setMsg(null); }}
                disabled={funds.agentMusd === null || busy !== null}
              />
              <Button
                variant="ghost" size="sm" className="shrink-0 border border-line-soft"
                onClick={() => setPullAmt(available > 0 ? String(Math.floor(available * 100) / 100) : "")}
                disabled={funds.agentMusd === null || available <= 0 || busy !== null}
              >
                MAX
              </Button>
              <Button
                variant="primary" icon={ArrowLeft} className="shrink-0" onClick={doPull} busy={busy === "Retrieve MUSD"}
                disabled={busy !== null || gwPaused || pullN <= 0 || pullN > available}
              >
                {busy === "Retrieve MUSD" ? "Retrieving…" : "Retrieve"}
              </Button>
            </div>
          </Field>

          {pullN > available && <Note tone="warn" className="mt-3">That is more than the agent holds.</Note>}
          {fromVault > 0 && pullN <= available && (
            <Note className="mt-3">
              About {fromVault.toFixed(2)} MUSD will be withdrawn from the savings vault first. That is one extra
              transaction paid by the agent.
            </Note>
          )}
          {funds.agentBtc !== null && agentBtc < GAS_READY_BTC && (
            <Note tone="warn" className="mt-3" icon={AlertTriangle}>
              The agent pays gas for this transfer and holds only {agentBtc.toFixed(6)} BTC.{" "}
              <button type="button" className="font-semibold underline" onClick={() => setTab("gas")}>
                Send it some BTC gas first
              </button>.
            </Note>
          )}
          {gwPaused && (
            <Note tone="warn" className="mt-3" icon={Lock}>
              The gateway is paused, so retrieval is blocked until the operator resumes it.
            </Note>
          )}
          <Note className="mt-4" icon={Lock}>
            Retrieved MUSD always goes to <span className="font-mono text-text">{short(primary, 6)}</span>, the wallet
            you signed in with. The gateway reads the destination from your session and accepts no address in the
            request.
          </Note>
        </div>
      )}

      {msg && (
        <Note tone={msg.ok ? "ok" : "bad"} className="mt-5">
          {msg.ok ? (
            <>
              <b>{msg.label}</b> done{msg.detail ? `: ${msg.detail}` : ""}.
              {msg.hash && <> Tx: <TxLink hash={msg.hash} /></>}
            </>
          ) : (
            <><b>{msg.label} failed.</b> {msg.error}</>
          )}
        </Note>
      )}
    </Card>
  );
}

function TabButton({ active, children, ...rest }) {
  return (
    <button className={`btn ${active ? "btn-primary" : ""}`} aria-pressed={active} {...rest}>
      {children}
    </button>
  );
}

// ===========================================================================
// 3. Spending budget: every signed in user
// ===========================================================================

function YourBudget({ session, onChanged }) {
  // Remounting the status reader forces an immediate re-read after a change,
  // instead of waiting for the next poll.
  const [reloadKey, setReloadKey] = useState(0);

  if (!session.configured || !session.user) {
    return (
      <Card title="Your agent budget" aside={<Badge tone="neutral">sign in required</Badge>}>
        <p className="text-[14px] leading-relaxed text-muted">
          Sign in and your agent wallet is created for you. Its spending limits, meaning how much a single payment
          may take and how much may go out in a day, are yours to set here.
        </p>
      </Card>
    );
  }

  return <BudgetCard key={reloadKey} session={session} onChanged={() => { setReloadKey((k) => k + 1); onChanged?.(); }} />;
}

function BudgetCard({ session, onChanged }) {
  const address = session.agentAddress;
  const mine = useAgentStatus(address);

  const [ceilings, setCeilings] = useState(null);
  const [available, setAvailable] = useState(null);
  const [perCall, setPerCall] = useState("");
  const [daily, setDaily] = useState("");
  const [busy, setBusy] = useState(null);
  const [stage, setStage] = useState(null);
  const [msg, setMsg] = useState(null);
  const [confirmFreeze, setConfirmFreeze] = useState(false);
  const [history, setHistory] = useState([]);

  // Seed the inputs from the chain once per mount. The status polls, and
  // re-seeding would fight whoever is typing.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !mine.status) return;
    seeded.current = true;
    setPerCall(Number(ethers.formatUnits(mine.status.perCallMax, 18)).toString());
    setDaily(Number(ethers.formatUnits(mine.status.dailyCap, 18)).toString());
  }, [mine.status]);

  useEffect(() => {
    limitsConfig().then((r) => {
      if (r.ok) { setCeilings(r.ceilings); setAvailable(r.available); }
      else setAvailable(false);
    });
  }, []);

  useEffect(() => {
    if (!address) return;
    limitsHistory(address).then((r) => { if (r.ok) setHistory(r.changes || []); });
  }, [address]);

  const maxPerCall = Number(ceilings?.perCallMaxMusd || 5);
  const maxDaily = Number(ceilings?.dailyCapMusd || 50);
  const minPerCall = Number(ceilings?.minPerCallMusd || 0.001);

  const currentPerCall = mine.status ? Number(ethers.formatUnits(mine.status.perCallMax, 18)) : null;
  const currentDaily = mine.status ? Number(ethers.formatUnits(mine.status.dailyCap, 18)) : null;
  const active = mine.status?.active;

  const changed =
    currentPerCall !== null &&
    (Number(perCall) !== currentPerCall || Number(daily) !== currentDaily);

  // Same rules the gateway enforces, checked first: a refusal explained before
  // the wallet prompt is worth more than a 400 after it.
  const invalid =
    !perCall || !daily ||
    Number(perCall) < minPerCall || Number(perCall) > maxPerCall ||
    Number(daily) < Number(perCall) || Number(daily) > maxDaily;

  /** challenge, sign in the wallet, gateway applies with the owner key. */
  async function apply(action, values = {}) {
    setBusy(action); setMsg(null); setStage("asking the gateway for a challenge…");
    try {
      const ch = await limitsChallenge({ address, action, ...values });
      if (!ch.ok) throw new Error(ch.error || "the gateway refused to issue a challenge");
      if (ch.hint) throw new Error(ch.hint);

      setStage("waiting for your signature in the wallet…");
      const signature = await session.signMessage(ch.message);

      setStage("applying on chain with the owner key…");
      const r = await limitsApply({ nonce: ch.nonce, signature });
      if (!r.ok) throw new Error(r.error || "the gateway refused the change");

      setMsg({
        ok: true,
        label: action === "limits" ? "Budget updated" : action === "freeze" ? "Agent frozen" : "Agent re-enabled",
        hash: r.txHash,
        confirmed: r.confirmed,
        detail: action === "limits"
          ? `per call ${r.perCallMaxMusd} MUSD, daily ${r.dailyCapMusd} MUSD`
          : null,
      });
      limitsHistory(address).then((h) => { if (h.ok) setHistory(h.changes || []); });
      onChanged?.();
    } catch (e) {
      const text = String(e?.shortMessage || e?.message || e);
      setMsg({
        ok: false,
        label: action === "limits" ? "Budget change" : action,
        error: isRejection(text)
          ? "You declined the signature, so nothing was changed. Ask again when ready."
          : text,
      });
    } finally {
      setBusy(null); setStage(null); setConfirmFreeze(false);
    }
  }

  if (!address) {
    return (
      <Card title="Your agent budget" aside={<Badge tone="warn"><Dot tone="warn" pulse /> creating wallet</Badge>}>
        <p className="text-[14px] leading-relaxed text-muted">
          Your agent wallet is being created. Budget controls appear the moment it exists.
        </p>
      </Card>
    );
  }

  if (mine.registered === false) {
    return (
      <Card title="Your agent budget" aside={<Badge tone="warn">not registered</Badge>}>
        <Note tone="warn">
          Your agent wallet is not registered in the treasury yet, so there are no onchain caps to change.
          Registration normally happens when the wallet is created. If this stays, the operator can register it from
          the protocol controls below.
        </Note>
      </Card>
    );
  }

  return (
    <Card
      title="Your agent budget"
      aside={
        active === false
          ? <Badge tone="bad"><Dot tone="bad" /> frozen</Badge>
          : mine.status
            ? <Badge tone="ok"><Dot tone="ok" /> enforced on chain</Badge>
            : <Badge tone="warn"><Dot tone="warn" pulse /> reading chain</Badge>
      }
    >
      {/* what the chain says right now */}
      <div className="grid grid-cols-2 gap-4 rounded-xl border border-line-soft bg-ink-dim/50 p-4 sm:grid-cols-4">
        <Stat label="Per call max" value={currentPerCall === null ? "…" : currentPerCall} unit="MUSD" />
        <Stat label="Daily cap" value={currentDaily === null ? "…" : currentDaily} unit="MUSD" hint="resets 00:00 UTC" />
        <Stat label="Funding left today" value={mine.status ? fmtMusd(mine.status.remainingToday, 2) : "…"} unit="MUSD"
              hint="float the treasury may still release today, not a spend budget" />
        <Stat label="Float" value={mine.status ? fmtMusd(mine.status.walletBalance, 4) : "…"} unit="MUSD" />
      </div>

      {/* the change itself */}
      <div className="mt-6 grid gap-5 md:grid-cols-2">
        <div>
          <Field
            label={`Per call max (MUSD), ceiling ${maxPerCall}`}
            hint="The most any single payment can take. Below a seller's price, the treasury refuses it before anything is signed."
          >
            <input
              className="input" value={perCall} inputMode="decimal"
              onChange={(e) => setPerCall(e.target.value)} disabled={busy !== null}
            />
            <input
              type="range" className="mt-2 w-full accent-btc"
              min={minPerCall} max={maxPerCall} step={0.1}
              value={Number(perCall) || minPerCall}
              onChange={(e) => setPerCall(e.target.value)} disabled={busy !== null}
            />
          </Field>
        </div>
        <div>
          <Field
            label={`Daily cap (MUSD), ceiling ${maxDaily}`}
            hint="Everything that can leave this wallet in one UTC day, across all sellers."
          >
            <input
              className="input" value={daily} inputMode="decimal"
              onChange={(e) => setDaily(e.target.value)} disabled={busy !== null}
            />
            <input
              type="range" className="mt-2 w-full accent-btc"
              min={minPerCall} max={maxDaily} step={1}
              value={Number(daily) || minPerCall}
              onChange={(e) => setDaily(e.target.value)} disabled={busy !== null}
            />
          </Field>
        </div>
      </div>

      {invalid && (
        <Note tone="warn" className="mt-4">
          Per call max must be between {minPerCall} and {maxPerCall} MUSD, and the daily cap between the per call max
          and {maxDaily} MUSD. The gateway refuses anything outside that range, and so does the contract.
        </Note>
      )}

      {available === false && (
        <Note tone="warn" className="mt-4">
          Self service budget changes are unavailable: this gateway has no treasury owner key
          (<span className="code">GATEWAY_SIGNER_PRIVATE_KEY</span> in <span className="code">server/.env</span>).
          Set that key and restart the gateway, or ask the operator to change your caps from the protocol controls.
        </Note>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <Button
          variant="primary"
          onClick={() => apply("limits", { perCallMax: perCall, dailyCap: daily })}
          disabled={busy !== null || available === false || !changed || invalid}
          title={
            invalid ? "Those values are outside the allowed range"
            : !changed ? "Nothing to change, these are already your onchain caps"
            : "Sign to authorize, the gateway applies it on chain"
          }
        >
          {busy === "limits" ? stage || "working…" : "Apply change"}
        </Button>
        {changed && (
          <span className="text-[12.5px] text-dim">
            {currentPerCall !== null && <>per call {currentPerCall} to <b className="text-text">{Number(perCall) || 0}</b> · </>}
            {currentDaily !== null && <>daily {currentDaily} to <b className="text-text">{Number(daily) || 0}</b></>}
          </span>
        )}
        {!changed && mine.status && (
          <span className="text-[12.5px] text-dim">matches your onchain caps</span>
        )}
      </div>

      {/* freeze: the user's own kill switch */}
      <div className="mt-5 border-t border-line-soft pt-4">
        <div className="flex flex-wrap items-center gap-2.5">
          {active === false ? (
            <Button onClick={() => apply("unfreeze")} disabled={busy !== null || available === false}>
              {busy === "unfreeze" ? stage || "working…" : "Unfreeze my agent"}
            </Button>
          ) : confirmFreeze ? (
            <Button variant="danger" onClick={() => apply("freeze")} disabled={busy !== null || available === false}>
              {busy === "freeze" ? stage || "working…" : "Confirm freeze"}
            </Button>
          ) : (
            <Button variant="danger" onClick={() => setConfirmFreeze(true)} disabled={busy !== null || available === false}>
              Freeze my agent
            </Button>
          )}
          <span className="text-[12.5px] leading-relaxed text-dim">
            {active === false
              ? "Frozen: the treasury refuses this agent's payments until you unfreeze it."
              : "Your own kill switch, setAgentActive(false) on chain. Float stays in the wallet and nothing can be spent."}
          </span>
          {confirmFreeze && active !== false && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmFreeze(false)}>cancel</Button>
          )}
        </div>
      </div>

      <Note className="mt-5">
        <b className="text-text">Why you sign instead of sending a transaction.</b>{" "}
        <span className="code">setAgentLimits</span> is <span className="code">onlyOwner</span> on purpose: an agent
        that could raise its own ceiling would not be budget controlled. So you authorize a specific change with a
        signature from your connected wallet, and the gateway applies it with the owner key, never above {maxPerCall}{" "}
        MUSD per call or {maxDaily} MUSD a day, and never a value you did not sign.
      </Note>

      {msg && (
        <Note tone={msg.ok ? "ok" : "bad"} className="mt-4">
          {msg.ok ? (
            <>
              <b>{msg.label}</b>{msg.detail && <>: {msg.detail}</>}.
              {msg.hash && <> Tx: <TxLink hash={msg.hash} /></>}
              {msg.confirmed === false && (
                <span className="text-dim"> · broadcast, confirmation not seen within 25s. The Mezo testnet RPC
                often reports receipts late, so trust the explorer link.</span>
              )}
            </>
          ) : (
            <><b>{msg.label} failed.</b> {msg.error}</>
          )}
        </Note>
      )}

      {history.length > 0 && (
        <div className="mt-5 border-t border-line-soft pt-4">
          <div className="mb-2 text-[12.5px] uppercase tracking-[0.14em] text-dim">your changes</div>
          <ul className="space-y-1.5">
            {history.slice(0, 5).map((h) => (
              <li key={h.txHash || h.at} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-dim">
                <span className="tnum">{new Date(h.at).toLocaleString()}</span>
                <Badge tone={h.action === "limits" ? "info" : h.action === "freeze" ? "bad" : "ok"}>
                  {h.action === "limits" ? `per call ${h.perCallMaxMusd} · daily ${h.dailyCapMusd}` : h.action}
                </Badge>
                {h.txHash && <TxLink hash={h.txHash} chars={5} />}
                <span>self service, signed by you</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ===========================================================================
// 4. Protocol controls: the treasury owner
// ===========================================================================

function OwnerControls({ session, health, refresh }) {
  const { operator, connectLegacy, busy: connecting } = useAppData();

  const [target, setTarget] = useState("gateway");
  const [customAgent, setCustomAgent] = useState("");
  const [amount, setAmount] = useState("2");
  const [perCall, setPerCall] = useState("2");
  const [daily, setDaily] = useState("20");
  const [depositAmt, setDepositAmt] = useState("50");
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const chainPaused = health?.treasury?.paused;
  const gwPaused = health?.paused;
  // A gateway deployed with GATEWAY_ADMIN_TOKEN refuses owner commands from any
  // caller that cannot present it. Surfaced up front instead of discovered on click.
  const gwLocked = Boolean(health?.deployment?.adminLocked) && !ADMIN_TOKEN_CONFIGURED;
  const canWrite = Boolean(operator.signer) && operator.isOwner !== false;

  const agentAddress =
    target === "gateway" ? health?.agentWallet || null
    : target === "own" ? session.agentAddress
    : target === "custom" ? (ethers.isAddress(customAgent) ? ethers.getAddress(customAgent) : null)
    : null;

  function treasuryWithSigner() {
    return new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, operator.signer);
  }

  async function run(label, fn) {
    if (!canWrite) { setMsg({ ok: false, error: "Connect the treasury owner wallet first." }); return; }
    setBusy(label); setMsg(null);
    const r = await sendTx(label, fn);
    setMsg(r.ok && r.reverted
      ? { ...r, ok: false, error: `The transaction reverted on chain (tx ${short(r.hash, 8)}). The most likely cause is a policy rule: check the amount against the agent's per call max and remaining daily cap.` }
      : r);
    setBusy(null);
    refresh();
  }

  const fund = () => run("fundAgent", async () => {
    if (!agentAddress) throw new Error("No target agent selected.");
    return treasuryWithSigner().fundAgent(agentAddress, ethers.parseUnits(amount || "0", 18));
  });

  const setLimits = () => run("setAgentLimits", async () => {
    if (!agentAddress) throw new Error("No target agent selected.");
    return treasuryWithSigner().setAgentLimits(
      agentAddress,
      ethers.parseUnits(perCall || "0", 18),
      ethers.parseUnits(daily || "0", 18)
    );
  });

  const pause = () => run("pause", async () => treasuryWithSigner().pause());
  const unpause = () => run("unpause", async () => treasuryWithSigner().unpause());
  const stop = () => run("emergencyStop", async () => {
    if (!agentAddress) throw new Error("No target agent selected.");
    return treasuryWithSigner().emergencyStop(agentAddress);
  });

  const deposit = () => run("deposit MUSD", async () => {
    const musd = new ethers.Contract(MUSD_ADDRESS, ERC20_ABI, operator.signer);
    const amt = ethers.parseUnits(depositAmt || "0", 18);
    const addr = await operator.signer.getAddress();
    const allowed = await musd.allowance(addr, TREASURY_ADDRESS);
    if (allowed < amt) {
      const ap = await musd.approve(TREASURY_ADDRESS, amt);
      await ap.wait().catch(() => null);
    }
    return treasuryWithSigner().deposit(amt);
  });

  // Owner commands: the locked case is answered before the round trip, and a 403
  // from the wire is handled identically to one predicted locally.
  const ownerCommand = async (label, call) => {
    setBusy(label); setMsg(null);
    if (gwLocked) {
      setMsg({ ok: false, label, locked: true, error: ADMIN_LOCKED_DETAIL });
      setBusy(null);
      return;
    }
    const r = await call();
    if (isAdminLocked(r)) {
      setMsg({ ok: false, label, locked: true, code: "admin_locked", error: r.detail || ADMIN_LOCKED_DETAIL });
    } else {
      setMsg(r.ok ? { ok: true, label } : { ok: false, label, error: r.error || `HTTP ${r.status ?? "?"}` });
    }
    setBusy(null); refresh();
  };
  const gwPause = () => ownerCommand("gateway pause", () => pauseGateway("paused from the dashboard"));
  const gwUnpause = () => ownerCommand("gateway resume", () => unpauseGateway());

  // A non owner sees an explanation, not a wall of disabled buttons.
  if (!operator.signer) {
    return (
      <Card
        title="Protocol controls"
        aside={<Badge tone="neutral"><Dot tone="warn" /> owner not connected</Badge>}
      >
        <p className="text-[14px] leading-relaxed text-muted">
          Everything in this section acts on the treasury itself: releasing float, depositing MUSD, pausing, and
          sweeping an agent's balance back. Those calls are <span className="code">onlyOwner</span>, so they need the
          wallet that owns the treasury: <AddressLink address={TREASURY_OWNER} chars={6} />.
        </p>
        <Note className="mt-4">
          <b className="text-text">Not the owner?</b> That is the normal case and nothing above is blocked by it. Your
          own funds, budget and payments all work without these controls. They exist for whoever funded the treasury.
          <div className="mt-3 flex flex-wrap gap-2">
            {!session.configured && (
              <Button variant="primary" onClick={connectLegacy} disabled={connecting}>
                {connecting ? "…" : "Connect injected wallet"}
              </Button>
            )}
            {session.configured && !session.user && (
              <Button variant="primary" onClick={session.login} disabled={session.authenticating}>
                {session.authenticating ? "Opening…" : "Sign in"}
              </Button>
            )}
            {session.configured && session.user && (
              <span className="text-[13.5px] text-dim">
                Connect the owner address in your wallet. The session compares it to{" "}
                <span className="code">treasury.owner()</span> on chain before enabling anything here.
              </span>
            )}
          </div>
        </Note>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {operator.isOwner === false && (
        <Note tone="bad">
          Connected, but this is not the treasury owner ({short(TREASURY_OWNER, 6)}). Writes will revert with{" "}
          <span className="code">NotOwner</span>.
        </Note>
      )}

      <Card
        title="Protocol controls"
        aside={
          <Badge tone={canWrite ? "ok" : "bad"}>
            <Dot tone={canWrite ? "ok" : "bad"} />
            {canWrite ? "owner connected" : "wrong wallet"}
          </Badge>
        }
      >
        <p className="text-[13.5px] leading-relaxed text-muted">
          Real onchain transactions on {CHAIN.name}, paid in {CHAIN.nativeCurrency.symbol}. No agent key is used here
          and none ever reaches the browser. These controls have <b className="text-text">no ceiling</b>. Unlike the
          self service budget above, the owner may set any cap on any agent.
        </p>

        {/* target agent */}
        <div className="mt-5 rounded-xl border border-line-soft bg-ink-dim/50 p-4">
          <div className="mb-2.5 text-[12.5px] uppercase tracking-[0.14em] text-dim">Target agent</div>
          <div className="flex flex-wrap gap-2">
            <TargetButton active={target === "gateway"} onClick={() => setTarget("gateway")} disabled={!health?.agentWallet}>
              Gateway demo agent
              {health?.agentWallet && <span className="ml-1.5 font-mono text-[12px] opacity-70">{short(health.agentWallet, 3)}</span>}
            </TargetButton>
            <TargetButton active={target === "own"} onClick={() => setTarget("own")} disabled={!session.agentAddress}>
              Your agent
              {session.agentAddress && <span className="ml-1.5 font-mono text-[12px] opacity-70">{short(session.agentAddress, 3)}</span>}
            </TargetButton>
            <TargetButton active={target === "custom"} onClick={() => setTarget("custom")}>
              Another address
            </TargetButton>
          </div>

          {target === "custom" && (
            <div className="mt-3 max-w-md">
              <Field label="Agent address">
                <input className="input" value={customAgent} placeholder="0x…"
                       onChange={(e) => setCustomAgent(e.target.value)} spellCheck={false} />
              </Field>
            </div>
          )}

          <div className="mt-3 text-[13.5px] text-muted">
            {agentAddress
              ? <>Acting on <AddressLink address={agentAddress} /></>
              : <span className="text-warn">No valid target selected, so the actions below are disabled.</span>}
          </div>
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          {/* release float */}
          <Card title="Release float" aside={<Badge tone="neutral">fundAgent</Badge>}>
            <Field label="Amount (MUSD)" hint="Rejected on chain if it exceeds the agent's per call max or its remaining daily cap.">
              <div className="flex gap-2">
                <input className="input" value={amount} inputMode="decimal"
                       onChange={(e) => setAmount(e.target.value)} />
                <Button onClick={fund} disabled={!canWrite || !agentAddress || busy !== null}>
                  {busy === "fundAgent" ? "…" : "release"}
                </Button>
              </div>
            </Field>
            <Note className="mt-3">
              Treasury holds <b className="tnum text-text">{fmtMusd(health?.treasury?.balance, 2)}</b> MUSD. This is the
              onchain cap: an agent can never spend more than has been released to it.
            </Note>
          </Card>

          {/* limits */}
          <Card title="Spending limits" aside={<Badge tone="neutral">setAgentLimits</Badge>}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Per call max (MUSD)">
                <input className="input" value={perCall} inputMode="decimal"
                       onChange={(e) => setPerCall(e.target.value)} />
              </Field>
              <Field label="Daily cap (MUSD)">
                <input className="input" value={daily} inputMode="decimal"
                       onChange={(e) => setDaily(e.target.value)} />
              </Field>
            </div>
            <div className="mt-3">
              <Button onClick={setLimits} disabled={!canWrite || !agentAddress || busy !== null}>
                {busy === "setAgentLimits" ? "…" : "apply limits"}
              </Button>
            </div>
            <Note className="mt-3">
              Lower the per call max below a seller's price and the treasury refuses the payment before anything is
              signed. That refusal is written to the ledger as a denial.
            </Note>
          </Card>

          {/* deposit */}
          <Card title="Deposit MUSD" aside={<Badge tone="neutral">approve + deposit</Badge>}>
            <Field label="Amount (MUSD)" hint="Approves the treasury first if the allowance is short, then deposits.">
              <div className="flex gap-2">
                <input className="input" value={depositAmt} inputMode="decimal"
                       onChange={(e) => setDepositAmt(e.target.value)} />
                <Button onClick={deposit} disabled={!canWrite || busy !== null}>
                  {busy === "deposit MUSD" ? "…" : "deposit"}
                </Button>
              </div>
            </Field>
          </Card>

          {/* pause */}
          <Card
            title="Pause"
            aside={
              <Badge tone={chainPaused || gwPaused ? "bad" : "ok"}>
                <Dot tone={chainPaused || gwPaused ? "bad" : "ok"} />
                {chainPaused ? "paused on chain" : gwPaused ? "gateway paused" : "running"}
              </Badge>
            }
          >
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {gwPaused
                  ? <Button onClick={gwUnpause} icon={Play} disabled={gwLocked || busy !== null}
                            title={gwLocked ? "Locked: this gateway needs GATEWAY_ADMIN_TOKEN, which this bundle does not carry" : "Resume gateway signing immediately"}>
                      {busy === "gateway resume" ? "…" : "resume gateway"}
                    </Button>
                  : <Button onClick={gwPause} icon={Pause} disabled={gwLocked || busy !== null}
                            title={gwLocked ? "Locked: this gateway needs GATEWAY_ADMIN_TOKEN, which this bundle does not carry" : "Stop gateway signing immediately, no transaction and no gas"}>
                      {busy === "gateway pause" ? "…" : "pause gateway"}
                    </Button>}
                <span className="text-[13px] text-dim">instant · no tx · no gas · stops signing</span>
                {gwLocked && <Badge tone="warn" icon={Lock}>locked, token required</Badge>}
              </div>
              {gwLocked && (
                <Note tone="warn" icon={Lock} title="The gateway pause is locked on this deployment">
                  {ADMIN_LOCKED_DETAIL}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" className="border border-line-soft" icon={Landmark}
                            onClick={pause} disabled={!canWrite || busy !== null}
                            title={canWrite ? "Pause the treasury on chain, authoritative and needs the owner wallet" : "Connect the owner wallet to pause on chain"}>
                      Pause on chain instead
                    </Button>
                  </div>
                </Note>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {chainPaused
                  ? <Button onClick={unpause} disabled={!canWrite || busy !== null}>{busy === "unpause" ? "…" : "unpause on chain"}</Button>
                  : <Button onClick={pause} disabled={!canWrite || busy !== null}>{busy === "pause" ? "…" : "pause on chain"}</Button>}
                <span className="text-[12.5px] text-dim">authoritative · owner tx</span>
              </div>
            </div>
            <Note tone="bad" className="mt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="danger" onClick={stop} disabled={!canWrite || !agentAddress || busy !== null}>
                  {busy === "emergencyStop" ? "…" : "EMERGENCY STOP"}
                </Button>
                <span className="text-[12.5px]">pauses the treasury and sweeps the agent's float back</span>
              </div>
              <p className="mt-2.5">
                Pausing alone stops <i>further</i> releases. An agent already holding float can still spend it. The
                sweep is what actually stops it, and it needs the agent's recall allowance.
              </p>
            </Note>
          </Card>
        </div>
      </Card>

      {msg && (
        <Note tone={msg.ok ? "ok" : msg.locked ? "warn" : "bad"}
              icon={msg.locked ? Lock : undefined}
              title={msg.locked ? "That control is locked on this deployment" : undefined}>
          {msg.ok ? (
            <>
              <b>{msg.label}</b> succeeded.
              {msg.hash && <> Tx: <TxLink hash={msg.hash} /></>}
              {msg.confirmed === false && (
                <span className="text-dim"> · broadcast, confirmation not seen within 25s. The Mezo testnet RPC
                often reports receipts late, so check the explorer link.</span>
              )}
            </>
          ) : (
            <>
              <b>{msg.label ? `${msg.label} failed` : "Failed"}.</b> {msg.error}
              {msg.code && <> <span className="code">{msg.code}</span></>}
              {msg.data && <> <span className="font-mono text-[12.5px]">({msg.data.join(", ")})</span></>}
            </>
          )}
        </Note>
      )}
    </div>
  );
}

function TargetButton({ active, children, ...rest }) {
  return (
    <button className={`btn ${active ? "btn-primary" : ""}`} aria-pressed={active} {...rest}>
      {children}
    </button>
  );
}