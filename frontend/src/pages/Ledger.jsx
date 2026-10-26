// ---------------------------------------------------------------------------
// Ledger — payments and refusals, with "mine" front and centre.
//
// Two sources, ALWAYS labelled, because they are not equally trustworthy:
//   chain    written to the treasury contract, verifiable by anyone
//   gateway  held in the gateway process; shown when no funded signer exists
// Mixing them silently would overstate what is provable on chain.
//
// A payment row with no settlement tx is badged "unverified": it means no MUSD
// moved. Those rows predate the fix that stopped the gateway recording rejected
// settlements as payments. They are kept visible rather than filtered out — the
// ledger is append-only and has no delete function, by design.
//
// MINE VS ALL
//   Every user sees the same protocol-wide ledger, which is correct (it is
//   public on-chain data) but not useful on its own: a user with three payments
//   should not have to scan a table of everyone's. So the filter defaults to
//   their own agent wallet when they are signed in and have activity, and the
//   protocol-wide view is one click away. Rows belonging to the signed-in wallet
//   are badged "yours" in the all-view, so switching never feels like a
//   different dataset.
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Activity } from "lucide-react";
import { Link } from "react-router-dom";
import { useAppData } from "../lib/app-data.jsx";
import { useSession } from "../lib/session.jsx";
import { REASON_LABEL } from "../lib/agent-status.jsx";
import {
  AddressLink, Badge, Card, Dot, Empty, Note, PageHeader, Stat, Table, TxLink,
} from "../components/ui.jsx";
import { fmtMusd, timeAgo } from "../lib/chain.js";

/** Chain rows carry `timestamp` in seconds; gateway rows carry an ISO `at`. */
function tsOf(r) {
  if (r.timestamp) return Number(r.timestamp) * 1000;
  if (r.at) return new Date(r.at).getTime();
  return 0;
}

const sameAddr = (a, b) => Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();

