// frontend/src/pages/earnpage.jsx

window.addEventListener("error", (e) => {
  if (e.message?.includes("M_ID")) {
    console.error("[M_ID CRASH]", e.filename, e.lineno, e.colno);
    debugger; // ← will pause execution right at the crash
  }
});

import React, { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle, ArrowRight, Check, CircleAlert, CircleCheck,
  CircleHelp, Coins, Gauge, Landmark, Lock, PlugZap, Plus, RefreshCw,
  ShieldCheck, TrendingDown, TrendingUp, Wallet, X, ArrowDownUp
} from "lucide-react";
import { useAppData } from "../lib/app-data.jsx";
import { useSession } from "../lib/session.jsx";
import {
  getTroveStatus, getBTCPrice, getMUSDBalance, getBTCBalance,
  openTrove, closeTrove, borrowMore,
} from "../lib/trove.js";
import {
  savingsStatus, savingsSweep, savingsWithdraw, savingsCollectFees,
} from "../lib/gateway.js";
import { MIN_NET_DEBT, MCR, CCR } from "../lib/mezo-contracts.js";
import {
  Badge, Button, Card, Dot, Field, Grid, Icon,
  Note, PageHeader, Stat, Shimmer,
} from "../components/ui.jsx";
import { short } from "../lib/chain.js";
import { formatEther } from "viem";

const MIN_BORROW = Number(formatEther(MIN_NET_DEBT));
const GAS_BUFFER_BTC = 0.0001;
const GAS_COMP = 200;          // MUSD, refunded from the GasPool on close
const BORROW_FEE = 0.001;      // 0.1% estimate; the contract's getBorrowingFee is the authority
const SAFE_RATIO = 200;        // target collateral ratio used by the "max safe" button

function crColor(pct) {
  if (pct >= 200) return "ok";
  if (pct >= 150) return "warn";
  if (pct >= 110) return "warn";
  return "bad";
}

function crHex(pct) {
  if (pct >= 200) return "var(--color-ok)";
  if (pct >= 150) return "var(--color-warn)";
  if (pct >= 110) return "var(--color-warn)";
  return "var(--color-bad)";
}

