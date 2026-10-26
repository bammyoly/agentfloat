// ---------------------------------------------------------------------------
// Spend — buy a paid API with x402.
//
// THREE PATHS, and the difference between them is who signs and who fetches:
//
//   your wallet · relay   YOU sign in the browser, the GATEWAY fetches. Works
//                         against any seller, because CORS is a browser rule and
//                         Node has no such rule. This is the default, and it is
//                         the reason a normal user can now pay Mezo's hosted demo
//                         — which used to fail with "Failed to fetch".
//
//   your wallet · direct  You sign AND the browser fetches. Only works against a
//                         seller that sends Access-Control-Allow-Origin. Kept
//                         because it proves the relay is not load-bearing for the
//                         signature: nothing about the payment changes, only who
//                         carries the HTTP request.
//
//   gateway demo agent    The operator's key signs server-side. Useful for a demo
//                         with no sign-in, and it is the path that was verified on
//                         testnet first.
//
// In every path the key that signs is the key that pays, policy is checked
// against the REAL quoted price before anything is signed, and the outcome is
// verified against the chain rather than believed from an HTTP status.
//
// AND A FOURTH CHOICE: HOW OFTEN
//   Once a quote exists the user picks "pay once" or "run automatically". The
//   automation repeats THIS purchase on a schedule, and its purpose is to make the
//   budget controls visible without anybody clicking Pay forty times: the panel
//   predicts which run the cap will refuse, then the run log shows the gateway
//   refusing exactly that run, with the denial written on chain. Lower a daily cap
//   on /operate, start the loop, and watch it stop itself.
//
//   The loop calls the SAME purchase() the Pay button calls. That is deliberate:
//   two code paths would mean the demo proves something the product does not do.
//   All the arithmetic (classification, totals, when to stop, the projection, and
//   which of the five steps a refusal happened at) is pure and lives in
//   lib/autopay.js with its own offline tests.
//
// THE STEPPER IS AN INSTRUMENT, NOT A CAPTION
//   FlowStepper renders flowStep()'s answer, so the five stages of a purchase show
//   where the money actually got to. A refusal lands on the step that produced it
//   and the steps after it stay unreached — which is what makes "the daily cap
//   stopped run six" legible in one glance instead of requiring the reader to
//   parse a JSON refusal.
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight, BadgeDollarSign, Ban, Check, CircleAlert, CircleCheck, CircleHelp,
  CircleSlash, Clock, Coins, Gauge, Landmark, Minus, PenLine, Play, PlugZap,
  ReceiptText, RefreshCw, Repeat, RotateCcw, Send, ShieldCheck, Square, Timer,
  TrendingUp, Wallet, X, Zap,
} from "lucide-react";
import { useAppData } from "../lib/app-data.jsx";
import { useSession } from "../lib/session.jsx";
import { REASON_LABEL, useAgentStatus } from "../lib/agent-status.jsx";
import {
  DEFAULT_SCHEDULE, OUTCOME, OUTCOME_LABEL, STOP_REASON_LABEL, budgetView,
  describeSchedule, flowStep, makeRun, normalizeSchedule, shouldContinue, summarize,
} from "../lib/autopay.js";
import {
  AddressLink, Badge, Button, Card, Dot, Field, Grid, Icon, IconTile, Meter,
  MoreLink, Note, PageHeader, Segmented, Stat, Table, TxLink,
} from "../components/ui.jsx";
import { quote, pay, recordSettlement, relayProbe, relayExecute } from "../lib/gateway.js";
import { makeBrowserPayer, makeRelaySigner, probeUnpaid } from "../lib/x402-browser.js";
import { readAllowance } from "../lib/permit2.js";
import ApprovalModal from "../components/ApprovalModal.jsx";
import { fmtMusd, short } from "../lib/chain.js";
import { CHAIN, MUSD_ADDRESS } from "../contracts/index.js";

/** Icon per flow stage, so the stepper reads as a picture of the protocol. */
const STEP_ICON = {
  request: Send,
  quote: ReceiptText,
  policy: ShieldCheck,
  signature: PenLine,
  settle: Landmark,
};

