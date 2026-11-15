// ---------------------------------------------------------------------------
// Analytics: the dashboard's activity panel, in one reusable component.
//
// Rendered twice on the dashboard from the same code with different inputs: once
// for the signed in user's own receipts and once for the whole protocol. Two hand
// written sections would drift, and "yours vs shared" is the organising idea of
// the page, so both views are built the same way.
//
// EVERY NUMBER COMES FROM activitySummary() in lib/charts-data.js, which is pure
// and offline tested. Nothing is computed in JSX except presentation: a recent
// activity feed (a sort and a slice of the same records) and relative times.
//
// WHAT THIS REFUSES TO DO
//   * interpolate, smooth or extrapolate. The line goes where the receipts are.
//   * draw a flat zero for "no data". Empty states are words that name the action.
//   * imply the window is all history. `windowNote` says how many records were
//     read, because /api/chain-records is capped.
// ---------------------------------------------------------------------------

import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity, Ban, CircleCheck, Clock, Coins, Globe, Landmark, ShieldCheck, Users, Wallet,
} from "lucide-react";
import { Badge, Button, Card, Dot, Grid, Icon, IconTile, Stat, TxLink } from "./ui.jsx";
import { BarChart, Donut, RankBars, Sparkline } from "./charts.jsx";
import { REASON_LABEL } from "../lib/agent-status.jsx";
import { activitySummary, bucketTick } from "../lib/charts-data.js";
import { fmtMusd, short } from "../lib/chain.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** "5m ago". Absolute time is kept in the title so nothing is lost. */
function ago(ts) {
  const diff = Math.max(0, Date.now() / 1000 - Number(ts || 0));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** host + path, without the scheme, so a row reads as a place and not a URL. */
function endpointLabel(url) {
  if (!url) return "unknown endpoint";
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return String(url);
  }
}

