// ---------------------------------------------------------------------------
// Analytics — the dashboard's charts, in one reusable panel.
//
// Rendered TWICE on the dashboard, from the same component with different inputs:
// once for the signed-in user's own receipts and once for the whole protocol. That
// is deliberate. Two hand-written chart sections would drift — different colours,
// different empty states, one of them eventually claiming a number the other
// contradicts — and the "yours vs shared" split is the organising idea of this
// page, so the two views had better be built the same way.
//
// EVERY NUMBER COMES FROM activitySummary() in lib/charts-data.js, which is pure
// and offline-tested (npm run test:charts). Nothing is computed in JSX: a chart is
// an assertion about the chain's records, and assertions belong somewhere they can
// be tested.
//
// WHAT THIS REFUSES TO DO
//   • interpolate, smooth or extrapolate. The line goes where the receipts are.
//   • draw a flat zero for "no data". An empty chart on a fresh deployment reads
//     as "this protocol is dead", which is not the same claim as "you have not paid
//     for anything yet" — so the empty states are words, and they name the action.
//   • imply the window is all history. `windowNote` says how many receipts were
//     read, because /api/chain-records is capped and a truncated series that looks
//     complete is a lie with a nice gradient on it.
// ---------------------------------------------------------------------------

import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Activity, Ban, CircleCheck, Coins, Globe, Landmark, ShieldCheck, Users, Wallet,
} from "lucide-react";
import { Badge, Button, Card, Dot, Grid, Icon, Stat } from "./ui.jsx";
import { BarChart, Donut, RankBars, Sparkline } from "./charts.jsx";
import { REASON_LABEL } from "../lib/agent-status.jsx";
import { activitySummary, bucketTick } from "../lib/charts-data.js";
import { fmtMusd, short } from "../lib/chain.js";

/**
 * The KPI strip. Four numbers, each one a different question:
 * how often, how much, how often stopped, and how many wallets.
 */
function Kpis({ s, scope }) {
  const refusedPct = s.window ? Math.round((s.denials / s.window) * 100) : 0;
  return (
    <Grid cols={4} className="gap-4">
      <div className="rounded-xl border border-line-soft bg-ink-dim p-4">
        <Stat icon={CircleCheck} label="Payments settled" value={s.payments}
              hint={scope === "you" ? "verified against the MUSD transfer log" : "on-chain receipts"} />
      </div>
      <div className="rounded-xl border border-line-soft bg-ink-dim p-4">
        <Stat icon={Coins} label="MUSD moved" value={fmtMusd(s.settledWei, 4)} unit="MUSD"
              hint={s.avgWei === null ? "no average yet" : `avg ${fmtMusd(s.avgWei, 4)} a payment`} />
      </div>
      <div className="rounded-xl border border-line-soft bg-ink-dim p-4">
        {/* A refusal count in red would read as "failures". These are the product
            working, so the tone is the neutral one and the hint says what it is. */}
        <Stat icon={ShieldCheck} label="Refused by policy" value={s.denials}
              hint={s.window ? `${refusedPct}% of ${s.window} attempts` : "nothing attempted yet"} />
      </div>
      <div className="rounded-xl border border-line-soft bg-ink-dim p-4">
        {scope === "you" ? (
          <Stat icon={Globe} label="Endpoints paid" value={s.distinctEndpoints}
                hint="distinct sellers in this window" />
        ) : (
          <Stat icon={Users} label="Agent wallets" value={s.distinctAgents}
                hint="distinct addresses seen" />
        )}
      </div>
    </Grid>
  );
}

/**
 * The charts.
 *
 * @param payments/denials  treasury records, already scoped to whoever this is
 * @param scope             "you" | "protocol" — decides the copy and one KPI
 * @param windowNote        how the records were obtained, shown verbatim
 * @param emptyTo           where the empty state sends someone, if anywhere
 * @param emptyCta          its label
 */