export default function Ledger() {
  const { chainRecords, localRecords, loading } = useAppData();
  const session = useSession();
  const mine = session.agentAddress;

  const [tab, setTab] = useState("payments");
  const [scope, setScope] = useState("all"); // "mine" | "all"

  const payments = useMemo(() => {
    const chain = chainRecords?.payments || [];
    const local = (localRecords?.receipts || []).filter(
      (r) => !chain.some((c) => c.settlementTx && c.settlementTx === r.settlementTx)
    );
    return [...chain, ...local].sort((a, b) => tsOf(b) - tsOf(a));
  }, [chainRecords, localRecords]);

  const denials = useMemo(() => {
    const chain = chainRecords?.denials || [];
    const local = (localRecords?.denials || []).filter(
      (d) => !chain.some((c) => c.endpoint === d.endpoint && tsOf(c) === tsOf(d))
    );
    return [...chain, ...local].sort((a, b) => tsOf(b) - tsOf(a));
  }, [chainRecords, localRecords]);

  const myPayments = useMemo(
    () => (mine ? payments.filter((p) => sameAddr(p.agent, mine)) : []),
    [payments, mine]
  );
  const myDenials = useMemo(
    () => (mine ? denials.filter((d) => sameAddr(d.agent, mine)) : []),
    [denials, mine]
  );

  // Default to "mine" once a signed-in wallet actually has rows. Until then the
  // all-view is the only honest one — an empty personal ledger on first load
  // would look like a broken page rather than a new account.
  //
  // Once, though: the counts change when a payment lands, and yanking someone
  // back to "mine" after they deliberately opened the protocol-wide view would be
  // the UI making a decision for them.
  const autoScoped = useRef(false);
  useEffect(() => {
    if (autoScoped.current) return;
    if (mine && (myPayments.length || myDenials.length)) {
      autoScoped.current = true;
      setScope("mine");
    }
  }, [mine, myPayments.length, myDenials.length]);

  const shownPayments = scope === "mine" ? myPayments : payments;
  const shownDenials = scope === "mine" ? myDenials : denials;

  // Spend is counted only over rows that actually settled. Counting an
  // unverified row would overstate what was paid.
  const verified = shownPayments.filter((p) => p.settlementTx);
  const spent = verified.reduce((s, p) => s + BigInt(p.amount || 0), 0n);
  const phantom = shownPayments.length - verified.length;

  const showAgent = scope === "all";

  return (
    <div className="animate-fade space-y-6 pb-10">
      <PageHeader
        icon={Activity}
        eyebrow="audit"
        title="Ledger"
        sub={
          scope === "mine" && mine
            ? <>Payments and refusals for your agent wallet <AddressLink address={mine} chars={4} />.</>
            : "Every payment and every refusal across the protocol — labelled by whether the chain or the gateway recorded it."
        }
        aside={
          <Badge tone={chainRecords ? "ok" : "warn"}>
            <Dot tone={chainRecords ? "ok" : "warn"} />
            {chainRecords ? "chain read" : loading ? "reading chain" : "gateway only"}
          </Badge>
        }
      />

      {/* summary */}
      <div className="grid grid-cols-2 gap-4 rounded-xl border border-line-soft bg-ink-dim/50 p-4 sm:grid-cols-4">
        <Stat
          label={scope === "mine" ? "You settled" : "Settled (all wallets)"}
          value={loading ? "…" : fmtMusd(spent, 4)}
          unit="MUSD"
          hint={`${verified.length} verified row${verified.length === 1 ? "" : "s"}`}
        />
        <Stat label="Payments" value={shownPayments.length} hint={scope === "mine" ? "yours" : "protocol-wide"} />
        <Stat
          label="Refusals"
          value={shownDenials.length}
          hint={scope === "mine" ? "yours" : "protocol-wide"}
        />
        <Stat
          label="Unverified"
          value={phantom}
          hint={phantom ? "no settlement tx" : "every row settled"}
        />
      </div>

      <Card
        title="Records"
        aside={
          <span className="text-[12.5px] text-dim">
            {scope === "mine" ? "your wallet" : `${payments.length + denials.length} rows`} · newest first
          </span>
        }
        pad={false}
      >
        {/* controls: what to read, and whose */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-1">
            <TabButton active={tab === "payments"} onClick={() => setTab("payments")} count={shownPayments.length}>
              Payments
            </TabButton>
            <TabButton active={tab === "denials"} onClick={() => setTab("denials")} count={shownDenials.length}>
              Refused
            </TabButton>
          </div>
          <div className="flex items-center gap-1">
            <ScopeButton
              active={scope === "mine"}
              onClick={() => setScope("mine")}
              disabled={!mine}
              title={mine ? "Only your agent wallet" : "Sign in to filter by your own agent wallet"}
            >
              Mine
            </ScopeButton>
            <ScopeButton active={scope === "all"} onClick={() => setScope("all")}>All wallets</ScopeButton>
          </div>
        </div>

        {loading && !payments.length && !denials.length ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="animate-shimmer h-8 rounded bg-ink-dim" />
            ))}
            <p className="pt-1 text-[12.5px] text-dim">Reading the on-chain ledger…</p>
          </div>
        ) : tab === "payments" ? (
          shownPayments.length === 0 ? (
            <div className="p-5">
              <Empty>
                {scope === "mine" ? "No payments from your wallet yet." : "No payments yet."}{" "}
                Buy something on the{" "}
                <Link to="/spend" className="text-info underline decoration-line underline-offset-2 hover:decoration-info">
                  Spend
                </Link>{" "}
                page — the built-in demo seller costs 0.001 MUSD.
              </Empty>
            </div>
          ) : (
            <Table head={[
              { label: "When" },
              ...(showAgent ? [{ label: "Agent" }] : []),
              { label: "Endpoint" },
              { label: "Payee" },
              { label: "Amount", align: "right" },
              { label: "Settlement" },
              { label: "Source" },
            ]}>
              {shownPayments.map((p, i) => (
                <tr key={i} className="transition-colors hover:bg-panel-2/50">
                  <td className="td whitespace-nowrap text-dim">{timeAgo(p.timestamp || p.at)}</td>
                  {showAgent && (
                    <td className="td whitespace-nowrap">
                      <AddressLink address={p.agent} chars={4} />
                      {sameAddr(p.agent, mine) && <span className="ml-1.5"><Badge tone="btc">yours</Badge></span>}
                    </td>
                  )}
                  <td className="td max-w-[280px] truncate font-mono text-[13.5px] text-muted" title={p.endpoint}>
                    {p.endpoint}
                  </td>
                  <td className="td"><AddressLink address={p.payee} chars={4} /></td>
                  <td className="td tnum text-right text-text">{fmtMusd(p.amount, 4)}</td>
                  <td className="td">
                    {p.settlementTx
                      ? <TxLink hash={p.settlementTx} chars={5} />
                      : <Badge tone="bad" title="No settlement transaction — the facilitator rejected this payment and no MUSD moved. This row predates the fix that records rejected settlements as denials instead of payments.">
                          unverified
                        </Badge>}
                  </td>
                  <td className="td">
                    <Badge tone={p.source === "chain" ? "ok" : "info"}>
                      {p.source === "chain" ? "on-chain" : "gateway"}
                    </Badge>
                    {(p.delivered === false || p.warning === "charged_without_delivery") && (
                      <span className="ml-1.5">
                        <Badge tone="warn" title="MUSD settled on chain but the seller returned no resource — the agent was charged without delivery.">
                          no delivery
                        </Badge>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )
        ) : shownDenials.length === 0 ? (
          <div className="p-5">
            <Empty>
              {scope === "mine"
                ? "Nothing of yours has been refused. That is the cap doing its job quietly — a refusal only appears when a price exceeds what you allowed."
                : <>No refusals yet. Lower the per-call cap below a price on the{" "}
                    <Link to="/operate" className="text-info underline decoration-line underline-offset-2 hover:decoration-info">Operate</Link>{" "}
                    page and try again.</>}
            </Empty>
          </div>
        ) : (
          <Table head={[
            { label: "When" },
            ...(showAgent ? [{ label: "Agent" }] : []),
            { label: "Endpoint" },
            { label: "Attempted", align: "right" },
            { label: "Rule that stopped it" },
            { label: "Source" },
          ]}>
            {shownDenials.map((d, i) => (
              <tr key={i} className="transition-colors hover:bg-panel-2/50">
                <td className="td whitespace-nowrap text-dim">{timeAgo(d.timestamp || d.at)}</td>
                {showAgent && (
                  <td className="td whitespace-nowrap">
                    {d.agent
                      ? <><AddressLink address={d.agent} chars={4} />{sameAddr(d.agent, mine) && <span className="ml-1.5"><Badge tone="btc">yours</Badge></span>}</>
                      : <span className="text-dim">—</span>}
                  </td>
                )}
                <td className="td max-w-[240px] truncate font-mono text-[13.5px] text-muted" title={d.endpoint}>
                  {d.endpoint}
                </td>
                <td className="td tnum text-right text-text">{fmtMusd(d.attempted, 4)}</td>
                <td className="td">
                  <Badge tone="bad">{d.reason}</Badge>
                  <span className="ml-2 text-[13.5px] text-muted">
                    {REASON_LABEL[d.reason] || d.reason}
                  </span>
                  {scope === "mine" && (d.reason === "per_call_max" || d.reason === "daily_cap") && (
                    <Link
                      to="/operate"
                      className="ml-2 text-[12.5px] text-info underline decoration-line underline-offset-2 hover:decoration-info"
                    >
                      change your budget
                    </Link>
                  )}
                </td>
                <td className="td">
                  <Badge tone={d.source === "chain" ? "ok" : "info"}>
                    {d.source === "chain" ? "on-chain" : "gateway"}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Note>
          <b className="text-text">Refusals are recorded, not dropped.</b> A budget product that
          silently fails is worse than one with no limits — you need to see that the agent tried to
          overspend, which endpoint it wanted, and which rule stopped it. Every refusal is also
          written to the chain, so it survives the gateway process.
        </Note>
        <Note tone={phantom ? "warn" : ""}>
          {phantom
            ? <>
                <b className="text-text">{phantom} row{phantom === 1 ? "" : "s"} marked unverified.</b>{" "}
                A row with no settlement tx means no MUSD moved. These predate the fix that made the
                gateway verify settlement against the chain instead of trusting the HTTP status. They
                are kept visible — the ledger is append-only and has no delete function, by design.
              </>
            : <>
                <b className="text-text">Every payment row has a settlement transaction.</b> The amount
                above counts only rows that actually settled on chain.
              </>}
        </Note>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, count, children }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[13.5px] font-medium transition-colors ${
        active ? "bg-panel-2 text-text" : "text-muted hover:text-text"
      }`}
    >
      {children}
      <span className={`tnum rounded-full px-1.5 text-[12px] ${active ? "bg-ink-soft text-btc" : "bg-ink-soft text-dim"}`}>
        {count}
      </span>
    </button>
  );
}

function ScopeButton({ active, onClick, disabled, title, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={`cursor-pointer rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? "bg-btc/15 text-btc" : "text-dim hover:text-muted"
      }`}
    >
      {children}
    </button>
  );
}