/** The newest N records across payments and refusals, one list. */
function buildFeed(payments, denials, n = 6) {
  return [
    ...(payments || []).map((p) => ({
      kind: "paid", ts: Number(p.timestamp) || 0, wei: p.amount,
      endpoint: p.endpoint, tx: p.settlementTx || null, agent: p.agent,
    })),
    ...(denials || []).map((d) => ({
      kind: "refused", ts: Number(d.timestamp) || 0, wei: d.attempted,
      endpoint: d.endpoint, reason: d.reason, agent: d.agent,
    })),
  ]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** A titled container for one chart, so every chart on the page frames alike. */
function Panel({ icon, iconClass = "text-info", title, aside, children, className = "" }) {
  return (
    <div className={`rounded-xl border border-line-soft bg-ink-dim p-4 ${className}`.trim()}>
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold text-text">
          <Icon as={icon} size={15} className={iconClass} />
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** One KPI: an icon tile and a Stat, in a tile of its own. */
function Kpi({ icon, tone = "neutral", ...stat }) {
  return (
    <div className="flex items-start gap-3.5 rounded-xl border border-line-soft bg-ink-dim p-4">
      <IconTile as={icon} tone={tone} size={16} />
      <Stat {...stat} className="min-w-0 flex-1" />
    </div>
  );
}

/**
 * A compact two or three way switch for a single chart.
 * It is a tablist, not buttons: one tab stop, arrow keys to move.
 */
function Tabs({ value, onChange, options, label }) {
  const onKeyDown = (e) => {
    const at = options.findIndex((o) => o.value === value);
    let next = null;
    if (e.key === "ArrowRight") next = options[(at + 1) % options.length];
    else if (e.key === "ArrowLeft") next = options[(at - 1 + options.length) % options.length];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="inline-flex rounded-lg border border-line bg-ink-soft p-0.5"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`cursor-pointer rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
              active ? "bg-btc/15 text-btc" : "text-dim hover:text-text"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** The newest records, one row each, with proof where proof exists. */
function Feed({ items, scope }) {
  if (!items.length) return null;
  return (
    <ul className="divide-y divide-line-soft">
      {items.map((it, i) => {
        const paid = it.kind === "paid";
        return (
          <li key={`${it.ts}-${i}`} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border ${
                paid ? "border-ok/30 bg-ok/10 text-ok" : "border-bad/30 bg-bad/10 text-bad"
              }`}
            >
              <Icon as={paid ? CircleCheck : Ban} size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
                <span className="font-medium text-text">
                  {paid ? "Paid" : "Refused"}{" "}
                  <span className="tnum">{fmtMusd(it.wei, 4)}</span>
                  <span className="ml-1 text-[12px] font-normal text-dim">MUSD</span>
                </span>
                {!paid && (
                  <span className="text-[12.5px] text-bad">{REASON_LABEL[it.reason] || it.reason}</span>
                )}
              </div>
              <div className="truncate font-mono text-[12px] text-dim" title={it.endpoint}>
                {endpointLabel(it.endpoint)}
                {scope !== "you" && it.agent ? ` · ${short(it.agent, 4)}` : ""}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
              <span
                className="text-[12px] text-dim"
                title={new Date(it.ts * 1000).toLocaleString()}
              >
                {ago(it.ts)}
              </span>
              {it.tx ? <TxLink hash={it.tx} chars={4} size={12} /> : <span className="text-[12px] text-faint">no tx</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * @param payments/denials  treasury records, already scoped to whoever this is
 * @param scope             "you" | "protocol": decides the copy and one KPI
 * @param windowNote        how the records were obtained, shown verbatim
 * @param emptyTo           where the empty state sends someone, if anywhere
 * @param emptyCta          its label
 */
export function ActivityPanel({
  payments = [], denials = [], scope = "protocol", windowNote = null,
  emptyTo = null, emptyCta = null, title, sub, icon, tone = "info",
}) {
  const s = useMemo(() => activitySummary(payments, denials), [payments, denials]);
  const feed = useMemo(() => buildFeed(payments, denials, 6), [payments, denials]);
  const [metric, setMetric] = useState("amount");
  const mine = scope === "you";

  // Hourly buckets when everything happened on one UTC day, which is the normal
  // case for a demo. A daily chart with one bar tells nobody anything.
  const span = s.perDay.length > 1 ? "day" : "hour";
  const series = span === "day" ? s.perDay : s.perHour;

  const empty = s.window === 0;
  const settleRate = s.window ? Math.round((s.payments / s.window) * 100) : null;
  const refusedPct = s.window ? Math.round((s.denials / s.window) * 100) : 0;

  const emptyCopy = mine
    ? "Your wallet has not made a payment yet, so there is nothing to chart. Buy something on the Spend page and this fills in from the chain, not from a local counter."
    : "No payments or refusals have been recorded on this treasury yet. The first one lands here the moment it settles.";

  return (
    <Card
      icon={icon || (mine ? Wallet : Activity)}
      tone={tone}
      title={title || (mine ? "Your activity" : "Protocol activity")}
      sub={sub}
      aside={
        <>
          {windowNote && <Badge tone="neutral" icon={Landmark}>{windowNote}</Badge>}
          <Badge tone={empty ? "neutral" : "ok"}>
            <Dot tone={empty ? "warn" : "ok"} pulse={!empty} />
            {empty ? "no data yet" : "live from chain"}
          </Badge>
        </>
      }
    >
      {empty ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line bg-ink-dim/40 px-6 py-10 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full border border-line bg-ink-soft text-dim">
            <Icon as={mine ? Wallet : Activity} size={20} />
          </span>
          <p className="max-w-lg text-[14.5px] leading-relaxed text-muted">{emptyCopy}</p>
          {emptyTo && (
            <Link to={emptyTo}>
              <Button size="sm" variant="primary">{emptyCta || "Go"}</Button>
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {/* --- headline numbers --- */}
          <Grid cols={4} className="gap-4">
            <Kpi icon={CircleCheck} tone="ok" label="Payments settled" value={s.payments}
                 hint={settleRate === null ? "on-chain receipts" : `${settleRate}% settlement rate`} />
            <Kpi icon={Coins} tone="btc" label="MUSD moved" value={fmtMusd(s.settledWei, 4)} unit="MUSD"
                 hint={s.avgWei === null ? "no average yet" : `avg ${fmtMusd(s.avgWei, 4)} a payment`} />
            {/* A refusal count in red would read as failures. These are the
                product working, so the tone stays neutral. */}
            <Kpi icon={ShieldCheck} tone="info" label="Refused by policy" value={s.denials}
                 hint={s.window ? `${refusedPct}% of ${s.window} attempts` : "nothing attempted yet"} />
            {mine ? (
              <Kpi icon={Globe} tone="accent" label="Endpoints paid" value={s.distinctEndpoints}
                   hint="distinct sellers in this window" />
            ) : (
              <Kpi icon={Users} tone="accent" label="Agent wallets" value={s.distinctAgents}
                   hint="distinct addresses seen" />
            )}
          </Grid>

          {/* --- the main chart, and what happened to each attempt --- */}
          <div className="grid items-stretch gap-5 lg:grid-cols-3">
            <Panel
              className="lg:col-span-2"
              icon={metric === "amount" ? Coins : Activity}
              iconClass={metric === "amount" ? "text-btc" : "text-info"}
              title={metric === "amount" ? `MUSD settled per ${span}` : `Payments per ${span}`}
              aside={
                <div className="flex items-center gap-3">
                  <span className="text-[12.5px] text-dim">UTC</span>
                  <Tabs
                    label="Chart metric"
                    value={metric}
                    onChange={setMetric}
                    options={[
                      { value: "amount", label: "Volume" },
                      { value: "count", label: "Count" },
                    ]}
                  />
                </div>
              }
            >
              {metric === "amount" ? (
                <Sparkline
                  buckets={series}
                  span={span}
                  tone="btc"
                  height={176}
                  format={(v) => `${fmtMusd(v, 4)} MUSD`}
                />
              ) : (
                <BarChart
                  tone="info"
                  height={176}
                  format={(v) => `${v} payment${v === 1 ? "" : "s"}`}
                  data={series.map((b) => ({
                    label: bucketTick(b, span),
                    value: b.count,
                    title: `${b.count} payment${b.count === 1 ? "" : "s"} · ${fmtMusd(b.amountWei, 4)} MUSD`,
                  }))}
                />
              )}
            </Panel>

            <Panel
              icon={ShieldCheck}
              iconClass="text-ok"
              title="Attempts by outcome"
              aside={<span className="tnum text-[12.5px] text-dim">{s.window} total</span>}
            >
              <Donut
                size={140}
                thickness={14}
                centre={s.window}
                centreLabel="attempts"
                slices={[
                  { label: "settled", value: s.payments, tone: "ok" },
                  { label: "refused by policy", value: s.denials, tone: "bad" },
                ]}
                emptyText="No attempts recorded"
              />
              <p className="mt-3.5 border-t border-line-soft pt-3 text-[13px] leading-relaxed text-dim">
                {s.denials === 0
                  ? "Nothing has been refused yet. A refusal is not a failure. It is the budget doing its job, and it costs nothing."
                  : `${s.denials} attempt${s.denials === 1 ? "" : "s"} refused before anything was signed, so ${fmtMusd(s.refusedWei, 4)} MUSD of attempted spend never moved.`}
              </p>
            </Panel>
          </div>

          {/* --- latest records, and who or what they went to --- */}
          <div className="grid items-start gap-5 lg:grid-cols-5">
            <Panel
              className="lg:col-span-3"
              icon={Clock}
              iconClass="text-accent"
              title="Latest activity"
              aside={<span className="text-[12.5px] text-dim">newest {feed.length}</span>}
            >
              <Feed items={feed} scope={scope} />
            </Panel>

            <Panel
              className="lg:col-span-2"
              icon={mine ? Globe : Users}
              iconClass="text-accent"
              title={mine ? "Endpoints you paid" : "Busiest agent wallets"}
              aside={<span className="text-[12.5px] text-dim">by record count</span>}
            >
              <RankBars
                tone="accent"
                format={(v) => String(v)}
                rows={(mine ? s.perEndpoint : s.perAgent).map((r) => ({
                  key: r.key,
                  label: mine ? r.label : short(r.key, 4),
                  value: r.count,
                  title: mine ? r.key : `${r.key}: ${r.count} record(s)`,
                }))}
                emptyText={mine ? "No endpoints paid yet" : "No agents recorded yet"}
              />
            </Panel>
          </div>

          {/* --- refusals by reason: the most instructive thing on the page --- */}
          {s.denials > 0 && (
            <div className="rounded-xl border border-bad/25 bg-bad-dim/25 p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="flex items-center gap-2 text-[14px] font-semibold text-text">
                  <Icon as={Ban} size={15} className="text-bad" />
                  Why payments were refused
                </h3>
                <span className="text-[12.5px] text-dim">
                  {fmtMusd(s.refusedWei, 4)} MUSD attempted and never signed
                </span>
              </div>
              <RankBars
                tone="bad"
                maxRows={6}
                format={(v) => `${v}×`}
                rows={s.perReason.map((r) => ({
                  key: r.key,
                  // The code is what appears in the ledger and the words are what
                  // a person needs. Showing one of them is half an explanation.
                  label: r.isOther ? r.key : (REASON_LABEL[r.key] || r.key),
                  value: r.count,
                  title: r.isOther ? `${r.count} further reasons` : `${r.key}: ${r.count}`,
                }))}
                emptyText="No refusals"
              />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export default ActivityPanel;