export default function Spend() {
  const { health, refresh } = useAppData();
  const session = useSession();
  const mine = useAgentStatus(session.agentAddress);

  const sellerUrl = health?.seller?.selfUrl || null;
  const sellerMounted = health?.seller?.mounted;
  // A deployed frontend cannot hand a browser `http://127.0.0.1:4022/paid/insight`
  // — that is the reader's own machine. The gateway publishes a relative path for
  // exactly this case, and the same-origin proxy (Vite locally, vercel.json in
  // production) resolves it. Falls back to the loopback URL for an older gateway.
  const sellerBrowserUrl = health?.seller?.browserUrl || sellerUrl;

  const [url, setUrl] = useState("https://demo.vativ.io/");
  const [payer, setPayer] = useState(session.agentAddress ? "own" : "gateway");
  const [path, setPath] = useState("relay");
  const [busy, setBusy] = useState(null); // "quote" | "signing" | "settling"
  const [q, setQ] = useState(null);
  const [probe, setProbe] = useState(null); // relay probe, kept for signing
  // The probe response does not echo the URL it belongs to, so track it here.
  // Without this, every "Pay" re-probed the seller even one click after a
  // "Quote" — a wasted round trip, and a second fetch that could in principle
  // return different requirements than the quote the user just read.
  const [probeUrl, setProbeUrl] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  // The MUSD → Permit2 allowance of the signed-in wallet. Without it EVERY payment
  // is refused with permit2_not_approved, and the remedy used to be a developer
  // script. Read once on mount and again after the popup closes: the allowance only
  // changes when this wallet sends an approval, so polling would be noise.
  const [allowance, setAllowance] = useState(null);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvedTx, setApprovedTx] = useState(null);
  // --- automation: "pay once" vs "run automatically" -------------------------
  // The run log IS the state machine. Nothing is counted in a ref, because a
  // second source of truth is how a loop ends up running forever: after every run
  // shouldContinue() is asked, from the log, and it alone decides whether the next
  // timer is armed.
  const [buyMode, setBuyMode] = useState("once");      // "once" | "auto"
  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE);
  const [runs, setRuns] = useState([]);
  const [autoRunning, setAutoRunning] = useState(false);

  const refreshAllowance = useCallback(async () => {
    if (!session.agentAddress) { setAllowance(null); return; }
    setAllowance(await readAllowance(session.agentAddress));
  }, [session.agentAddress]);

  useEffect(() => { refreshAllowance(); }, [refreshAllowance]);

  const canUseOwn = Boolean(session.agentAddress);
  const effectivePayer = payer === "own" && !canUseOwn ? "gateway" : payer;
  const via = effectivePayer === "gateway" ? "gateway" : path === "relay" ? "relay" : "browser";

  // The caps that bind a run are the caps of the wallet that SIGNS. Paying through
  // the demo agent means the demo agent's caps, and showing the user's own numbers
  // next to a refusal caused by somebody else's cap would be a lie on screen.
  // Polled only when it is a different address — `mine` already reads this one.
  const demoAgent = useAgentStatus(
    effectivePayer === "gateway" ? health?.agentWallet || null : null
  );
  const budget = effectivePayer === "gateway" ? demoAgent : mine;

  const presets = useMemo(
    () =>
      [
        { label: "Mezo hosted demo", detail: "$0.001 · no CORS", url: "https://demo.vativ.io/", cors: false },
        sellerMounted && sellerBrowserUrl
          ? { label: "built-in demo seller", detail: `${health?.seller?.price} · gateway-hosted`, url: sellerBrowserUrl, cors: true }
          : null,
      ].filter(Boolean),
    [sellerMounted, sellerBrowserUrl, health?.seller?.price]
  );

  function reset(keepUrl = true) {
    if (!keepUrl) setUrl("https://demo.vativ.io/");
    setQ(null); setProbe(null); setProbeUrl(null); setResult(null); setErr(null);
    // A different endpoint, payer or path is a different purchase, so the run log
    // describing the old one has to go with it.
    setRuns([]); setAutoRunning(false);
  }

  // --- quote: learn the price without signing anything ----------------------
  async function onQuote() {
    setBusy("quote"); setErr(null); setResult(null); setQ(null); setProbe(null); setProbeUrl(null);
    try {
      if (effectivePayer === "gateway") {
        const r = await quote(url);
        if (r.unreachable) throw new Error("gateway unreachable — is it running?");
        if (!r.ok) throw new Error(r.error || `quote failed (HTTP ${r.status})`);
        setQ({ ...r, via: "gateway", atRun: runs.length });
      } else if (path === "relay") {
        const r = await relayProbe(url, session.agentAddress);
        if (r.unreachable) throw new Error("gateway unreachable — the relay lives in the gateway process");
        if (!r.ok) throw new Error(r.error || `relay probe failed (HTTP ${r.status})`);
        setProbe(r); setProbeUrl(url);
        setQ({ ...r, via: "relay", atRun: runs.length });
      } else {
        const probed = await probeUnpaid(url);
        setQ({ ...probed, via: "browser", atRun: runs.length });
      }
    } catch (e) {
      setErr(explainFetchError(e, { via, url }));
    } finally {
      setBusy(null);
    }
  }

  // --- one purchase ----------------------------------------------------------
  /**
   * Probe → sign → settle → verify, and RETURN the result rather than render it.
   *
   * Both the Pay button and the automation loop call this. One implementation is
   * the point: if the loop had its own path, the demo would prove something the
   * product does not do.
   */
  const purchase = useCallback(async ({ atRun = 0 } = {}) => {
    if (effectivePayer === "gateway") {
      setBusy("settling");
      const r = await pay(url);
      if (r.unreachable) throw new Error("gateway unreachable — is it running?");
      return { ...r, via: "gateway" };
    }

    if (path === "relay") {
      // Probe first if the user went straight to pay: the signature has to
      // cover the seller's actual requirements, not a guess.
      let p = probe;
      if (!p || probeUrl !== url) {
        setBusy("quote");
        p = await relayProbe(url, session.agentAddress);
        if (!p.ok) throw new Error(p.error || `relay probe failed (HTTP ${p.status})`);
        setProbe(p); setProbeUrl(url); setQ({ ...p, via: "relay", atRun });
      }
      if (!p.requiresPayment) {
        return { ok: true, paid: false, via: "relay", status: p.status, body: safeBody(p.body),
          note: "That endpoint is free — it answered without asking for payment." };
      }

      setBusy("signing");
      const signer = await makeRelaySigner(session.agentWallet);
      const { payment, paymentHeaders } = await signer.signProbe(p);

      setBusy("settling");
      const r = await relayExecute({ url, agent: signer.address, payment, paymentHeaders });
      return { ...r, via: "relay" };
    }

    // --- direct from the browser: sign AND fetch here --------------------
    setBusy("signing");
    const payerClient = await makeBrowserPayer(session.agentWallet);
    setBusy("settling");
    const res = await payerClient.fetchWithPay(url, {
      headers: { Accept: "application/json", "User-Agent": "agentfloat-browser/1.0" },
    });
    const bodyText = await res.text();
    const pr = res.headers.get("payment-response") || res.headers.get("PAYMENT-RESPONSE");
    let settlement = null;
    try { settlement = pr ? JSON.parse(atob(pr)) : null; } catch { settlement = null; }
    const settlementTx = settlement?.transaction || null;

    // Do NOT trust the HTTP status to say whether MUSD moved — it has been
    // observed to disagree with the chain in both directions.
    let recorded = null;
    if (settlementTx) {
      recorded = await recordSettlement({ agent: payerClient.address, settlementTx, endpoint: url });
    }

    return {
      via: "browser",
      ok: res.status < 400,
      paid: Boolean(settlementTx),
      settled: Boolean(settlementTx),
      delivered: res.status < 400,
      status: res.status,
      body: safeBody(bodyText),
      receipt: {
        agent: payerClient.address,
        amountMusd: settlement?.amount ? fmtMusd(settlement.amount, 4) : null,
        settlementTx,
        source: recorded?.recorded ? "chain" : "browser",
        txHash: recorded?.txHash || null,
        verified: recorded?.verified ?? null,
        confirmed: recorded?.confirmed ?? null,
      },
      recordNote: recorded?.note || recorded?.error || null,
    };
  }, [effectivePayer, path, url, probe, probeUrl, session.agentAddress, session.agentWallet]);
  // purchase() is called with no arguments by the Pay button and with the current
  // run count by the loop; the stamp only matters when a probe is re-taken mid-run.

  // A payment moves the caps AND consumes an exact-amount approval, so all three
  // reads are refreshed together. A gauge that lags the run it is describing looks
  // broken in a demo and is misleading in production.
  const syncAfterRun = useCallback(() => {
    refresh();
    budget.refresh?.();
    refreshAllowance();
  }, [refresh, budget.refresh, refreshAllowance]);

  async function onPay() {
    setErr(null); setResult(null);
    try {
      const r = await purchase();
      setResult(r);
      syncAfterRun();
    } catch (e) {
      setErr(explainFetchError(e, { via, url }));
    } finally {
      setBusy(null);
    }
  }

  // --- derived: the quote, the budget it is judged against, the loop decision --
  const offer = q?.offer || null;
  const policy = q?.policy || null;
  const blocked = busy !== null || !health || health.unreachable;

  // Covers both "never approved" and "approved for less than this quote" — the
  // second happens once an exact-amount approval has been consumed by a payment.
  const approvalNeeded = effectivePayer === "own" && allowance !== null &&
    (offer?.amount ? allowance < BigInt(offer.amount) : allowance === 0n);

  const quoteWei = offer?.amount ?? null;
  // Raw input goes into state so typing is not fought by clamping; the normalized
  // copy is what the loop and the projection actually use.
  const sched = normalizeSchedule(schedule);
  const decision = shouldContinue({ runs, schedule: sched });
  const summary = summarize(runs);
  // Where the purchase has got to, derived from the same state the page acts on.
  const flow = flowStep({ busy, quote: q, policy, result });

  // Today's spend comes from the GATEWAY, which sums the treasury's on-chain
  // payment receipts — not from the contract's remainingToday, which is how much
  // more FLOAT the treasury may release today and has nothing to do with spending.
  // The figure was read when this quote was taken, so runs since then are added
  // from the log: live mid-loop, and never double-counted.
  const policyBudget = policy?.budget || null;
  const sessionMoved = useMemo(
    () => summarize(runs.slice(q?.atRun ?? 0)).movedWei,
    [runs, q?.atRun]
  );
  const projection = budgetView({
    status: budget.status,
    spentTodayWei: policyBudget?.spentToday ?? null,
    sessionWei: sessionMoved,
    quoteWei,
    runsDone: runs.length,
  });

  // --- one automated run ----------------------------------------------------
  const runOnce = useCallback(async () => {
    const index = runs.length + 1;
    let run;
    try {
      const r = await purchase({ atRun: runs.length });
      run = makeRun({ index, quoteWei, result: r });
      setResult(r);   // the newest run is also the newest single result
      setErr(null);
    } catch (e) {
      run = makeRun({ index, quoteWei, error: e });
      setErr(explainFetchError(e, { via, url }));
    } finally {
      setBusy(null);
    }
    setRuns((prev) => [...prev, run]);
    syncAfterRun();
  }, [runs.length, purchase, quoteWei, syncAfterRun, via, url]);

  /**
   * Arm the next run.
   *
   * The delay is 0 for the first run so pressing Start does something at once,
   * and the schedule's interval after that. The effect re-arms when the log grows
   * — the only event that can change shouldContinue()'s answer — so the timer is
   * never torn down by a per-second tick, which is the classic way an interval
   * like this silently never fires.
   */
  useEffect(() => {
    if (!autoRunning) return undefined;
    if (!decision.run) { setAutoRunning(false); return undefined; }
    const delayMs = runs.length === 0 ? 0 : sched.intervalSec * 1000;
    const t = setTimeout(() => { void runOnce(); }, delayMs);
    return () => clearTimeout(t);
  }, [autoRunning, runs.length, decision.run, sched.intervalSec, runOnce]);

  function startAuto() {
    setErr(null); setResult(null); setRuns([]);
    setAutoRunning(true);
  }
  function patchSchedule(patch) { setSchedule((prev) => ({ ...prev, ...patch })); }
  function useDemoAgent() { setPayer("gateway"); reset(); }
  function stopAuto() { setAutoRunning(false); }
  function resetAuto() { setAutoRunning(false); setRuns([]); setResult(null); setErr(null); }

  return (
    <div className="animate-fade space-y-6 pb-12">
      <PageHeader
        icon={PlugZap}
        eyebrow="x402 payments"
        title="Spend"
        sub="Pay for a real HTTP resource in MUSD. Policy is applied to the seller's actual quoted price before anything is signed, and the outcome is verified against the chain — never believed from an HTTP status."
        aside={
          <>
            <Badge tone={effectivePayer === "own" ? "btc" : "info"} icon={effectivePayer === "own" ? Wallet : Zap}>
              <Dot tone={effectivePayer === "own" ? "btc" : "info"} />
              {effectivePayer === "own" ? `your wallet · ${via}` : "gateway demo agent"}
            </Badge>
            {health && !health.unreachable && (
              <Badge tone="neutral" icon={ShieldCheck} title="The gateway checks every quote against the on-chain caps before it will sign">
                policy armed
              </Badge>
            )}
          </>
        }
      />

      <FlowStepper flow={flow} />

      <div className="grid items-start gap-6 lg:grid-cols-[1.5fr_1fr]">
        {/* ---------------- left: the purchase ---------------- */}
        <Card
          icon={BadgeDollarSign}
          tone="btc"
          title="Buy a service"
          sub="Choose who pays, what to buy, and whether the agent buys it once or on a schedule."
          aside={<Badge tone="neutral" icon={Coins}>agent signs · facilitator pays gas</Badge>}
        >
          {/* who pays */}
          <Segmented
            label="Who pays"
            value={effectivePayer}
            onChange={(v) => { setPayer(v); reset(); }}
            options={[
              {
                value: "own",
                label: "Your agent wallet",
                icon: Wallet,
                hint: session.agentAddress
                  ? `${short(session.agentAddress, 4)} — you sign in this browser`
                  : "Sign in to use your own wallet",
                disabled: !canUseOwn,
                title: canUseOwn ? "Your own agent wallet signs — the key never leaves Privy" : "Sign in to use your own wallet",
              },
              {
                value: "gateway",
                label: "Gateway demo agent",
                icon: Zap,
                hint: "Signs server-side — no prompts, good for an unattended loop",
                title: "The gateway signs with its demo agent key, server-side",
              },
            ]}
          />
          {payer === "own" && !canUseOwn && (
            <p className="mt-2 flex items-center gap-2 text-[13px] text-warn">
              <Icon as={CircleAlert} size={14} />
              Sign in to pay with your own wallet — until then this falls back to the demo agent.
            </p>
          )}

          {/* how the request is fetched — only meaningful for your own wallet */}
          {effectivePayer === "own" && (
            <div className="mt-6">
              <Segmented
                label="How the request is fetched"
                value={path}
                onChange={(v) => { setPath(v); reset(); }}
                options={[
                  {
                    value: "relay",
                    label: "Gateway relay",
                    icon: ShieldCheck,
                    badge: "recommended",
                    hint: "Works with any seller, including ones with no CORS header",
                    title: "Your wallet signs; the gateway carries the HTTP request. Works with any seller.",
                  },
                  {
                    value: "direct",
                    label: "Direct from browser",
                    icon: Send,
                    hint: "The browser calls the seller itself — the seller must allow it",
                    title: "The browser fetches the seller directly. Needs the seller to allow cross-origin calls.",
                  },
                ]}
              />
              <Note className="mt-3">
                {path === "relay"
                  ? <>Signing happens in this browser; only the HTTP request is relayed, so a seller with no{" "}
                      <span className="code">Access-Control-Allow-Origin</span> still works. The gateway sees one opaque
                      header it cannot forge, and decodes it to check the payer and the amount before it forwards anything.</>
                  : <>The browser calls the seller itself. Sellers that send no CORS header — Mezo's hosted demo
                      included — cannot be reached this way. Nothing about the signature changes; only who carries the
                      request. If this fails with "Failed to fetch", that is CORS and not your wallet.</>}
              </Note>
            </div>
          )}

          {approvalNeeded && (
            <Note tone="warn" className="mt-6" icon={CircleAlert} title="Payments will be refused until this wallet approves Permit2">
              x402 settles by letting Permit2 move MUSD out of the wallet, which takes one approval transaction signed by
              you{offer?.amount ? ` for at least ${fmtMusd(offer.amount, 4)} MUSD` : ""}. It is not a setting AgentFloat can
              flip for you — and it should not be.
              <div className="mt-3.5">
                <Button size="sm" variant="primary" icon={ShieldCheck} onClick={() => setApprovalOpen(true)}>
                  Enable payments
                </Button>
              </div>
            </Note>
          )}

          {approvedTx && (
            <Note tone="ok" className="mt-6" icon={CircleCheck} title="Payments enabled">
              Approval transaction <TxLink hash={approvedTx} />. Pay again and it will go through.
            </Note>
          )}

          <div className="mt-6">
            <Field label="Paid endpoint">
              <div className="flex flex-col gap-2.5 sm:flex-row">
                <input
                  id="payurl"
                  className="input"
                  value={url}
                  placeholder="https://api.example.com/paid-endpoint"
                  onChange={(e) => { setUrl(e.target.value); setProbe(null); }}
                  spellCheck={false}
                  autoComplete="off"
                />
                <div className="flex gap-2.5">
                  <Button onClick={onQuote} disabled={blocked} busy={busy === "quote"} icon={ReceiptText} className="shrink-0">
                    {busy === "quote" ? "quoting…" : "Quote"}
                  </Button>
                  {buyMode === "once" ? (
                    <Button
                      variant="primary"
                      onClick={onPay}
                      disabled={blocked}
                      busy={busy === "signing" || busy === "settling"}
                      icon={busy ? undefined : Play}
                      className="shrink-0"
                    >
                      {busy === "signing" ? "sign in wallet…" : busy === "settling" ? "settling…" : "Pay once"}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={autoRunning ? stopAuto : startAuto}
                      disabled={blocked || (!autoRunning && !offer)}
                      busy={busy !== null && autoRunning}
                      icon={autoRunning ? Square : Repeat}
                      className="shrink-0"
                      title={!offer ? "Quote first — the loop repeats THIS purchase" : undefined}
                    >
                      {autoRunning ? "Stop runs" : busy !== null ? "running…" : "Start automated runs"}
                    </Button>
                  )}
                </div>
              </div>
            </Field>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-dim">try one:</span>
              {presets.map((p) => (
                <button
                  key={p.url}
                  type="button"
                  onClick={() => { setUrl(p.url); reset(); }}
                  title={p.cors ? "sends CORS headers — reachable from the browser too" : "no CORS headers — needs the relay or the gateway"}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line-soft bg-ink-dim px-3 py-1.5 text-left transition-colors hover:border-faint hover:bg-panel-2"
                >
                  <Icon as={p.cors ? Zap : Send} size={13} className="text-btc" />
                  <span>
                    <span className="block text-[13px] leading-tight font-medium text-text">{p.label}</span>
                    <span className="block font-mono text-[11.5px] leading-tight text-dim">{p.detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* how often — offered once there is a quote to repeat */}
          {q && (
            <div className="mt-7 border-t border-line-soft pt-6">
              <Segmented
                label="How the agent buys it"
                value={buyMode}
                onChange={setBuyMode}
                options={[
                  {
                    value: "once",
                    label: "Pay once",
                    icon: Play,
                    hint: "One signature, one purchase, one settlement",
                    title: "One signature, one purchase. You approve every payment.",
                  },
                  {
                    value: "auto",
                    label: "Run automatically",
                    icon: Repeat,
                    badge: "shows the caps working",
                    hint: "Repeats this purchase until your own budget stops it",
                    title: "Repeat this purchase on a schedule until your own budget stops it",
                  },
                ]}
              />
              <Note className="mt-3">
                {buyMode === "once"
                  ? <>One purchase, one signature, one settlement — verified against the chain before it is called paid.</>
                  : <>The same purchase, repeated on a schedule. Each run is individually signed and individually judged
                      against the on-chain per-call max and daily cap, so the loop stops itself the moment the budget says
                      stop. That is the whole product, running unattended.</>}
              </Note>
            </div>
          )}

          {!health || health.unreachable ? (
            <Note tone="bad" className="mt-5" icon={CircleSlash} title="Gateway unreachable">
              Start it with <span className="code">npm run dev</span> from the repo root — the relay, the policy engine
              and the demo agent all live in that process. On a deployment, check{" "}
              <span className="code">VITE_GATEWAY_URL</span> and the gateway's{" "}
              <span className="code">GATEWAY_ALLOWED_ORIGINS</span>.
            </Note>
          ) : !health.x402Ready && effectivePayer === "gateway" ? (
            <Note tone="warn" className="mt-5" icon={CircleAlert}>
              x402 is not armed — the gateway has no agent key. Quoting still works, since it is an unpaid probe.
            </Note>
          ) : null}

          {err && (
            <Note tone="bad" className="mt-5 whitespace-pre-wrap" icon={CircleSlash} title="That did not work">
              {err}
            </Note>
          )}

          {q && <QuoteView q={q} offer={offer} policy={policy} />}

          {buyMode === "auto" && q && (
            <AutoPanel
              schedule={schedule}
              effective={sched}
              onSchedule={patchSchedule}
              runs={runs}
              decision={decision}
              summary={summary}
              projection={projection}
              running={autoRunning}
              busy={busy}
              payerIsOwn={effectivePayer === "own"}
              walletLabel={effectivePayer === "own" ? short(session.agentAddress, 3) : "demo agent"}
              onStart={startAuto}
              onStop={stopAuto}
              onReset={resetAuto}
              onUseDemoAgent={useDemoAgent}
              result={result}
              onEnable={() => setApprovalOpen(true)}
            />
          )}

          {buyMode === "once" && result && (
            <ResultView result={result} onEnable={() => setApprovalOpen(true)} />
          )}
        </Card>

        {/* ---------------- right: your budget, and the fine print ---------- */}
        <div className="space-y-6">
          {canUseOwn && (
            <Card
              icon={Wallet}
              tone="btc"
              title="Your budget right now"
              sub="Read from the treasury contract and the gateway's receipt sum."
              aside={
                mine.registered === false
                  ? <Badge tone="warn" icon={CircleAlert}>unfunded</Badge>
                  : <Badge tone="ok" icon={CircleCheck}><Dot tone="ok" /> on-chain</Badge>
              }
            >
              {mine.registered === false ? (
                <Note tone="warn" icon={CircleAlert} title="No float to spend yet">
                  Your wallet exists but is not registered in the treasury, so there is nothing to spend. The faucet fixes
                  both in one step: it registers the wallet with on-chain caps and airdrops 10 MUSD.
                  <div className="mt-3.5">
                    <Link to="/faucet"><Button size="sm" variant="primary" icon={Coins}>Claim 10 MUSD</Button></Link>
                  </div>
                </Note>
              ) : mine.status ? (
                <>
                  <Grid cols={3} className="gap-5">
                    <Stat icon={Coins} label="Float" value={fmtMusd(mine.status.walletBalance, 4)} unit="MUSD" />
                    <Stat icon={Gauge} label="Per-call max" value={fmtMusd(mine.status.perCallMax, 2)} unit="MUSD" />
                    {/* Spend is known only once the gateway has judged a quote, so
                        show it when it exists — and never show the contract's
                        funding counter under a spending label. */}
                    {effectivePayer === "own" && projection.spendKnown ? (
                      <Stat icon={TrendingUp} label="Left to spend today"
                            value={fmtMusd(projection.leftToday, 4)} unit="MUSD"
                            hint={`${fmtMusd(projection.spentToday, 4)} spent · on-chain receipts`} />
                    ) : (
                      <Stat icon={Clock} label="Funding left today"
                            value={fmtMusd(mine.status.remainingToday, 2)} unit="MUSD"
                            hint="float the treasury may still release today — not a spend budget" />
                    )}
                  </Grid>

                  {effectivePayer === "own" && projection.spendKnown && projection.dailyPct !== null && (
                    <div className="mt-6 rounded-xl border border-line-soft bg-ink-dim p-4">
                      <div className="mb-2 flex items-baseline justify-between gap-2">
                        <span className="text-[12.5px] font-medium text-dim">today's spending cap</span>
                        <span className="tnum text-[15px] font-semibold text-text">
                          {projection.dailyPct.toFixed(1)}%
                        </span>
                      </div>
                      <Meter pct={projection.dailyPct} live={autoRunning} label="share of today's spending cap used" />
                      <div className="mt-2 flex items-center justify-between text-[12.5px] text-dim">
                        <span className="tnum">{fmtMusd(projection.spentToday, 4)} spent</span>
                        <span className="tnum">{fmtMusd(projection.dailyCap, 2)} cap · resets 00:00 UTC</span>
                      </div>
                    </div>
                  )}

                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-4 text-[13.5px] text-dim">
                    <span className="min-w-0">
                      These are your own caps, not the demo agent's. Changing them takes one signature.
                    </span>
                    <MoreLink to="/operate">Change your budget</MoreLink>
                  </div>
                </>
              ) : (
                <div className="space-y-3">
                  <div className="h-14 animate-pulse rounded-lg bg-line-soft" />
                  <div className="h-14 animate-pulse rounded-lg bg-line-soft" />
                </div>
              )}
            </Card>
          )}

          <DemoRecipe projection={projection} quoteWei={quoteWei} payerIsOwn={effectivePayer === "own"} />

          <Card icon={Coins} title="What you are paying with" sub="MUSD on Mezo testnet, settled by Permit2.">
            <dl className="dl">
              <dt>asset</dt>
              <dd>MUSD · 18 decimals</dd>
              <dt>network</dt>
              <dd className="font-mono">{CHAIN.caip2}</dd>
              <dt>scheme</dt>
              <dd>exact · permit2 (EIP-712)</dd>
              <dt>gas</dt>
              <dd className="text-right">sponsored by the facilitator in {CHAIN.nativeCurrency.symbol}</dd>
            </dl>
            <Note className="mt-4" icon={CircleHelp}>
              Your agent wallet needs MUSD and nothing else. It never holds gas for payments — the only transactions it
              signs for itself are the one-time Permit2 and recall approvals.
            </Note>
          </Card>

          <Card icon={ShieldCheck} tone="ok" title="Before anything is signed" sub="Why a quote is not a promise to pay.">
            <p className="text-[14px] leading-relaxed text-muted">
              Policy is applied to the <b className="text-text">real quoted price</b>, not to a number you typed. The
              seller is probed unpaid, its <span className="code">PAYMENT-REQUIRED</span> header is decoded, and the amount
              is checked against the paying agent's on-chain per-call max, today's spend, the endpoint allowlist, the pause
              flag and its live balance.
            </p>
            <p className="mt-3 text-[14px] leading-relaxed text-muted">
              It also refuses if the quoted asset is not the canonical MUSD — on testnet a second token reports the same
              name and symbol, so a seller could quote something worthless and be paid in something that is not.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link to="/ledger"><Button size="sm" variant="ghost" className="border border-line-soft" iconRight={ArrowRight}>See the ledger</Button></Link>
              <Link to="/operate"><Button size="sm" variant="ghost" className="border border-line-soft" iconRight={ArrowRight}>Change your caps</Button></Link>
            </div>
          </Card>
        </div>
      </div>

      <ApprovalModal
        open={approvalOpen}
        onClose={() => setApprovalOpen(false)}
        wallet={session.agentWallet}
        address={session.agentAddress}
        signMessage={session.signMessage}
        amountWei={offer?.amount || null}
        onApproved={({ hash }) => {
          setApprovedTx(hash);
          setResult(null);   // the refusal this produced is no longer true
          setErr(null);
          refreshAllowance();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The five-step flow indicator
// ---------------------------------------------------------------------------

const STEP_TONE = {
  done: "ok",
  active: "btc",
  refused: "bad",
  failed: "bad",
  skipped: "neutral",
  todo: "neutral",
};

const STEP_ICON_STATE = {
  done: Check,
  refused: X,
  failed: X,
  skipped: Minus,
};

/**
 * The flow, as a picture of where the money got to.
 *
 * `flow` comes from flowStep() in lib/autopay.js — pure and offline-tested, because
 * the mapping from a refusal code to a step is a claim about the protocol, not
 * decoration. `permit2_not_approved` landing on the SIGNATURE step rather than the
 * policy step is the difference between a user fixing their allowance and a user
 * lowering a cap that was never the problem.
 */
function FlowStepper({ flow }) {
  const { steps, at, verdict } = flow;
  return (
    <Card pad={false} className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-muted">
          <Icon as={PlugZap} size={15} className="text-btc" />
          how an x402 purchase happens
        </span>
        <VerdictBadge verdict={verdict} codes={flow.codes} />
      </div>

      {/* Desktop: one row of five with connectors. Mobile: a vertical list — five
          columns at 360px would be unreadable, and the order is the information. */}
      <ol className="hidden items-stretch gap-0 px-5 py-5 md:flex">
        {steps.map((s, i) => {
          const tone = STEP_TONE[s.state];
          const Glyph = STEP_ICON_STATE[s.state] || STEP_ICON[s.id];
          const isCurrent = i === at;
          return (
            <li key={s.id} className="flex min-w-0 flex-1 items-start">
              <div className="flex min-w-0 flex-1 flex-col items-center gap-2.5 text-center">
                <span
                  className={`grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 transition-colors ${
                    isCurrent ? "ring-4 ring-btc/15" : ""
                  }`}
                  style={{
                    color: `var(--color-${tone === "neutral" ? "dim" : tone})`,
                    borderColor: `color-mix(in srgb, var(--color-${tone === "neutral" ? "faint" : tone}) ${s.state === "todo" || s.state === "skipped" ? 35 : 70}%, transparent)`,
                    backgroundColor: s.state === "todo" || s.state === "skipped"
                      ? "transparent"
                      : `color-mix(in srgb, var(--color-${tone}) 14%, transparent)`,
                  }}
                  title={s.label}
                >
                  <Icon as={Glyph} size={17} />
                </span>
                <span className="min-w-0">
                  <span className={`block text-[11px] font-semibold tracking-[0.08em] uppercase ${
                    s.state === "todo" || s.state === "skipped" ? "text-faint" : "text-dim"
                  }`}>
                    step {i + 1}
                  </span>
                  <span className={`mt-0.5 block text-[13px] leading-snug font-medium ${
                    s.state === "todo" ? "text-faint" : s.state === "refused" || s.state === "failed" ? "text-bad" : "text-text"
                  }`}>
                    {s.short}
                  </span>
                </span>
              </div>
              {/* the connector: filled once the step before it is behind us */}
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className="mt-5 h-0.5 w-6 shrink-0 rounded-full md:w-10"
                  style={{
                    backgroundColor: steps[i].state === "done" ? "var(--color-ok)" : "var(--color-line)",
                    opacity: steps[i].state === "done" ? 0.55 : 1,
                  }}
                />
              )}
            </li>
          );
        })}
      </ol>

      <ol className="space-y-1 px-4 py-4 md:hidden">
        {steps.map((s, i) => {
          const tone = STEP_TONE[s.state];
          const Glyph = STEP_ICON_STATE[s.state] || STEP_ICON[s.id];
          return (
            <li key={s.id} className="flex items-center gap-3 rounded-lg px-1.5 py-2">
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full border-2"
                style={{
                  color: `var(--color-${tone === "neutral" ? "dim" : tone})`,
                  borderColor: `color-mix(in srgb, var(--color-${tone === "neutral" ? "faint" : tone}) 55%, transparent)`,
                }}
              >
                <Icon as={Glyph} size={14} />
              </span>
              <span className={`min-w-0 flex-1 text-[14px] leading-snug ${
                s.state === "todo" ? "text-faint" : "text-text"
              }`}>
                {s.label}
              </span>
              <span className="tnum shrink-0 text-[12px] text-faint">{i + 1}/5</span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/** One badge for where the purchase stands — the stepper's headline. */
function VerdictBadge({ verdict, codes = [] }) {
  const map = {
    idle: { tone: "neutral", icon: CircleHelp, text: "nothing purchased yet" },
    quoting: { tone: "info", icon: RefreshCw, text: "asking the seller for a price" },
    quoted: { tone: "info", icon: ReceiptText, text: "priced" },
    allowed: { tone: "ok", icon: ShieldCheck, text: "policy allows this price" },
    signing: { tone: "btc", icon: PenLine, text: "waiting on your signature" },
    settling: { tone: "btc", icon: Landmark, text: "settling on chain" },
    settled: { tone: "ok", icon: CircleCheck, text: "paid and verified" },
    refused: { tone: "bad", icon: Ban, text: `refused · ${codes[0] || "policy"}` },
    failed: { tone: "bad", icon: X, text: "failed" },
    charged_without_delivery: { tone: "warn", icon: CircleAlert, text: "charged, nothing delivered" },
    free: { tone: "neutral", icon: Minus, text: "no payment needed" },
  };
  const m = map[verdict] || map.idle;
  return (
    <Badge tone={m.tone} icon={m.icon} title={codes.length ? codes.join(", ") : undefined}>
      {m.tone === "btc" || verdict === "quoting" ? <Dot tone={m.tone} pulse /> : null}
      {m.text}
    </Badge>
  );
}

function safeBody(text) {
  if (typeof text !== "string") return text;
  try { return JSON.parse(text); } catch { return text; }
}

// ---------------------------------------------------------------------------
// The quote
// ---------------------------------------------------------------------------

function QuoteView({ q, offer, policy }) {
  const canonical = offer?.asset?.toLowerCase() === MUSD_ADDRESS.toLowerCase();
  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-line-soft bg-ink-dim">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-muted">
          <Icon as={ReceiptText} size={15} className="text-btc" />
          the seller's answer
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {offer && <Badge tone="neutral">{offer.network}</Badge>}
          <Badge tone="neutral" icon={q.via === "relay" ? ShieldCheck : q.via === "browser" ? Send : Zap}>via {q.via}</Badge>
        </span>
      </div>

      <div className="p-4">
        {offer ? (
          <>
            {/* The price is the one number on this panel, so it gets the largest
                type on the page after the balance. Everything else is detail. */}
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="stat-label">quoted price</div>
                <div className="tnum mt-1 text-[36px] leading-none font-semibold tracking-tight text-text">
                  {fmtMusd(offer.amount, 4)}
                  <span className="ml-2 text-[18px] font-medium text-muted">MUSD</span>
                </div>
              </div>
              {canonical
                ? <Badge tone="ok" icon={CircleCheck}>canonical MUSD</Badge>
                : <Badge tone="bad" icon={X}>not canonical MUSD — will be refused</Badge>}
            </div>

            {q.description && (
              <p className="mt-3.5 rounded-lg border border-line-soft bg-panel-2/50 px-3.5 py-2.5 text-[14px] leading-relaxed text-muted italic">
                “{q.description}”
              </p>
            )}

            <dl className="dl mt-4 border-t border-line-soft pt-4 text-[13.5px]">
              <dt>asset</dt>
              <dd className="font-mono">{short(offer.asset, 8)}</dd>
              <dt>pay to</dt>
              <dd className="font-mono">{short(offer.payTo, 8)}</dd>
              <dt>transfer</dt>
              <dd className="text-right">
                {offer.transferMethod || offer.scheme}
                {offer.eip712Name && <> · EIP-712 “{offer.eip712Name}”</>}
              </dd>
              {offer.maxTimeoutSeconds != null && (
                <><dt>timeout</dt><dd className="tnum text-right">{offer.maxTimeoutSeconds}s</dd></>
              )}
            </dl>
          </>
        ) : (
          <div className="flex items-center gap-3">
            <IconTile as={CircleHelp} tone="warn" />
            <div>
              <div className="text-[15px] font-medium text-text">HTTP {q.status}, and no price</div>
              <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
                That endpoint answered without a <span className="code">PAYMENT-REQUIRED</span> header, so there is
                nothing to buy. Check the URL — a free endpoint is not an error, but a paywalled one that answers 200 is.
              </p>
            </div>
          </div>
        )}

        {policy && (
          <div className="mt-4 border-t border-line-soft pt-4">
            {policy.allowed ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Badge tone="ok" icon={ShieldCheck}><Dot tone="ok" /> policy allows this payment</Badge>
                {policy.budget?.spentToday !== undefined && policy.budget?.spentToday !== null && (
                  <span className="tnum text-[13px] text-dim">
                    {fmtMusd(policy.budget.spentToday, 4)} already spent today of {fmtMusd(policy.budget.dailyCap, 2)}
                  </span>
                )}
              </div>
            ) : (
              <>
                <Badge tone="bad" icon={Ban}><Dot tone="bad" /> policy refuses</Badge>
                <ul className="mt-3 space-y-2">
                  {(policy.reasons || []).map((r) => (
                    <li key={r.code} className="flex items-start gap-2.5 rounded-lg border border-bad/25 bg-bad-dim/40 px-3 py-2.5">
                      <Icon as={X} size={14} className="mt-1 text-bad" />
                      <span className="min-w-0 text-[13.5px] leading-relaxed text-muted">
                        <span className="code text-bad">{r.code}</span>{" "}
                        {r.detail || REASON_LABEL[r.code] || "refused by policy"}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One purchase, in full
// ---------------------------------------------------------------------------

const RESULT_VIEW = {
  paid: { tone: "ok", icon: CircleCheck, title: "Paid and verified on chain" },
  free: { tone: "neutral", icon: Minus, title: "No payment needed" },
  refused: { tone: "bad", icon: Ban, title: "Refused by policy — nothing was signed" },
  charged: { tone: "warn", icon: CircleAlert, title: "Charged without delivery" },
  failed: { tone: "bad", icon: X, title: "Settlement failed" },
};

function ResultView({ result, onEnable = null }) {
  const r = result.receipt || {};
  const kind = result.blockedByPolicy ? "refused"
    : result.warning === "charged_without_delivery" ? "charged"
    : result.settled === false ? "failed"
    : result.paid === false ? "free"
    : result.ok ? "paid" : "failed";
  const v = RESULT_VIEW[kind];

  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-line-soft bg-ink-dim">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <span className="flex items-center gap-2.5 text-[14px] font-semibold" style={{ color: `var(--color-${v.tone === "neutral" ? "text" : v.tone})` }}>
          <Icon as={v.icon} size={17} />
          {v.title}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">via {result.via}</Badge>
          {result.status != null && <Badge tone="neutral">HTTP {result.status}</Badge>}
          {result.ms != null && <Badge tone="neutral" icon={Timer}>{result.ms}ms</Badge>}
        </span>
      </div>

      <div className="p-4">
        {result.note && <p className="mb-3 text-[14px] leading-relaxed text-muted">{result.note}</p>}

        {result.blockedByPolicy ? (
          <>
            <p className="text-[14.5px] leading-relaxed text-bad">{result.error}</p>
            <ul className="mt-3 space-y-2">
              {(result.reasons || []).map((x) => (
                <li key={x.code} className="flex items-start gap-2.5 rounded-lg border border-bad/25 bg-bad-dim/40 px-3 py-2.5">
                  <Icon as={X} size={14} className="mt-1 text-bad" />
                  <span className="min-w-0 text-[13.5px] leading-relaxed text-muted">
                    <span className="code text-bad">{x.code}</span>{" "}
                    {x.detail || REASON_LABEL[x.code] || ""}
                  </span>
                </li>
              ))}
            </ul>
            {result.denial?.source === "chain" && (
              <p className="mt-3.5 flex items-center gap-2 text-[13.5px] text-muted">
                <Icon as={Landmark} size={14} className="text-dim" />
                the refusal itself was written on chain: <TxLink hash={result.denial.txHash} />
              </p>
            )}
            {result.reasons?.some((x) => x.code === "permit2_not_approved") && onEnable && (
              <div className="mt-4 rounded-lg border border-warn/40 bg-warn-dim p-3.5">
                <p className="text-[14px] leading-relaxed text-text">
                  This is a one-time approval from your own wallet — not a script, and not a setting somebody else has to
                  change for you. You choose whether to approve this payment only or all future ones.
                </p>
                <div className="mt-3">
                  <Button size="sm" variant="primary" icon={ShieldCheck} onClick={onEnable}>Enable payments</Button>
                </div>
              </div>
            )}
            <p className="mt-3.5 text-[13.5px] leading-relaxed text-dim">
              Nothing was signed and nothing was spent.{" "}
              {result.reasons?.some((x) => x.code === "per_call_max" || x.code === "daily_cap") && (
                <>Those are your own caps — <Link to="/operate" className="text-info hover:underline">change them</Link>.</>
              )}
            </p>
          </>
        ) : result.warning === "charged_without_delivery" ? (
          <>
            <p className="text-[14.5px] leading-relaxed text-warn">
              MUSD left the wallet and settled on chain, but the seller returned no resource. The agent was charged
              without delivery.
            </p>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-muted">
              Recorded as a <b className="text-text">payment</b>, because the charge is real — hiding it would make the
              ledger understate spend. Verified against the MUSD transfer log, not inferred from the HTTP response.
            </p>
            {r.settlementTx && (
              <p className="mt-2.5 flex items-center gap-2 text-[13.5px] text-muted">
                <Icon as={Landmark} size={14} className="text-dim" /> settlement: <TxLink hash={r.settlementTx} />
              </p>
            )}
          </>
        ) : result.settled === false ? (
          <>
            <p className="text-[14px] leading-relaxed text-bad">{result.error}</p>
            {result.hint && <p className="mt-2 text-[13.5px] text-muted">fix: {result.hint}</p>}
            {result.denial?.source === "chain" && (
              <p className="mt-2 text-[13.5px] text-muted">refusal recorded on chain: <TxLink hash={result.denial.txHash} /></p>
            )}
          </>
        ) : (
          <>
            <p className="tnum text-[20px] leading-snug font-semibold text-ok">
              {result.paid === false
                ? `HTTP ${result.status}, and it asked for nothing`
                : `${r.amountMusd ?? ""} MUSD paid → HTTP ${result.status}`}
            </p>
            <dl className="dl mt-4 border-t border-line-soft pt-4 text-[13.5px]">
              {r.agent && <><dt>agent</dt><dd className="text-right"><AddressLink address={r.agent} /></dd></>}
              {r.payee && <><dt>payee</dt><dd className="text-right"><AddressLink address={r.payee} /></dd></>}
              {r.settlementTx && <><dt>settlement</dt><dd className="text-right"><TxLink hash={r.settlementTx} /></dd></>}
              {r.txHash && (
                <>
                  <dt>receipt</dt>
                  <dd className="text-right">
                    <TxLink hash={r.txHash} />
                    <span className="ml-2 text-dim">
                      {r.source === "chain" ? "written on chain" : r.source || "gateway-local"}
                      {r.verified === false && " · unverified"}
                    </span>
                  </dd>
                </>
              )}
            </dl>
            {result.recordNote && <p className="mt-2.5 text-[13px] text-dim">{result.recordNote}</p>}
          </>
        )}

        {result.body != null && result.body !== "" && (
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between text-[11.5px] font-semibold tracking-[0.06em] text-dim uppercase">
              <span>what you bought</span>
              {result.truncated && <span className="normal-case text-warn">truncated by the relay</span>}
            </div>
            <pre className="pre">
              {typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The automation panel: schedule, budget projection, run log, and the verdict.
//
// The order on screen is the order the argument is made. First what will happen
// (the projection, computed from the same on-chain numbers the gateway enforces),
// then what did happen (the log, one row per purchase, with the MUSD that actually
// moved), then why it stopped. A judge should be able to read the refusal before
// it happens and see it confirmed after.
// ---------------------------------------------------------------------------

const OUTCOME_TONE = {
  settled: "ok",
  refused: "bad",
  charged_without_delivery: "warn",
  failed: "bad",
  free: "neutral",
};

const OUTCOME_ICON = {
  settled: CircleCheck,
  refused: Ban,
  charged_without_delivery: CircleAlert,
  failed: X,
  free: Minus,
};

function AutoPanel({
  schedule, effective, onSchedule, runs, decision, summary, projection,
  running, busy, payerIsOwn, walletLabel, onStart, onStop, onReset,
  onUseDemoAgent, result, onEnable,
}) {
  const halted = !decision.run && runs.length > 0;

  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-btc/25 bg-ink-dim">
      {/* header: what state the loop is in, at a glance */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft bg-btc/5 px-4 py-3">
        <span className="flex items-center gap-2.5 text-[14px] font-semibold text-text">
          <Icon as={Repeat} size={16} className="text-btc" />
          automated runs
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={running ? "btc" : halted ? "warn" : "neutral"}
                 icon={running ? RefreshCw : halted ? Ban : Play}>
            <Dot tone={running ? "btc" : halted ? "warn" : "ok"} pulse={running} />
            {running
              ? `running · ${runs.length} of ${effective.maxRuns}`
              : halted ? (STOP_REASON_LABEL[decision.reason] || decision.reason) : "ready"}
          </Badge>
          <Badge tone="neutral" icon={Timer}>{describeSchedule(effective)}</Badge>
          <Badge tone="neutral" icon={payerIsOwn ? Wallet : Zap}>paying: {walletLabel}</Badge>
        </span>
      </div>

      <div className="p-4">
        {/* --- the schedule --- */}
        <div className="grid gap-4 sm:grid-cols-[9rem_9rem_1fr_auto] sm:items-end">
          <Field label="Every (seconds)" hint="2–600">
            <input
              className="input" type="number" min={2} max={600} step={1}
              value={schedule.intervalSec} disabled={running}
              onChange={(e) => onSchedule({ intervalSec: e.target.value })}
            />
          </Field>
          <Field label="Max runs" hint="1–200">
            <input
              className="input" type="number" min={1} max={200} step={1}
              value={schedule.maxRuns} disabled={running}
              onChange={(e) => onSchedule({ maxRuns: e.target.value })}
            />
          </Field>
          <label className="flex cursor-pointer items-center gap-2.5 pb-2.5 text-[13.5px] text-muted">
            <input
              type="checkbox" checked={effective.stopOnRefusal} disabled={running}
              className="h-4 w-4 accent-[var(--color-btc)]"
              onChange={(e) => onSchedule({ stopOnRefusal: e.target.checked })}
            />
            stop as soon as policy refuses
          </label>
          <div className="flex gap-2 pb-1">
            {running ? (
              <Button variant="danger" icon={Square} onClick={onStop}>Stop</Button>
            ) : (
              <Button variant="primary" icon={Play} onClick={onStart} disabled={busy !== null}>
                {runs.length ? "Run again" : "Start"}
              </Button>
            )}
            {runs.length > 0 && !running && <Button icon={RotateCcw} onClick={onReset}>Reset log</Button>}
          </div>
        </div>

        {/* --- what the budget will allow, before anything is signed --- */}
        {projection.available ? (
          <div className="mt-5 rounded-xl border border-line-soft bg-panel-2 p-4">
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-[12.5px] font-semibold tracking-[0.04em] text-dim uppercase">
                <Icon as={Gauge} size={14} />
                {payerIsOwn ? "your budget" : "demo agent's budget"}
              </span>
              <span className="tnum text-[13.5px] text-muted">
                {projection.dailyPct === null
                  ? "today's spend not read yet"
                  : `${projection.dailyPct.toFixed(1)}% of today's cap spent`}
              </span>
            </div>
            <Meter pct={projection.dailyPct ?? 0} live={running} label="share of today's spending cap used" height={10} />
            <p className="mt-2 text-[12.5px] text-dim">
              caps on-chain · spend summed from the treasury's own payment receipts
            </p>

            <Grid cols={5} className="mt-4 gap-4">
              <Stat icon={ReceiptText} label="This quote" value={fmtMusd(projection.quoteWei, 4)} unit="MUSD" />
              <Stat icon={Gauge} label="Per-call max" value={fmtMusd(projection.perCallMax, 2)} unit="MUSD" />
              <Stat
                icon={TrendingUp}
                label="Spent today"
                value={projection.spendKnown ? fmtMusd(projection.spentToday, 4) : "—"}
                unit={projection.spendKnown ? "MUSD" : ""}
              />
              <Stat
                icon={Wallet}
                label="Left today"
                value={projection.spendKnown ? fmtMusd(projection.leftToday, 4) : "—"}
                unit={projection.spendKnown ? "MUSD" : ""}
              />
              <Stat
                icon={Repeat}
                label="Runs until refused"
                tone={projection.runsLeft === 0n ? "bad" : null}
                value={projection.runsLeft === null ? "—" : String(projection.runsLeft)}
                hint={projection.runsLeft === null
                  ? (projection.spendKnown ? "quote the endpoint first" : "read after a quote")
                  : `then ${projection.binding}`}
              />
            </Grid>

            {!projection.spendKnown ? (
              <Note className="mt-4" icon={CircleHelp}>
                Today's spend has not been read yet. It comes from the gateway's policy check — which sums the treasury's
                on-chain payment receipts — so <b>quote the endpoint</b> and the projection fills in. The caps above are
                read straight from the contract either way.
              </Note>
            ) : projection.nextRefusal ? (
              <Note tone="bad" className="mt-4" icon={Ban} title={`Run #${projection.nextRefusal.onRun} will be refused`}>
                <span className="code">{projection.nextRefusal.code}</span>{" "}
                ({REASON_LABEL[projection.nextRefusal.code] || projection.nextRefusal.code}). The gateway checks the quote
                against these caps before anything is signed, so no MUSD moves — and the refusal itself is written on chain.
              </Note>
            ) : projection.capHitsOnRun && projection.quoteWei > 0n ? (
              <Note className="mt-4" icon={Timer}>
                At {fmtMusd(projection.quoteWei, 4)} MUSD a run, runs {runs.length + 1}–{projection.capHitsOnRun - 1} settle
                and <b>run #{projection.capHitsOnRun} is refused</b> by{" "}
                <span className="code">{projection.binding}</span>
                {REASON_LABEL[projection.binding] ? ` (${REASON_LABEL[projection.binding]})` : ""}.
                {!payerIsOwn && <> Lower the daily cap on <Link to="/operate" className="text-info hover:underline">Operate</Link> to
                watch it happen inside a minute.</>}
              </Note>
            ) : null}

            <p className="mt-3.5 border-t border-line-soft pt-3 text-[13px] leading-relaxed text-dim">
              The contract also keeps a funding counter — {fmtMusd(projection.fundingHeadroomToday, 4)} MUSD of float the
              treasury may still release to this wallet today. That is a different budget from the one above: payments are
              bounded by what has been <b className="text-muted">spent</b>, not by what was released.
            </p>
          </div>
        ) : (
          <Note tone="warn" className="mt-5" icon={CircleAlert} title="No on-chain budget to project against">
            This wallet is not registered, so runs would be refused for <span className="code">not_registered</span>{" "}
            rather than for a cap. Claim float from the faucet first.
          </Note>
        )}

        {/* --- the honest caveat about signing every run --- */}
        {payerIsOwn && (
          <Note className="mt-4" icon={PenLine} title="Your wallet signs every run">
            Expect a prompt each time. That is not friction to design away: an agent that can move funds repeatedly
            without the key holder is the thing this product refuses to be. For an unattended demonstration, switch to the
            gateway's demo agent — it signs server-side and the same on-chain caps apply to it.
            <div className="mt-3">
              <Button size="sm" icon={Zap} onClick={onUseDemoAgent}>Use the demo agent for this loop</Button>
            </div>
          </Note>
        )}

        {/* --- what actually happened --- */}
        {runs.length === 0 ? (
          <div className="mt-5 rounded-xl border border-dashed border-line bg-panel-2/30 px-4 py-8 text-center">
            <span className="mx-auto grid h-11 w-11 place-items-center rounded-full border border-line bg-ink-dim text-dim">
              <Icon as={Repeat} size={18} />
            </span>
            <p className="mx-auto mt-3 max-w-md text-[14px] leading-relaxed text-muted">
              No runs yet. Start the loop and each purchase appears here with what it moved, what the gateway decided, and
              the transaction that proves it.
            </p>
          </div>
        ) : (
          <div className="mt-5">
            {/* totals first: this is the number a judge wants before the rows */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-soft bg-panel-2 px-4 py-3">
              <span className="flex items-center gap-2 text-[12.5px] font-semibold tracking-[0.04em] text-dim uppercase">
                <Icon as={ReceiptText} size={14} /> run log
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Icon as={CircleCheck} size={13} className="text-ok" /> {summary.settled} settled
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Icon as={Ban} size={13} className="text-bad" /> {summary.refused} refused
                </span>
                {summary.charged ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon as={CircleAlert} size={13} className="text-warn" /> {summary.charged} no delivery
                  </span>
                ) : null}
                {summary.failed ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon as={X} size={13} className="text-bad" /> {summary.failed} failed
                  </span>
                ) : null}
                <span className="tnum border-l border-line pl-3 font-semibold text-text">
                  {fmtMusd(summary.movedWei, 4)} MUSD moved
                </span>
                <span className="tnum text-dim">of {fmtMusd(summary.attemptedWei, 4)} attempted</span>
              </span>
            </div>
            <Table head={[
              { label: "#" },
              { label: "Outcome" },
              { label: "Moved", align: "right" },
              { label: "Why" },
              { label: "Proof" },
            ]}>
              {runs.map((r) => (
                <tr key={r.index} className="transition-colors hover:bg-panel-2/50">
                  <td className="td tnum font-mono text-dim">{r.index}</td>
                  <td className="td whitespace-nowrap">
                    <Badge tone={OUTCOME_TONE[r.outcome] || "neutral"} icon={OUTCOME_ICON[r.outcome]}>
                      {OUTCOME_LABEL[r.outcome] || r.outcome}
                    </Badge>
                    {r.ms != null && <span className="ml-2 text-[12px] text-dim">{r.ms}ms</span>}
                  </td>
                  <td className="td tnum whitespace-nowrap text-right font-mono text-[14px]">
                    {fmtMusd(r.movedWei, 4)}
                    {r.attemptedWei !== null && r.movedWei !== r.attemptedWei && (
                      <span className="ml-1.5 text-[12px] text-dim">/ {fmtMusd(r.attemptedWei, 4)}</span>
                    )}
                  </td>
                  <td className="td max-w-[26rem] text-[13.5px] leading-snug text-muted">
                    {r.codes.length ? (
                      <>
                        <span className="code text-bad">{r.codes.join(", ")}</span>{" "}
                        {r.detail || r.codes.map((c) => REASON_LABEL[c]).filter(Boolean).join(" · ")}
                      </>
                    ) : r.error || r.detail || (r.outcome === OUTCOME.settled ? `HTTP ${r.status}` : "—")}
                  </td>
                  <td className="td whitespace-nowrap">
                    {r.tx ? <TxLink hash={r.tx} /> : r.denialTx ? <TxLink hash={r.denialTx} /> : <span className="text-dim">—</span>}
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        )}

        {/* --- why it stopped, and what to do about it --- */}
        {halted && (
          <Note
            tone={decision.reason === "halted_by_policy" ? "warn" : "bad"}
            className="mt-4"
            icon={decision.reason === "halted_by_policy" ? ShieldCheck : CircleAlert}
            title={STOP_REASON_LABEL[decision.reason] || decision.reason}
          >
            {decision.codes?.length ? (
              <> Rule: <span className="code">{decision.codes.join(", ")}</span>
                {decision.codes.map((c) => REASON_LABEL[c]).filter(Boolean).join(" · ") && (
                  <> ({decision.codes.map((c) => REASON_LABEL[c]).filter(Boolean).join(" · ")})</>
                )}.
              </>
            ) : null}
            {" "}The loop stopped itself — it does not retry a budget refusal, because retrying a policy that is working is
            how an agent drains a wallet.
            {decision.reason === "halted_by_policy" && (
              <> The refusal was recorded on chain, so it sits on the ledger next to the payments.</>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Link to="/operate"><Button size="sm" variant="ghost" className="border border-line-soft" iconRight={ArrowRight}>Change these caps</Button></Link>
              <Link to="/ledger"><Button size="sm" variant="ghost" className="border border-line-soft" iconRight={ArrowRight}>See it on the ledger</Button></Link>
              <Button size="sm" icon={RotateCcw} onClick={onReset}>Reset log</Button>
            </div>
          </Note>
        )}

        {/* --- the newest run in full, including what was bought --- */}
        {result && (
          <div className="mt-5 border-t border-line-soft pt-2">
            <div className="mt-3 mb-1 flex items-center gap-2 text-[11.5px] font-semibold tracking-[0.06em] text-dim uppercase">
              <Icon as={ReceiptText} size={13} /> latest run in full
            </div>
            <ResultView result={result} onEnable={onEnable} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The demonstration recipe.
//
// A judge has about three minutes and no idea what the caps are set to. This card
// is the answer to "how do I see the budget actually stop something?": the exact
// numbers to set, the exact quote to take, and the exact run that will be refused.
//
// The numbers are not invented for the copy — they are the same scenario pinned in
// scripts/test-autopay.mjs (0.002 per call, 0.005 daily, 0.001 a run → five
// settle, the sixth is refused), so what the page promises is what the tests assert
// and what the live end-to-end run in server/e2e-autopay.mjs proves on chain.
//
// It updates as the user goes: once a quote exists the card says which run WILL be
// refused with the real numbers rather than the recipe's, so it is never stale
// advice sitting next to a live projection.
// ---------------------------------------------------------------------------

function DemoRecipe({ projection, quoteWei, payerIsOwn }) {
  const live = projection?.available && projection?.spendKnown && quoteWei != null;

  return (
    <Card
      icon={Timer}
      tone="btc"
      title="See the cap bite in a minute"
      sub="The shortest honest demonstration of budget enforcement."
      aside={<Badge tone="btc" icon={TrendingUp}>for judges</Badge>}
    >
      {live ? (
        <>
          <p className="text-[14px] leading-relaxed text-muted">
            At <b className="tnum text-text">{fmtMusd(quoteWei, 4)} MUSD</b> a run against a{" "}
            <b className="tnum text-text">{fmtMusd(projection.dailyCap, 2)} MUSD</b> daily cap
            {projection.runsLeft !== null && (
              <>, <b className="tnum text-text">{String(projection.runsLeft)}</b> more run{projection.runsLeft === 1n ? "" : "s"} fit</>
            )}
            {projection.capHitsOnRun ? (
              <> — then <b className="text-bad">run #{projection.capHitsOnRun}</b> is refused by{" "}
                <span className="code">{projection.binding}</span>.</>
            ) : "."}
          </p>
          <Note tone="ok" className="mt-3.5" icon={CircleCheck}>
            Nothing here is staged. The refusal comes from the same policy check that runs on every payment, and the
            denial is written on chain beside the payments that succeeded.
          </Note>
        </>
      ) : (
        <ol className="space-y-3.5">
          {[
            {
              n: 1,
              title: "Lower the caps",
              body: <>Per-call max <b className="tnum text-text">0.002</b>, daily cap <b className="tnum text-text">0.005</b> MUSD. You sign it; the gateway applies it on chain inside a published ceiling.</>,
              to: "/operate",
              cta: "Set them",
            },
            {
              n: 2,
              title: "Quote a 0.001 MUSD endpoint",
              body: <>The built-in demo seller or Mezo's hosted one. Quoting is free and signs nothing.</>,
              to: null,
              cta: null,
            },
            {
              n: 3,
              title: "Choose “Run automatically”, then Start",
              body: <>Five runs settle and move exactly <b className="tnum text-text">0.005</b> MUSD. The panel predicts the refusal before it happens.</>,
              to: null,
              cta: null,
            },
            {
              n: 4,
              title: "Watch run #6 get refused",
              body: <>The gateway refuses it with <span className="code">daily_cap</span>, the loop stops itself, and the denial is recorded on chain — <b className="text-text">0 MUSD moved</b> on that run.</>,
              to: "/ledger",
              cta: "Then see it on the ledger",
            },
          ].map((s) => (
            <li key={s.n} className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-btc/40 bg-btc/10 text-[12px] font-semibold text-btc">
                {s.n}
              </span>
              <div className="min-w-0">
                <div className="text-[14px] leading-snug font-semibold text-text">{s.title}</div>
                <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{s.body}</p>
                {s.to && (
                  <div className="mt-2">
                    <Link to={s.to}>
                      <Button size="sm" variant="ghost" className="border border-line-soft" iconRight={ArrowRight}>{s.cta}</Button>
                    </Link>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-4 border-t border-line-soft pt-3.5 text-[13px] leading-relaxed text-dim">
        {payerIsOwn
          ? <>With your own wallet every run needs a signature, so use the demo agent for an unattended loop — the caps that bind it are on chain in exactly the same way.</>
          : <>The demo agent signs server-side, so the loop runs unattended. Its caps are on chain and enforced by the same policy check as yours.</>}
      </div>
    </Card>
  );
}

/**
 * A browser fetch that fails against a CORS-less seller surfaces as a bare
 * network error. Say what actually happened, and say which of the three paths
 * would work — "Failed to fetch" alone sends people to the wrong conclusion.
 */
function explainFetchError(e, { via, url }) {
  const msg = e?.message || String(e);
  if (/fetch|network|CORS|origin/i.test(msg) && via === "browser") {
    return (
      `${msg}\n\nThis is CORS: the seller sent no Access-Control-Allow-Origin, so the browser blocked the ` +
      `request. Your signature was never the problem.\n\nUse "Gateway relay" — you still sign in this browser, ` +
      `the gateway only carries the HTTP request — or switch to the gateway demo agent.`
    );
  }
  if (/fetch|network/i.test(msg) && via === "relay") {
    return `${msg}\n\nThe relay could not reach ${url}. The gateway applies its own SSRF guard, so internal and non-https addresses are refused by design.`;
  }
  if (/user (rejected|denied)|4001/i.test(msg)) {
    return `${msg}\n\nThe signature was declined in the wallet. Nothing was paid — click Pay again when ready.`;
  }
  return msg;
}