export function ActivityPanel({
  payments = [], denials = [], scope = "protocol", windowNote = null,
  emptyTo = null, emptyCta = null, title, sub, icon, tone = "info",
}) {
  const s = useMemo(() => activitySummary(payments, denials), [payments, denials]);
  const mine = scope === "you";

  // Hourly buckets when everything happened on one UTC day — which is the normal
  // case for a demo, and a daily chart of one bar tells nobody anything. The
  // boundary is the same UTC day the cap is enforced on (see test-charts).
  const span = s.perDay.length > 1 ? "day" : "hour";
  const series = span === "day" ? s.perDay : s.perHour;

  const empty = s.window === 0;
  const emptyCopy = mine
    ? "Your wallet has not made a payment yet, so there is nothing to chart. Buy something on the Spend page and this fills in from the chain — not from a local counter."
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
        <div className="space-y-6">
          <Kpis s={s} scope={scope} />

          <div className="grid items-start gap-6 lg:grid-cols-2">
            {/* --- volume over time --- */}
            <div className="rounded-xl border border-line-soft bg-ink-dim p-4">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h3 className="flex items-center gap-2 text-[14px] font-semibold text-text">
                  <Icon as={Coins} size={15} className="text-btc" />
                  MUSD settled per {span}
                </h3>
                <span className="text-[12.5px] text-dim">UTC</span>
              </div>
              <Sparkline
                buckets={series}
                span={span}
                tone="btc"
                format={(v) => `${fmtMusd(v, 4)} MUSD`}
              />
            </div>

            {/* --- what happened to each attempt --- */}
            <div className="rounded-xl border border-line-soft bg-ink-dim p-4">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h3 className="flex items-center gap-2 text-[14px] font-semibold text-text">
                  <Icon as={ShieldCheck} size={15} className="text-ok" />
                  Attempts by outcome
                </h3>
                <span className="tnum text-[12.5px] text-dim">{s.window} total</span>
              </div>
              <Donut
                size={156}
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
                  ? "Nothing has been refused yet. A refusal is not a failure — it is the budget doing its job, and it costs nothing."
                  : `${s.denials} attempt${s.denials === 1 ? "" : "s"} refused before anything was signed, so ${fmtMusd(s.refusedWei, 4)} MUSD of attempted spend never moved.`}
              </p>
            </div>
          </div>

          <div className="grid items-start gap-6 lg:grid-cols-2">
            {/* --- count per bucket, the shape of the activity --- */}
            <div className="rounded-xl border border-line-soft bg-ink-dim p-4">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h3 className="flex items-center gap-2 text-[14px] font-semibold text-text">
                  <Icon as={Activity} size={15} className="text-info" />
                  Payments per {span}
                </h3>
                <span className="text-[12.5px] text-dim">
                  {series.length} bucket{series.length === 1 ? "" : "s"}
                </span>
              </div>
              <BarChart
                tone="info"
                height={150}
                format={(v) => `${v} payment${v === 1 ? "" : "s"}`}
                data={series.map((b) => ({
                  label: bucketTick(b, span),
                  value: b.count,
                  title: `${b.count} payment${b.count === 1 ? "" : "s"} · ${fmtMusd(b.amountWei, 4)} MUSD`,
                }))}
              />
            </div>

            {/* --- rankings --- */}
            <div className="rounded-xl border border-line-soft bg-ink-dim p-4">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h3 className="flex items-center gap-2 text-[14px] font-semibold text-text">
                  <Icon as={mine ? Globe : Users} size={15} className="text-accent" />
                  {mine ? "Endpoints you paid" : "busiest agent wallets"}
                </h3>
                <span className="text-[12.5px] text-dim">by record count</span>
              </div>
              <RankBars
                tone="accent"
                format={(v) => String(v)}
                rows={(mine ? s.perEndpoint : s.perAgent).map((r) => ({
                  key: r.key,
                  label: mine ? r.label : short(r.key, 4),
                  value: r.count,
                  title: mine ? r.key : `${r.key} — ${r.count} record(s)`,
                }))}
                emptyText={mine ? "No endpoints paid yet" : "No agents recorded yet"}
              />
            </div>
          </div>

          {/* --- refusals, by reason: the most instructive thing on the page --- */}
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
                  // The code is the machine-readable truth and the label is what it
                  // means. Showing only one of them is half an explanation: the code
                  // is what appears in the ledger, the words are what a person needs.
                  label: r.isOther ? r.key : (REASON_LABEL[r.key] || r.key),
                  value: r.count,
                  title: r.isOther ? `${r.count} further reasons` : `${r.key} — ${r.count}`,
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