export default function EarnPage() {
  const { refresh: refreshApp } = useAppData();
  const session = useSession();
  const address = session.primaryAddress;
  const agentAddress = session.agentAddress;
  const connected = Boolean(session.user);

  // null = still loading (show shimmer); number = loaded (incl. real 0)
  const [trove, setTrove] = useState(null);
  const [btcPrice, setBtcPrice] = useState(null);
  const [btcBal, setBtcBal] = useState(null);
  const [musdBal, setMusdBal] = useState(null);
  const [agentMusd, setAgentMusd] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [priceError, setPriceError] = useState("");

  const [depositBTC, setDepositBTC] = useState("");
  const [savings, setSavings] = useState({
    assets: 0,
    shares: 0,
    idle: 0,
    accruedFees: 0,
    feeBps: 1500,
    apy: null,
    threshold: 50,
  });
  const [sweepAmt, setSweepAmt] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [vaultBusy, setVaultBusy] = useState(null); // "sweep" | "withdraw" | "collect"
  const [targetRatio, setTargetRatio] = useState(200);

  // borrow more (existing trove)
  const [addBtc, setAddBtc] = useState("");
  const [extraMusd, setExtraMusd] = useState("");

  async function getProvider() {
    if (!session.primaryWallet) throw new Error("No wallet connected");
    return session.primaryWallet.getEthereumProvider();
  }

  // All RPC + API calls in one parallel batch
  const refresh = useCallback(async () => {
    if (!address) return;
    setFetching(true);

    const promises = [
      getTroveStatus(address),                                                    // 0
      getBTCPrice(),                                                              // 1
      getBTCBalance(address),                                                     // 2
      getMUSDBalance(address),                                                    // 3
      agentAddress ? getMUSDBalance(agentAddress) : Promise.resolve(0),           // 4
      agentAddress                                                                // 5
        ? fetch(`/api/savings/status?agent=${agentAddress}`)
            .then((r) => r.json())
            .catch(() => null)
        : Promise.resolve(null),
    ];

    const [troveRes, priceRes, bbRes, mbRes, agentMbRes, savingsRes] =
      await Promise.allSettled(promises);

    if (troveRes.status === "fulfilled") setTrove(troveRes.value);
    else console.warn("getTroveStatus failed:", troveRes.reason);

    if (priceRes.status === "fulfilled") {
      setBtcPrice(priceRes.value);
      setPriceError(
        priceRes.value > 0
          ? ""
          : "Price feed returned 0 — check PRICE_FEED_ADDRESS / ABI"
      );
    } else {
      console.warn("getBTCPrice failed:", priceRes.reason);
      setPriceError(
        String(priceRes.reason?.message || priceRes.reason || "Price feed failed")
      );
      setBtcPrice(0); // hard failure → show 0, stop shimmering
    }

    if (bbRes.status === "fulfilled") setBtcBal(bbRes.value);
    else console.warn("getBTCBalance failed:", bbRes.reason);

    if (mbRes.status === "fulfilled") setMusdBal(mbRes.value);
    else console.warn("getMUSDBalance failed:", mbRes.reason);

    if (agentMbRes.status === "fulfilled") setAgentMusd(agentMbRes.value);
    else console.warn("agent MUSD balance failed:", agentMbRes.reason);

    if (savingsRes.status === "fulfilled" && savingsRes.value?.ok) {
      const s = savingsRes.value.savings || savingsRes.value;
      setSavings({
        assets: Number(s.assets ?? s.smusdAssets ?? 0),
        shares: Number(s.shares ?? 0),
        idle: Number(s.idle ?? s.idleMusd ?? (agentMbRes.status === "fulfilled" ? agentMbRes.value : 0)),
        accruedFees: Number(s.accruedFees ?? s.protocolFees ?? 0),
        feeBps: Number(s.feeBps ?? 1500),
        apy: s.apy ?? s.apyPct ?? null,
        threshold: Number(s.threshold ?? s.sweepThreshold ?? 50),
      });
    }
    setFetching(false);
  }, [address, agentAddress]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Numeric fallbacks for math / guards (null → 0 so derived calcs don't NaN)
  const btcBalN    = btcBal    ?? 0;
  const musdBalN   = musdBal   ?? 0;
  const agentMusdN = agentMusd ?? 0;
  const btcPriceN  = btcPrice  ?? 0;

  // --- derived: open trove ---
  const maxBTC = Math.max(0, btcBalN - GAS_BUFFER_BTC);
  const estColl = parseFloat(depositBTC) || 0;
  const collateralValueUSD = estColl * btcPriceN;
  const totalDebtAtRatio =
    targetRatio > 0 && collateralValueUSD > 0
      ? collateralValueUSD / (targetRatio / 100)
      : 0;
  // total debt = requested + fee + 200 gas comp, so requested = (total - 200) / (1 + fee)
  const netMusdReceived = Math.max(0, (totalDebtAtRatio - GAS_COMP) / (1 + BORROW_FEE));
  const estICR = targetRatio;

  const liquidationPrice =
    estColl > 0 && totalDebtAtRatio > 0
      ? (totalDebtAtRatio * Number(MCR) / 100) / estColl
      : 0;
  const liquidationBuffer =
    btcPriceN > 0 && liquidationPrice > 0
      ? ((btcPriceN - liquidationPrice) / btcPriceN) * 100
      : 0;

  const minBtcNeeded =
    btcPriceN > 0
      ? ((MIN_BORROW * (1 + BORROW_FEE) + GAS_COMP) * (targetRatio / 100)) / btcPriceN
      : 0;

  // --- derived: repay / close ---
  const troveDebt = trove?.debt ?? 0;
  const troveColl = trove?.coll ?? 0;
  // The 200 MUSD gas compensation is refunded, so the wallet only needs debt - 200.
  const repayNeeded = Math.max(0, troveDebt - GAS_COMP);
  const canClose = Boolean(trove?.active) && troveDebt > 0 && musdBalN >= repayNeeded;
  const closeShortfall = Math.max(0, repayNeeded - musdBalN);

  // --- derived: borrow more ---
  const addBtcN = parseFloat(addBtc) || 0;
  const extraN = parseFloat(extraMusd) || 0;
  const newCollN = troveColl + addBtcN;
  const newDebtN = troveDebt + extraN * (1 + BORROW_FEE);
  const newICRpct =
    newDebtN > 0 && btcPriceN > 0 ? ((newCollN * btcPriceN) / newDebtN) * 100 : 0;
  const newLiqPrice = newCollN > 0 ? (newDebtN * Number(MCR) / 100) / newCollN : 0;
  const newLiqBuffer =
    btcPriceN > 0 && newLiqPrice > 0 ? ((btcPriceN - newLiqPrice) / btcPriceN) * 100 : 0;
  // Most MUSD that can be borrowed while staying at SAFE_RATIO, given the BTC being added.
  const maxExtraMusd =
    btcPriceN > 0
      ? Math.max(
          0,
          Math.floor(((newCollN * btcPriceN) / (SAFE_RATIO / 100) - troveDebt) / (1 + BORROW_FEE))
        )
      : 0;
  const borrowMoreInvalid =
    (addBtcN <= 0 && extraN <= 0) ||
    addBtcN > maxBTC ||
    !btcPriceN ||
    newICRpct < Number(MCR);

  // First-load gate: disable actions until we have real numbers
  const balancesReady = btcBal != null && musdBal != null && btcPrice != null;

  // --- handlers ---
  // No optimistic balance updates: a number is only shown once the chain says so.
  // refresh() runs in `finally`, so even a timeout or revert re-reads real state.
  async function handleOpenTrove() {
    setError("");
    setSuccess("");
    if (!btcPriceN) return setError("BTC price unavailable — cannot open trove safely");
    if (!depositBTC || parseFloat(depositBTC) <= 0) return setError("Enter a BTC amount to deposit");
    if (netMusdReceived < MIN_BORROW) {
      return setError(
        `Minimum borrow is ${MIN_BORROW} MUSD — need ~${minBtcNeeded.toFixed(4)} BTC at ${targetRatio}% (you have ${btcBalN.toFixed(4)})`
      );
    }
    if (estICR < Number(MCR)) return setError("Safety ratio too low (min 110%)");
    if (estColl > btcBalN) return setError("Insufficient BTC balance");

    setLoading(true);
    try {
      const provider = await getProvider();
      await openTrove(provider, address, depositBTC, String(Math.floor(netMusdReceived)));
      setSuccess(`Trove opened — borrowed ${Math.floor(netMusdReceived)} MUSD. Fund your agent below.`);
      setDepositBTC("");
    } catch (e) {
      setError(e.shortMessage || e.message || "Failed to open trove");
    } finally {
      setLoading(false);
      refresh();
      refreshApp();
    }
  }

  async function handleBorrowMore() {
    setError("");
    setSuccess("");
    if (!trove?.active) return setError("No active trove to add to");
    if (!btcPriceN) return setError("BTC price unavailable — cannot adjust trove safely");
    if (addBtcN <= 0 && extraN <= 0) return setError("Enter BTC to add, MUSD to borrow, or both");
    if (addBtcN > maxBTC) return setError("Insufficient BTC balance (keeping a little for gas)");
    if (newICRpct < Number(MCR)) {
      return setError(`That would put the trove at ${newICRpct.toFixed(0)}%, below the ${MCR}% minimum`);
    }

    setLoading(true);
    try {
      const provider = await getProvider();
      await borrowMore(provider, address, addBtc || "0", extraMusd || "0");
      const parts = [];
      if (addBtcN > 0) parts.push(`added ${addBtc} BTC`);
      if (extraN > 0) parts.push(`borrowed ${extraMusd} MUSD`);
      setSuccess(`Trove updated: ${parts.join(" and ")}.`);
      setAddBtc("");
      setExtraMusd("");
    } catch (e) {
      setError(e.shortMessage || e.message || "Failed to adjust trove");
    } finally {
      setLoading(false);
      refresh();
      refreshApp();
    }
  }

  async function handleCloseTrove() {
    setError("");
    setSuccess("");
    if (!canClose) {
      return setError(
        closeShortfall > 0
          ? `Need ${closeShortfall.toFixed(2)} more MUSD to close (need ${repayNeeded.toFixed(2)}, you have ${musdBalN.toFixed(2)})`
          : "Cannot close trove"
      );
    }
    setLoading(true);
    try {
      const provider = await getProvider();
      await closeTrove(provider, address);
      setSuccess(`Trove closed — ${troveColl.toFixed(6)} BTC returned to your wallet.`);
    } catch (e) {
      setError(e.shortMessage || e.message || "Failed to close trove");
    } finally {
      setLoading(false);
      refresh();
      refreshApp();
    }
  }


  async function handleSweep() {
    setError(""); setSuccess(""); setVaultBusy("sweep");
    try {
      const r = await savingsSweep({
        agent: agentAddress,
        amount: sweepAmt || undefined,
      });
      if (!r.ok) throw new Error(r.error || "Sweep failed");
      setSuccess(`Swept idle MUSD → sMUSD${r.txHash ? ` · ${r.txHash.slice(0, 10)}…` : ""}`);
      setSweepAmt("");
    } catch (e) {
      setError(e.message || "Sweep failed");
    } finally {
      setVaultBusy(null);
      refresh();
      refreshApp();
    }
  }

  async function handleWithdraw() {
    setError(""); setSuccess(""); setVaultBusy("withdraw");
    try {
      const r = await savingsWithdraw({
        agent: agentAddress,
        amount: withdrawAmt || undefined,
      });
      if (!r.ok) throw new Error(r.error || "Retrieve failed");
      setSuccess(`Retrieved MUSD from sMUSD (JIT)${r.txHash ? ` · ${r.txHash.slice(0, 10)}…` : ""}`);
      setWithdrawAmt("");
    } catch (e) {
      setError(e.message || "Retrieve failed");
    } finally {
      setVaultBusy(null);
      refresh();
      refreshApp();
    }
  }

  async function handleCollectFees() {
    setError(""); setSuccess(""); setVaultBusy("collect");
    try {
      const r = await savingsCollectFees();
      if (!r.ok) throw new Error(r.error || "Fee collection failed");
      setSuccess(`Collected protocol performance fees${r.txHash ? ` · ${r.txHash.slice(0, 10)}…` : ""}`);
    } catch (e) {
      setError(e.message || "Fee collection failed");
    } finally {
      setVaultBusy(null);
      refresh();
      refreshApp();
    }
  }

  // --- guards ---
  if (!connected) {
    return (
      <div className="animate-fade space-y-6 pb-12">
        <PageHeader
          icon={Coins}
          eyebrow="fund your agent"
          title="Earn"
          sub="Deposit BTC collateral, borrow MUSD, and send it to your agent wallet so it can pay for services via x402."
        />
        <Card icon={Wallet} tone="warn" title="Connect your wallet">
          <Note tone="warn" icon={AlertTriangle}>
            Sign in from the navbar to deposit BTC and borrow MUSD. Your agent
            wallet is created automatically on first sign-in.
          </Note>
        </Card>
      </div>
    );
  }

  if (!agentAddress) {
    return (
      <div className="animate-fade space-y-6 pb-12">
        <PageHeader
          icon={Coins}
          eyebrow="fund your agent"
          title="Earn"
          sub="Deposit BTC collateral, borrow MUSD, and send it to your agent wallet so it can pay for services via x402."
        />
        <Card icon={RefreshCw} tone="info" title="Creating your agent wallet…">
          <Note icon={RefreshCw}>
            AgentFloat is generating a server-side EOA tied to your connected
            wallet. This takes a few seconds on first sign-in.
          </Note>
        </Card>
      </div>
    );
  }

  return (
    <div className="animate-fade space-y-6 pb-12">
      <PageHeader
        icon={Coins}
        eyebrow="Mezo BorrowerOperations"
        title="Earn"
        sub="Deposit BTC → borrow MUSD → fund your agent. Repay anytime to retrieve your collateral."
        aside={
          <>
            <Badge tone="btc" icon={Wallet}>
              <Dot tone="btc" />
              {short(address, 4)}
            </Badge>
            <Badge tone="info" icon={Landmark}>
              agent: {short(agentAddress, 4)}
            </Badge>
            <Badge
              tone={btcPrice == null ? "neutral" : btcPrice > 0 ? "ok" : "bad"}
              icon={TrendingUp}
            >
              {btcPrice == null ? (
                <Shimmer width="4.5rem" height="0.9rem" />
              ) : (
                <>BTC ${btcPrice > 0 ? btcPrice.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}</>
              )}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              icon={RefreshCw}
              onClick={refresh}
              busy={fetching}
              className="border border-line-soft"
              title="Refresh balances"
            />
          </>
        }
      />

      {error && (
        <Note tone="bad" icon={CircleAlert} title="Something went wrong">{error}</Note>
      )}
      {success && (
        <Note tone="ok" icon={CircleCheck} title="Success">{success}</Note>
      )}
      {priceError && (
        <Note tone="bad" icon={AlertTriangle} title="BTC price feed unavailable">
          {priceError}. Open-trove calculations need a live price. Check the browser
          console for <span className="font-mono">[getBTCPrice]</span> and verify{" "}
          <span className="font-mono">PRICE_FEED_ADDRESS</span> in mezo-contracts.js.
        </Note>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[1.5fr_1fr]">
        {/* ──── LEFT ──── */}
        <div className="space-y-6">

          {/* Trove status */}
          <Card
            icon={Landmark}
            tone={trove?.active ? "ok" : "neutral"}
            title="Trove Status"
            sub="Your BTC collateral and MUSD debt on Mezo's BorrowerOperations."
            aside={
              trove == null ? (
                <Badge tone="neutral"><Shimmer width="3.5rem" height="0.85rem" /></Badge>
              ) : trove.active ? (
                <Badge tone="ok" icon={CircleCheck}><Dot tone="ok" /> active</Badge>
              ) : (
                <Badge tone="neutral" icon={Lock}>no trove</Badge>
              )
            }
          >
            {trove == null ? (
              <Grid cols={2} className="gap-5 sm:grid-cols-4">
                <Stat icon={Coins} label="Collateral" loading />
                <Stat icon={TrendingUp} label="Debt" loading />
                <Stat icon={Gauge} label="Collateral Ratio" loading />
                <Stat icon={TrendingUp} label="BTC Price" loading />
              </Grid>
            ) : trove.active ? (
              <>
                <Grid cols={2} className="gap-5 sm:grid-cols-4">
                  <Stat icon={Coins} label="Collateral" value={trove.coll.toFixed(6)} unit="BTC" />
                  <Stat icon={TrendingUp} label="Debt" value={trove.debt.toFixed(2)} unit="MUSD" />
                  <Stat icon={Gauge} label="Collateral Ratio" value={`${trove.icrPct}%`} tone={crColor(trove.icrPct)} />
                  <Stat
                    icon={TrendingUp}
                    label="BTC Price"
                    value={btcPrice == null ? null : btcPrice > 0 ? `$${btcPrice.toLocaleString()}` : "—"}
                    loading={btcPrice == null}
                  />
                </Grid>

                {trove.icrPct < Number(CCR) && trove.icrPct >= Number(MCR) && (
                  <Note tone="warn" className="mt-4" icon={AlertTriangle} title="Recovery mode risk">
                    Your collateral ratio ({trove.icrPct}%) is below the CCR ({CCR}%).
                    Add more BTC or repay some MUSD to stay safe.
                  </Note>
                )}
              </>
            ) : (
              <Note icon={CircleHelp}>
                No active trove. Open one below to borrow MUSD against your BTC.
              </Note>
            )}
          </Card>

          {/* ── Open Trove (only when no active trove) ── */}
          {trove != null && !trove.active && (
            <Card
              icon={Landmark}
              tone="btc"
              title="Open Trove — Borrow MUSD"
              sub="Deposit BTC as collateral. MUSD amount is auto-calculated from your deposit and safety ratio."
              aside={
                <Badge tone="neutral" icon={Coins}>
                  {btcBal == null ? (
                    <Shimmer width="7rem" height="0.9rem" />
                  ) : (
                    <>
                      BTC: {btcBal.toFixed(6)} ·{" "}
                      {btcPriceN > 0
                        ? `~$${(btcBal * btcPriceN).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                        : "~$—"}
                    </>
                  )}
                </Badge>
              }
            >
              <Field
                label="BTC to deposit"
                hint={
                  btcBal == null
                    ? "Loading wallet balance…"
                    : `Wallet: ${btcBal.toFixed(6)} BTC · ${
                        btcPriceN > 0
                          ? `~$${(btcBal * btcPriceN).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                          : "price unavailable"
                      }`
                }
              >
                <div className="flex gap-2.5">
                  <input
                    className="input flex-1"
                    type="number"
                    step="0.0001"
                    min="0"
                    max={maxBTC}
                    value={depositBTC}
                    onChange={(e) => { setDepositBTC(e.target.value); setError(""); }}
                    placeholder="0.1"
                    disabled={!balancesReady}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 border border-line-soft"
                    onClick={() => { setDepositBTC(maxBTC.toFixed(6)); setError(""); }}
                    disabled={!balancesReady || maxBTC <= 0}
                    title={`Use all BTC minus ${GAS_BUFFER_BTC} for gas`}
                  >
                    MAX
                  </Button>
                </div>
              </Field>

              {estColl > 0 && (
                <div className="mt-5">
                  <div className="mb-2 flex items-baseline justify-between gap-2">
                    <label className="text-[12.5px] font-semibold uppercase tracking-[0.06em] text-dim">
                      Safety ratio
                    </label>
                    <span className="tnum text-[20px] font-semibold" style={{ color: crHex(targetRatio) }}>
                      {targetRatio}%
                    </span>
                  </div>

                  <input
                    type="range"
                    min={Number(MCR)}
                    max={500}
                    step={5}
                    value={targetRatio}
                    onChange={(e) => setTargetRatio(Number(e.target.value))}
                    className="w-full accent-[var(--color-btc)]"
                    style={{
                      background: `linear-gradient(to right,
                        var(--color-bad) 0%,
                        var(--color-bad) ${((150 - Number(MCR)) / (500 - Number(MCR))) * 100}%,
                        var(--color-warn) ${((150 - Number(MCR)) / (500 - Number(MCR))) * 100}%,
                        var(--color-warn) ${((200 - Number(MCR)) / (500 - Number(MCR))) * 100}%,
                        var(--color-ok) ${((200 - Number(MCR)) / (500 - Number(MCR))) * 100}%,
                        var(--color-ok) 100%)`,
                    }}
                  />

                  <div className="mt-1 flex justify-between text-[11px] text-dim">
                    <span className="text-bad">{MCR}% MCR</span>
                    <span className="text-warn">{CCR}% CCR</span>
                    <span className="text-ok">200% safe</span>
                    <span>500%</span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {[150, 200, 300, 500].map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setTargetRatio(r)}
                        className={`rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                          targetRatio === r
                            ? "border-btc/50 bg-btc/10 text-btc"
                            : "border-line-soft bg-ink-dim text-dim hover:border-faint hover:text-muted"
                        }`}
                      >
                        {r}%
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {estColl > 0 && (
                <div className="mt-5 rounded-xl border border-line-soft bg-ink-dim p-4">
                  <div className="mb-3 flex items-baseline justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-dim">You will receive</span>
                    <span className="tnum text-[28px] font-semibold text-text">
                      {btcPrice == null ? (
                        <Shimmer width="6rem" height="1.75rem" />
                      ) : (
                        <>
                          {netMusdReceived.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          <span className="ml-2 text-[16px] font-medium text-muted">MUSD</span>
                        </>
                      )}
                    </span>
                  </div>

                  <dl className="dl text-[13px]">
                    <dt>BTC price</dt>
                    <dd>
                      {btcPrice == null ? (
                        <Shimmer width="4rem" height="0.85rem" />
                      ) : btcPrice > 0 ? (
                        `$${btcPrice.toLocaleString()}`
                      ) : (
                        "unavailable"
                      )}
                    </dd>
                    <dt>collateral value</dt>
                    <dd>
                      {btcPrice == null ? (
                        <Shimmer width="4rem" height="0.85rem" />
                      ) : (
                        `$${collateralValueUSD.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                      )}
                    </dd>
                    <dt>total debt</dt>
                    <dd>{totalDebtAtRatio.toFixed(2)} MUSD</dd>
                    <dt>— gas compensation</dt>
                    <dd className="text-dim">−200 MUSD (returned on close)</dd>
                    <dt>— borrowing fee (~0.1%)</dt>
                    <dd className="text-dim">−{(netMusdReceived * BORROW_FEE).toFixed(2)} MUSD</dd>
                    <dt>— you receive</dt>
                    <dd className="font-semibold">{netMusdReceived.toFixed(2)} MUSD</dd>
                    {btcPriceN > 0 && netMusdReceived < MIN_BORROW && (
                      <>
                        <dt className="text-warn">min BTC needed</dt>
                        <dd className="text-warn">~{minBtcNeeded.toFixed(4)} BTC at {targetRatio}%</dd>
                      </>
                    )}
                  </dl>

                  <div className="mt-4 border-t border-line-soft pt-4">
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-dim">
                        <Icon as={TrendingDown} size={13} className="text-warn" />
                        liquidation risk
                      </span>
                      <span className="tnum text-[13px] font-semibold" style={{ color: crHex(estICR) }}>
                        {liquidationBuffer.toFixed(1)}% buffer
                      </span>
                    </div>

                    <div className="rounded-lg bg-panel-2 p-3">
                      <div className="flex items-center justify-between text-[13px]">
                        <span className="text-muted">BTC can fall to</span>
                        <span className="tnum font-mono font-semibold" style={{ color: crHex(estICR) }}>
                          ${liquidationPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[11.5px] text-dim">
                        <span>
                          current: $
                          {btcPrice == null
                            ? "…"
                            : btcPrice > 0
                            ? btcPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })
                            : "—"}
                        </span>
                        <span>
                          liquidated below $
                          {liquidationPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                    </div>

                    {estICR < Number(MCR) && (
                      <Note tone="bad" className="mt-3" icon={X}>
                        Below MCR ({MCR}%) — this trove would be immediately liquidated.
                      </Note>
                    )}
                    {estICR >= Number(MCR) && estICR < Number(CCR) && (
                      <Note tone="warn" className="mt-3" icon={AlertTriangle}>
                        Below CCR ({CCR}%) — recovery mode risk. Lower the ratio only if you accept the risk.
                      </Note>
                    )}
                    {estICR >= Number(CCR) && estICR < 200 && (
                      <Note tone="warn" className="mt-3" icon={AlertTriangle}>
                        Above CCR but tight. A {liquidationBuffer.toFixed(0)}% BTC drop liquidates.
                      </Note>
                    )}
                    {estICR >= 200 && btcPriceN > 0 && (
                      <Note tone="ok" className="mt-3" icon={ShieldCheck}>
                        Healthy safety margin. BTC would need to drop{" "}
                        <b>{liquidationBuffer.toFixed(0)}%</b> before liquidation.
                      </Note>
                    )}
                  </div>
                </div>
              )}

              <div className="mt-5">
                <Button
                  variant="primary"
                  icon={Landmark}
                  onClick={handleOpenTrove}
                  disabled={
                    loading ||
                    !balancesReady ||
                    !btcPriceN ||
                    !estColl ||
                    netMusdReceived < MIN_BORROW ||
                    estICR < Number(MCR)
                  }
                  busy={loading}
                >
                  {loading
                    ? "Opening…"
                    : btcPrice == null || btcBal == null
                    ? "Loading balances…"
                    : !btcPriceN
                    ? "Waiting for BTC price…"
                    : !estColl
                    ? "Enter BTC Amount to Deposit"
                    : netMusdReceived < MIN_BORROW
                    ? `Minimum borrow is ${MIN_BORROW} MUSD — deposit at least ~${minBtcNeeded.toFixed(4)} BTC`
                    : `Open Trove & Borrow ${Math.floor(netMusdReceived)} MUSD`}
                </Button>
                {btcPriceN > 0 && netMusdReceived < MIN_BORROW && estColl > 0 && (
                  <button
                    type="button"
                    onClick={() => setDepositBTC(minBtcNeeded.toFixed(4))}
                    className="mt-2 text-[12px] font-medium text-btc hover:underline"
                  >
                    ⚡ Click to auto-fill minimum deposit (~{minBtcNeeded.toFixed(4)} BTC)
                  </button>
                )}
              </div>

              <Note className="mt-4" icon={CircleHelp}>
                Calls Mezo&apos;s real <span className="font-mono">BorrowerOperations.openTrove()</span>.
                MCR {MCR}% · CCR {CCR}% · 200 MUSD gas comp (refunded on close).
                Tip: lower the safety ratio toward 150% to borrow more from the same BTC.
              </Note>
            </Card>
          )}

          {/* ── Borrow more (only when trove active) ── */}
          {trove?.active && (
            <Card
              icon={Plus}
              tone="btc"
              title="Add Collateral & Borrow More"
              sub="Deposit more BTC, borrow more MUSD, or both, on your existing trove in one transaction."
              aside={
                <Badge tone="neutral" icon={Coins}>
                  {btcBal == null ? (
                    <Shimmer width="7rem" height="0.9rem" />
                  ) : (
                    <>BTC: {btcBal.toFixed(6)}</>
                  )}
                </Badge>
              }
            >
              <Field
                label="Extra BTC collateral"
                hint={btcBal == null ? "Loading wallet balance…" : `Wallet: ${btcBal.toFixed(6)} BTC`}
              >
                <div className="flex gap-2.5">
                  <input
                    className="input flex-1"
                    type="number"
                    step="0.0001"
                    min="0"
                    value={addBtc}
                    onChange={(e) => { setAddBtc(e.target.value); setError(""); }}
                    placeholder="0.01"
                    disabled={!balancesReady}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 border border-line-soft"
                    onClick={() => { setAddBtc(maxBTC.toFixed(6)); setError(""); }}
                    disabled={!balancesReady || maxBTC <= 0}
                    title={`Use all BTC minus ${GAS_BUFFER_BTC} for gas`}
                  >
                    MAX
                  </Button>
                </div>
              </Field>

              <div className="mt-4">
                <Field
                  label="Extra MUSD to borrow"
                  hint={
                    btcPriceN > 0
                      ? `Up to ${maxExtraMusd.toLocaleString()} MUSD keeps you at ${SAFE_RATIO}%`
                      : "Waiting for BTC price…"
                  }
                >
                  <div className="flex gap-2.5">
                    <input
                      className="input flex-1"
                      type="number"
                      step="10"
                      min="0"
                      value={extraMusd}
                      onChange={(e) => { setExtraMusd(e.target.value); setError(""); }}
                      placeholder="500"
                      disabled={!balancesReady}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 border border-line-soft"
                      onClick={() => { setExtraMusd(String(maxExtraMusd)); setError(""); }}
                      disabled={!balancesReady || maxExtraMusd <= 0}
                      title={`Borrow the most that keeps the trove at ${SAFE_RATIO}%`}
                    >
                      MAX SAFE
                    </Button>
                  </div>
                </Field>
              </div>

              {(addBtcN > 0 || extraN > 0) && (
                <div className="mt-5 rounded-xl border border-line-soft bg-ink-dim p-4">
                  <dl className="dl text-[13px]">
                    <dt>collateral</dt>
                    <dd>{troveColl.toFixed(6)} → {newCollN.toFixed(6)} BTC</dd>
                    <dt>debt</dt>
                    <dd>{troveDebt.toFixed(2)} → {newDebtN.toFixed(2)} MUSD</dd>
                    <dt>borrowing fee (~0.1%)</dt>
                    <dd className="text-dim">{(extraN * BORROW_FEE).toFixed(2)} MUSD</dd>
                    <dt>MUSD you receive</dt>
                    <dd className="font-semibold">{extraN.toFixed(2)} MUSD</dd>
                    <dt>collateral ratio</dt>
                    <dd className="font-semibold" style={{ color: crHex(newICRpct) }}>
                      {trove.icrPct}% → {newICRpct.toFixed(0)}%
                    </dd>
                    <dt>liquidated below</dt>
                    <dd>${newLiqPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({newLiqBuffer.toFixed(0)}% buffer)</dd>
                  </dl>

                  {newICRpct < Number(MCR) && (
                    <Note tone="bad" className="mt-3" icon={X}>
                      Below MCR ({MCR}%) — Mezo will reject this. Add more BTC or borrow less.
                    </Note>
                  )}
                  {newICRpct >= Number(MCR) && newICRpct < Number(CCR) && (
                    <Note tone="warn" className="mt-3" icon={AlertTriangle}>
                      Below CCR ({CCR}%) — recovery mode risk.
                    </Note>
                  )}
                </div>
              )}

              <div className="mt-5">
                <Button
                  variant="primary"
                  icon={Plus}
                  onClick={handleBorrowMore}
                  disabled={loading || !balancesReady || borrowMoreInvalid}
                  busy={loading}
                >
                  {loading
                    ? "Submitting…"
                    : addBtcN <= 0 && extraN <= 0
                    ? "Enter BTC or MUSD amount"
                    : addBtcN > 0 && extraN > 0
                    ? `Add ${addBtc} BTC & Borrow ${extraMusd} MUSD`
                    : addBtcN > 0
                    ? `Add ${addBtc} BTC`
                    : `Borrow ${extraMusd} MUSD`}
                </Button>
              </div>

              <Note className="mt-4" icon={CircleHelp}>
                Calls <span className="font-mono">BorrowerOperations.adjustTrove()</span>. New MUSD is minted to your
                connected wallet. Extra debt also adds a ~0.1% fee, so borrowing more does not make closing
                easier. To close you still need your debt minus 200 MUSD in the wallet.
              </Note>
            </Card>
          )}

          {/* ── Repay & Retrieve (only when trove active) ── */}
          {trove?.active && (
            <Card
              icon={ArrowDownUp}
              tone="ok"
              title="Repay & Retrieve BTC"
              sub="Return borrowed MUSD to unlock your BTC collateral via BorrowerOperations.closeTrove()."
              aside={
                <Badge tone={canClose ? "ok" : "warn"} icon={canClose ? CircleCheck : AlertTriangle}>
                  <Dot tone={canClose ? "ok" : "warn"} />
                  {canClose ? "ready to close" : "need more MUSD"}
                </Badge>
              }
            >
              <Grid cols={2} className="gap-5 sm:grid-cols-3">
                <Stat icon={TrendingUp} label="Total Debt" value={troveDebt.toFixed(2)} unit="MUSD" />
                <Stat
                  icon={Wallet}
                  label="Your MUSD"
                  value={musdBal == null ? null : musdBal.toFixed(2)}
                  unit="MUSD"
                  tone={canClose ? "ok" : "warn"}
                  loading={musdBal == null}
                />
                <Stat icon={Coins} label="BTC returned" value={troveColl.toFixed(6)} unit="BTC" tone="ok" />
              </Grid>

              <div className="mt-5 rounded-xl border border-line-soft bg-ink-dim p-4">
                <dl className="dl text-[13px]">
                  <dt>total debt</dt>
                  <dd>{troveDebt.toFixed(2)} MUSD</dd>
                  <dt>gas comp refund</dt>
                  <dd className="text-ok">−200 MUSD (returned on close)</dd>
                  <dt>MUSD you must hold</dt>
                  <dd className="font-semibold">{repayNeeded.toFixed(2)} MUSD</dd>
                  <dt>MUSD in your wallet</dt>
                  <dd className={canClose ? "text-ok" : "text-warn"}>
                    {musdBal == null ? (
                      <Shimmer width="4rem" height="0.85rem" />
                    ) : (
                      `${musdBal.toFixed(2)} MUSD`
                    )}
                  </dd>
                  {closeShortfall > 0 && (
                    <>
                      <dt className="text-bad">shortfall</dt>
                      <dd className="text-bad font-semibold">{closeShortfall.toFixed(2)} MUSD</dd>
                    </>
                  )}
                  <dt>BTC returned</dt>
                  <dd className="font-semibold text-ok">{troveColl.toFixed(6)} BTC</dd>
                </dl>
              </div>

              {closeShortfall > 0 && (
                <Note tone="warn" className="mt-4" icon={AlertTriangle}>
                  You need <b>{closeShortfall.toFixed(2)} more MUSD</b> in your connected wallet to close.
                  Borrowing more will not close this gap, because each new MUSD adds the same amount of debt plus a fee.
                  Get MUSD from elsewhere, or pull MUSD back from your agent on the{" "}
                  <Link to="/operate" className="font-semibold underline">Operate page</Link>, then retry.
                  Interest keeps accruing, so leave a small buffer.
                </Note>
              )}

              <div className="mt-5">
                <Button
                  variant="primary"
                  icon={ArrowDownUp}
                  onClick={handleCloseTrove}
                  disabled={loading || !canClose || musdBal == null}
                  busy={loading}
                >
                  {loading
                    ? "Closing…"
                    : musdBal == null
                    ? "Loading balances…"
                    : canClose
                    ? `Repay ${repayNeeded.toFixed(0)} MUSD & Retrieve ${troveColl.toFixed(4)} BTC`
                    : `Need ${closeShortfall.toFixed(0)} more MUSD`}
                </Button>
              </div>

              <Note className="mt-4" icon={CircleHelp}>
                <span className="font-mono">closeTrove()</span> burns your MUSD debt and returns all BTC
                in one tx. The 200 MUSD gas compensation is refunded from the GasPool.
              </Note>
            </Card>
          )}

          {/* ── Agent funding lives on the Operate page ── */}
          <Card
            icon={PlugZap}
            tone="btc"
            title="Fund Your Agent"
            sub="Sending MUSD, sending BTC gas and pulling MUSD back from your agent all happen on the Operate page."
            aside={
              <Badge tone={agentMusd != null && agentMusd > 0 ? "ok" : "warn"} icon={Wallet}>
                <Dot tone={agentMusd != null && agentMusd > 0 ? "ok" : "warn"} />
                {agentMusd == null ? (
                  <Shimmer width="5rem" height="0.85rem" />
                ) : (
                  <>agent: {agentMusd.toFixed(2)} MUSD</>
                )}
              </Badge>
            }
          >
            <Grid cols={2} className="gap-5">
              <Stat
                icon={Wallet}
                label="Your MUSD"
                value={musdBal == null ? null : musdBal.toFixed(2)}
                unit="MUSD"
                loading={musdBal == null}
              />
              <Stat
                icon={PlugZap}
                label="Agent MUSD"
                value={agentMusd == null ? null : agentMusd.toFixed(2)}
                unit="MUSD"
                tone={agentMusd != null && agentMusd > 0 ? "ok" : "warn"}
                loading={agentMusd == null}
              />
            </Grid>
            <div className="mt-5">
              <Link to="/operate">
                <Button variant="primary" icon={PlugZap} iconRight={ArrowRight}>
                  Manage agent funds
                </Button>
              </Link>
            </div>
            <Note className="mt-4" icon={CircleHelp}>
              Agent wallet: <span className="font-mono text-text">{agentAddress}</span>.
              It signs x402 payments with its own key. The gateway enforces your daily budget cap independently.
            </Note>
          </Card>
        </div>

        {/* ──── RIGHT ──── */}
        <div className="space-y-6">
          <Card
            icon={ShieldCheck}
            tone="ok"
            title="Savings Vault (sMUSD)"
            sub="Idle agent MUSD sweeps into Mezo testnet sMUSD. Retrieve for JIT payments. Protocol takes a performance share on yield."
            aside={<Badge tone="ok" icon={Check}>Wave 2 yield</Badge>}
          >
            <Grid cols={2} className="gap-4">
              <Stat
                icon={Landmark}
                label="In vault"
                value={Number(savings.assets || 0).toFixed(2)}
                unit="sMUSD"
              />
              <Stat
                icon={Wallet}
                label="Agent liquid"
                value={agentMusd == null ? null : agentMusd.toFixed(2)}
                unit="MUSD"
                loading={agentMusd == null}
              />
              <Stat
                icon={TrendingUp}
                label="Accrued protocol fees"
                value={Number(savings.accruedFees || 0).toFixed(4)}
                unit="MUSD"
                tone="btc"
              />
              <Stat
                icon={Gauge}
                label="Performance share"
                value={`${((savings.feeBps || 1500) / 100).toFixed(0)}%`}
                unit="of yield"
              />
            </Grid>

            <dl className="dl mt-4 border-t border-line-soft pt-4 text-[13.5px]">
              <dt>vault</dt>
              <dd className="font-mono">0x6f46…8e16</dd>
              <dt>sweep threshold</dt>
              <dd>{savings.threshold ?? 50} MUSD</dd>
              <dt>auto interval</dt>
              <dd>every 5 min + JIT on pay</dd>
              {savings.apy != null && (
                <>
                  <dt>APY (testnet)</dt>
                  <dd>{savings.apy}</dd>
                </>
              )}
            </dl>

            {/* Manual controls for judges */}
            <div className="mt-4 space-y-3 border-t border-line-soft pt-4">
              <div className="text-[12.5px] font-semibold uppercase tracking-[0.06em] text-dim">
                Yield ops (demo)
              </div>

              <div className="flex gap-2">
                <input
                  className="input flex-1 text-[13px]"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Sweep amount (all idle if empty)"
                  value={sweepAmt}
                  onChange={(e) => setSweepAmt(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="primary"
                  icon={TrendingUp}
                  onClick={handleSweep}
                  busy={vaultBusy === "sweep"}
                  disabled={vaultBusy != null || !agentAddress}
                  className="shrink-0"
                >
                  Sweep
                </Button>
              </div>

              <div className="flex gap-2">
                <input
                  className="input flex-1 text-[13px]"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Retrieve amount (max if empty)"
                  value={withdrawAmt}
                  onChange={(e) => setWithdrawAmt(e.target.value)}
                />
                <Button
                  size="sm"
                  icon={ArrowDownUp}
                  onClick={handleWithdraw}
                  busy={vaultBusy === "withdraw"}
                  disabled={vaultBusy != null || !agentAddress}
                  className="shrink-0"
                >
                  Retrieve
                </Button>
              </div>

              <Button
                size="sm"
                variant="primary"
                className="w-full justify-center"
                icon={Coins}
                onClick={handleCollectFees}
                busy={vaultBusy === "collect"}
                disabled={vaultBusy != null || Number(savings.accruedFees || 0) <= 0}
              >
                Collect protocol fees ({Number(savings.accruedFees || 0).toFixed(4)} MUSD)
              </Button>
            </div>

            <Note className="mt-4" icon={CircleHelp}>
              <b>Monetization:</b> {(savings.feeBps || 1500) / 100}% performance share on sMUSD yield
              · ~0.05% x402 micro-fee on settle · hosted gateway SaaS. Idle float earns;
              liquidity auto-returns before spend.
            </Note>
          </Card>

          <Card icon={CircleHelp} title="The full lifecycle" sub="Borrow → spend → repay → retrieve on Mezo.">
            <ol className="space-y-3.5">
              {[
                { n: 1, title: "Deposit BTC", body: "Lock BTC as collateral via BorrowerOperations.openTrove()." },
                { n: 2, title: "Borrow MUSD", body: `Receive MUSD (min ${MIN_BORROW} net). MCR ${MCR}% · aim 200%+ CR.` },
                { n: 3, title: "Fund your agent", body: "Send MUSD to your agent wallet from the Operate page. It spends via x402." },
                { n: 4, title: "Repay & retrieve", body: "closeTrove() returns your BTC. Gas comp refunded." },
              ].map((s) => (
                <li key={s.n} className="flex gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-btc/40 bg-btc/10 text-[12px] font-semibold text-btc">
                    {s.n}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[14px] leading-snug font-semibold text-text">{s.title}</div>
                    <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line-soft pt-4">
              <Link to="/spend">
                <Button size="sm" variant="ghost" className="border border-line-soft" iconRight={ArrowRight}>
                  Spend with your agent
                </Button>
              </Link>
              <Link to="/dashboard">
                <Button size="sm" variant="ghost" className="border border-line-soft" iconRight={ArrowRight}>
                  View dashboard
                </Button>
              </Link>
            </div>
          </Card>

          <Card icon={Coins} title="Protocol details" sub="Mezo testnet — same contracts as production.">
            <dl className="dl">
              <dt>protocol</dt>
              <dd>Mezo BorrowerOperations</dd>
              <dt>collateral</dt>
              <dd>BTC (native)</dd>
              <dt>debt token</dt>
              <dd>MUSD · 18 decimals</dd>
              <dt>MCR</dt>
              <dd>{String(MCR)}%</dd>
              <dt>CCR</dt>
              <dd>{String(CCR)}%</dd>
              <dt>min net debt</dt>
              <dd>{MIN_BORROW} MUSD</dd>
              <dt>gas compensation</dt>
              <dd className="text-right">200 MUSD (refunded on close)</dd>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}


