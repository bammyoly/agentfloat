// ---------------------------------------------------------------------------
// test-charts — the arithmetic behind every chart on the dashboard.
//
//   npm run test:charts        (from the repo root)
//
// WHY THE MATHS GETS ITS OWN SUITE
//   A chart is an assertion about data, and a wrong assertion looks exactly like
//   a right one. Nothing here can be caught by eyeballing the running app:
//
//     • Bucket on the LOCAL day instead of UTC and the "spent per day" chart
//       disagrees with the daily cap that actually refused the payment — for
//       anyone not in UTC+0, which is everyone the product is for.
//     • Drop an empty bucket and a three-day gap renders as two adjacent bars,
//       i.e. the chart says activity was continuous when it was not.
//     • Sum a record with no `amount` as NaN (or let BigInt(undefined) throw) and
//       the total silently becomes wrong rather than loudly broken.
//
//   The last section is the one that matters most: it cross-checks the frontend's
//   bucket boundary against server/spend.js, which is the module that decides
//   whether a payment is refused. Two implementations of "what day is this" that
//   can drift is how a dashboard ends up contradicting the enforcement.
//
// Offline. No chain, no network, no .env.
// ---------------------------------------------------------------------------

import {
  activitySummary, bucketLabel, bucketSeries, bucketTick, distinctCount,
  forAgent, tallyBy, toneVar,
} from "../src/lib/charts-data.js";
import { dayStartSec } from "../../server/spend.js";

let passed = 0;
let failed = 0;
const ok = (name, extra = "") => {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? ` \x1b[90m${extra}\x1b[0m` : ""}`);
};
const bad = (name, extra = "") => {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? `\n      ${extra}` : ""}`);
};
/** eq(), not ok(cond): both sides are stringified so a failure shows values. */
const eq = (name, got, want) =>
  got === want ? ok(name, `= ${JSON.stringify(got)}`) : bad(name, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const big = (name, got, want) =>
  got === want ? ok(name, `= ${want}n`) : bad(name, `got ${got}n, want ${want}n`);
const truthy = (name, cond, extra = "") => (cond ? ok(name, extra) : bad(name, extra || "expected true"));

// 2026-10-25T00:00:00Z and neighbours. Fixed, because a test whose expected
// value depends on when it runs is a test that starts failing on a birthday.
// Computed, never hardcoded: a hand-written epoch constant is how a test ends
// up asserting against a date that is not the one in the comment.
const DAY0 = Date.UTC(2026, 9, 25) / 1000;          // 2026-10-25T00:00:00Z
const DAY1 = DAY0 + 86400;
const DAY2 = DAY0 + 2 * 86400;
const MUSD = (n) => (BigInt(n) * 10n ** 18n).toString();   // n MUSD in wei, as a string

console.log(`\n== chart data ====================================================`);

// ---------------------------------------------------------------------------
console.log(`\n  toneVar`);
{
  eq("a known tone maps to its CSS custom property", toneVar("btc"), "var(--color-btc)");
  eq("so does ok", toneVar("ok"), "var(--color-ok)");
  eq("an unknown tone falls back rather than returning undefined", toneVar("chartreuse"), "var(--color-info)");
  eq("and so does a missing one", toneVar(), "var(--color-info)");
  // An SVG stroke of "undefined" renders as NO stroke, i.e. an invisible chart
  // with nothing in the console. This is the assertion that catches that.
  truthy("no tone returns a literal 'undefined'", !String(toneVar("nope")).includes("undefined"));
}

// ---------------------------------------------------------------------------
console.log(`\n  bucketSeries — the UTC day boundary`);
{
  eq("no input gives no buckets (not one empty one)", bucketSeries([]).length, 0);
  eq("null input is tolerated", bucketSeries(null).length, 0);

  // One second either side of midnight UTC. These two records are 2s apart and
  // belong to different days — the exact pair a local-time bucket gets wrong
  // for anyone west of Greenwich.
  const straddle = bucketSeries([
    { timestamp: DAY0 + 86399, amount: MUSD(1) },   // 23:59:59 on day 0
    { timestamp: DAY0 + 86401, amount: MUSD(2) },   // 00:00:01 on day 1
  ]);
  eq("records 2 seconds apart across midnight land in 2 buckets", straddle.length, 2);
  eq("the first bucket starts exactly at midnight UTC", straddle[0].start, DAY0);
  eq("and the second at the next midnight", straddle[1].start, DAY1);
  big("the first day's total is its own record", straddle[0].amountWei, 10n ** 18n);
  big("the second day's total is its own record", straddle[1].amountWei, 2n * 10n ** 18n);

  const oneDay = bucketSeries([
    { timestamp: DAY0 + 100, amount: MUSD(1) },
    { timestamp: DAY0 + 5000, amount: MUSD(2) },
    { timestamp: DAY0 + 80000, amount: "1000000000000000" },  // 0.001 MUSD, raw wei
  ]);
  eq("three same-day records make one bucket", oneDay.length, 1);
  eq("counted together", oneDay[0].count, 3);
  big("and summed exactly, in wei", oneDay[0].amountWei, 3n * 10n ** 18n + 10n ** 15n);
  eq("with every record kept for drill-down", oneDay[0].items.length, 3);
}

// ---------------------------------------------------------------------------
console.log(`\n  bucketSeries — empty buckets are KEPT`);
{
  // Day 0 and day 2 have records; day 1 does not. Compressing the gap would
  // draw two adjacent bars and claim the activity was continuous.
  const withGap = bucketSeries([
    { timestamp: DAY0 + 10, amount: MUSD(1) },
    { timestamp: DAY2 + 10, amount: MUSD(3) },
  ]);
  eq("a quiet day between two active ones produces three buckets", withGap.length, 3);
  eq("the middle one is present", withGap[1].start, DAY1);
  eq("and empty", withGap[1].count, 0);
  big("with nothing in it", withGap[1].amountWei, 0n);
  eq("the buckets are contiguous, oldest first", withGap.map((b) => b.start - DAY0).join(","), "0,86400,172800");
}

// ---------------------------------------------------------------------------
console.log(`\n  bucketSeries — records that cannot be summed`);
{
  const messy = bucketSeries([
    { timestamp: DAY0 + 1, amount: MUSD(1) },
    { timestamp: DAY0 + 2 },                       // no amount at all
    { timestamp: DAY0 + 3, amount: null },
    { timestamp: DAY0 + 4, amount: "" },
    { timestamp: DAY0 + 5, amount: "not-a-number" },
    { timestamp: DAY0 + 6, amount: MUSD(1) },
  ]);
  eq("every record still counts", messy[0].count, 6);
  big("and the total is not poisoned by the unsummable ones", messy[0].amountWei, 2n * 10n ** 18n);
  truthy("the total is a BigInt, never NaN", typeof messy[0].amountWei === "bigint");

  // A record with no usable timestamp is dropped rather than bucketed into 1970,
  // which would stretch the x-axis across 56 years and flatten the real data.
  eq("a record with no timestamp is excluded", bucketSeries([{ amount: MUSD(1) }, { timestamp: 0, amount: MUSD(1) }]).length, 0);

  // A numeric amount is accepted too: /api/chain-records sends strings, but a
  // caller with a count would send a number, and throwing there is worse than
  // converting.
  const numeric = bucketSeries([{ timestamp: DAY0 + 1, amount: 1000 }]);
  big("a numeric amount is summed as wei", numeric[0].amountWei, 1000n);
}

// ---------------------------------------------------------------------------
console.log(`\n  bucketSeries — hourly span, and a different timestamp key`);
{
  const hours = bucketSeries(
    [
      { timestamp: DAY0 + 10, amount: MUSD(1) },
      { timestamp: DAY0 + 3700, amount: MUSD(1) },   // next hour
      { timestamp: DAY0 + 3800, amount: MUSD(1) },   // same hour as above
    ],
    { span: "hour" }
  );
  eq("hourly buckets are 3600s wide", hours.length, 2);
  eq("the second starts on the hour", hours[1].start - DAY0, 3600);
  eq("and holds both records from that hour", hours[1].count, 2);

  const denials = bucketSeries([{ at: DAY0 + 5, attempted: MUSD(9) }], { key: "at", amountKey: "attempted" });
  eq("a different timestamp key is honoured", denials[0].start, DAY0);
  big("and so is a different amount key", denials[0].amountWei, 9n * 10n ** 18n);

  // A refusal is counted, not summed into spend. amountKey: null is how a caller
  // asks for that, and it must not throw.
  const counts = bucketSeries([{ timestamp: DAY0 + 1 }, { timestamp: DAY0 + 2 }], { amountKey: null });
  eq("amountKey: null still counts records", counts[0].count, 2);
  big("with a zero total", counts[0].amountWei, 0n);
}

// ---------------------------------------------------------------------------
console.log(`\n  bucketLabel / bucketTick — and they say UTC`);
{
  const b = { start: DAY0, end: DAY0 + 86400 };
  eq("a day label carries the date", bucketLabel(b, "day"), "2026-10-25 (UTC)");
  truthy("and names the timezone", bucketLabel(b, "day").includes("UTC"));
  eq("an hour label carries the range", bucketLabel({ start: DAY0 + 3600, end: DAY0 + 7200 }, "hour"), "2026-10-25 01:00–02:00 UTC");
  eq("a day tick is short", bucketTick(b, "day"), "10/25");
  eq("an hour tick is the time", bucketTick({ start: DAY0 + 3600 }, "hour"), "01:00");

  // The label is derived from the bucket, so a mislabelled axis is impossible
  // without also moving the bucket — but pin it anyway: an axis that says the
  // wrong date is the single most confusing chart bug there is.
  truthy("the label of the day-1 bucket is day 1", bucketLabel({ start: DAY1, end: DAY1 + 86400 }, "day").startsWith("2026-10-26"));
}

// ---------------------------------------------------------------------------
console.log(`\n  tallyBy`);
{
  const items = [
    { agent: "0xA" }, { agent: "0xA" }, { agent: "0xA" },
    { agent: "0xB" }, { agent: "0xB" },
    { agent: "0xC" },
  ];
  const t = tallyBy(items, "agent");
  eq("counts per distinct value", t.length, 3);
  eq("largest first", t[0].key, "0xA");
  eq("with its count", t[0].count, 3);
  eq("then the next", t[1].key, "0xB");
  eq("ties break on the key, so the order is stable across renders", tallyBy([{ agent: "0xZ" }, { agent: "0xY" }], "agent")[0].key, "0xY");

  const limited = tallyBy(
    Array.from({ length: 10 }, (_, i) => ({ agent: `0x${i}` })),
    "agent",
    { limit: 3 }
  );
  eq("a limit collapses the tail", limited.length, 4);
  eq("into one labelled 'others' row", limited[3].key, "others");
  eq("holding the collapsed count", limited[3].count, 7);
  truthy("and flagged as the collapsed row", limited[3].isOther === true);

  eq("no input gives no rows", tallyBy([], "agent").length, 0);
  eq("a missing field is counted as 'unknown', not dropped", tallyBy([{ x: 1 }], "agent")[0].key, "unknown");
  eq("counts are Numbers, so a renderer can do percentage maths", typeof tallyBy(items, "agent")[0].count, "number");
}

// ---------------------------------------------------------------------------
console.log(`\n  distinctCount`);
{
  const items = [{ agent: "0xA" }, { agent: "0xA" }, { agent: "0xB" }, {}, { agent: "" }];
  eq("counts distinct values, not rows", distinctCount(items, "agent"), 2);
  eq("ignores blanks", distinctCount([{ agent: "" }, { agent: null }], "agent"), 0);
  eq("no input is zero", distinctCount([], "agent"), 0);
  // Case matters: addresses are checksummed, and lowercasing would merge two
  // spellings of the same key while ALSO merging two different keys if one were
  // not an address. Counting exactly what the chain returned is the honest one.
  eq("does not case-fold", distinctCount([{ agent: "0xAa" }, { agent: "0xaA" }], "agent"), 2);
}

// ---------------------------------------------------------------------------
// THE IMPORTANT SECTION.
// The dashboard chart and the gateway's daily cap must agree on what day a
// receipt belongs to. They are two implementations in two processes; this is
// what stops them drifting.
// ---------------------------------------------------------------------------
console.log(`\n  the chart's day boundary IS the enforcement's day boundary`);
{
  // Every second across three days, plus the exact edges.
  const probes = [
    DAY0, DAY0 + 1, DAY0 + 43200, DAY0 + 86399,
    DAY1, DAY1 + 1, DAY1 + 86399,
    DAY2, DAY2 + 86399,
    1, 86399, 86400, 86401,
    Math.floor(Date.now() / 1000),
  ];
  let mismatches = 0;
  for (const t of probes) {
    const chart = bucketSeries([{ timestamp: t, amount: "1" }])[0].start;
    const gateway = dayStartSec(t);
    if (chart !== gateway) {
      mismatches++;
      bad(`t=${t}`, `chart bucketed into ${chart}, server/spend.js says ${gateway}`);
    }
  }
  if (!mismatches) {
    ok(`bucketSeries and dayStartSec agree on all ${probes.length} probe timestamps`, "midnight, midday, 23:59:59, epoch edges, now");
  }

  // And the consequence, stated as a user would see it: receipts the gateway
  // counts toward today's cap are exactly the receipts the chart draws in
  // today's bucket.
  const now = DAY1 + 12345;
  const todaysStart = dayStartSec(now);
  const receipts = [
    { timestamp: todaysStart - 1, amount: MUSD(1) },   // yesterday, 1s before
    { timestamp: todaysStart, amount: MUSD(1) },       // today, exactly midnight
    { timestamp: now, amount: MUSD(1) },               // today
  ];
  const buckets = bucketSeries(receipts);
  const today = buckets.find((b) => b.start === todaysStart);
  eq("the chart puts 2 of the 3 receipts in today's bucket", today.count, 2);
  big("summing to what the cap would count", today.amountWei, 2n * 10n ** 18n);
  eq("and yesterday's receipt is in its own bucket", buckets.find((b) => b.start === todaysStart - 86400).count, 1);
}


// ---------------------------------------------------------------------------
// activitySummary — every KPI on the dashboard comes out of this one function,
// so a wrong figure here is a wrong claim about the protocol on the page a judge
// opens first.
// ---------------------------------------------------------------------------
console.log(`\n  activitySummary`);
{
  const payments = [
    { agent: "0xA", endpoint: "https://demo.vativ.io/", amount: MUSD(1), timestamp: DAY0 + 10 },
    { agent: "0xA", endpoint: "http://127.0.0.1:4022/paid/insight", amount: MUSD(1), timestamp: DAY0 + 20 },
    { agent: "0xB", endpoint: "https://demo.vativ.io/", amount: MUSD(2), timestamp: DAY1 + 5 },
  ];
  const denials = [
    { agent: "0xA", attempted: MUSD(9), timestamp: DAY0 + 30, reason: "daily_cap" },
    { agent: "0xC", attempted: MUSD(1), timestamp: DAY0 + 40, reason: "permit2_not_approved" },
  ];
  const s = activitySummary(payments, denials);

  eq("counts settled payments", s.payments, 3);
  eq("and refusals separately", s.denials, 2);
  big("sums what settled", s.settledWei, 4n * 10n ** 18n);
  big("sums what was refused", s.refusedWei, 10n * 10n ** 18n);
  big("and what was attempted in total", s.attemptedWei, 14n * 10n ** 18n);
  // The refusal is bigger than the spend here on purpose: a summary that added
  // them the wrong way round, or dropped one, would still look plausible.
  truthy("refused exceeds settled in this fixture", s.refusedWei > s.settledWei);

  big("averages over settled payments only", s.avgWei, (4n * 10n ** 18n) / 3n);
  eq("counts distinct agents across BOTH kinds of record", s.distinctAgents, 3);
  eq("and distinct endpoints across payments", s.distinctEndpoints, 2);
  // The window is how many records were read, so the card can say "last 100"
  // instead of implying the chart covers all history.
  eq("reports how many records it covered", s.window, 5);
  eq("the first activity, in seconds", s.firstAt, DAY0 + 10);
  eq("and the last", s.lastAt, DAY1 + 5);

  eq("buckets payments per day", s.perDay.length, 2);
  big("day one summed both of its payments", s.perDay[0].amountWei, 2n * 10n ** 18n);
  eq("ranks endpoints by payment count", s.perEndpoint[0].key, "https://demo.vativ.io/");
  eq("with a readable label", s.perEndpoint[0].label, "demo.vativ.io");
  eq("a loopback endpoint keeps its path, which is the identifying part", s.perEndpoint[1].label, "127.0.0.1:4022/paid/insight");
  eq("ranks refusal reasons", s.perReason.map((r) => r.key).sort().join(","), "daily_cap,permit2_not_approved");
  eq("ranks agents across payments and refusals", s.perAgent[0].key, "0xA");
  eq("0xA appears in three records", s.perAgent[0].count, 3);
  eq("hourly buckets are available too", s.perHour.length > 0, true);
  eq("refusals get their own daily series, counted not summed", s.perDayRefused[0].count, 2);
  big("with nothing summed into it", s.perDayRefused[0].amountWei, 0n);

  // --- the empty case -------------------------------------------------------
  // This is a FRESH DEPLOYMENT, which is exactly what a judge sees first. Every
  // field has to be a shape the renderers accept, and nothing may invent activity.
  const e = activitySummary([], []);
  eq("no payments", e.payments, 0);
  eq("no refusals", e.denials, 0);
  big("nothing settled", e.settledWei, 0n);
  // NOT 0n: an average of zero reads as "the average payment was free".
  eq("and the average is null, not zero", e.avgWei, null);
  eq("no buckets to draw", e.perDay.length, 0);
  eq("no ranks", e.perEndpoint.length, 0);
  eq("no agents", e.distinctAgents, 0);
  eq("no window", e.window, 0);
  eq("and no first/last timestamps", e.firstAt, null);

  // --- malformed input ------------------------------------------------------
  const messy = activitySummary(
    [{ agent: "0xA", amount: MUSD(1), timestamp: DAY0 }, null, { agent: "0xB", timestamp: DAY0 }, { agent: "0xC", amount: "junk", timestamp: DAY0 }],
    null
  );
  eq("null entries are skipped, not counted", messy.payments, 3);
  big("an unparseable amount does not poison the total", messy.settledWei, 10n ** 18n);
  eq("missing denials is tolerated", messy.denials, 0);
  truthy("and the result is still a BigInt", typeof messy.settledWei === "bigint");

  // A record with no endpoint must not vanish from the ranking — it is still a
  // payment the user made.
  eq("an endpoint-less payment is ranked as 'unknown'", activitySummary([{ amount: MUSD(1), timestamp: DAY0 }], []).perEndpoint[0].key, "unknown");
}

// ---------------------------------------------------------------------------
console.log(`\n  forAgent — "your activity" has to actually find you`);
{
  const records = [{ agent: "0xAbC" }, { agent: "0xaBc" }, { agent: "0xOther" }, {}];
  eq("matches regardless of checksum casing", forAgent(records, "0xABC").length, 2);
  eq("ignores other agents", forAgent(records, "0xOther").length, 1);
  eq("a record with no agent never matches", forAgent(records, "").length, 0);
  eq("and no address at all gives nothing, not everything", forAgent(records, null).length, 0);
  eq("no records is empty, not an error", forAgent(null, "0xABC").length, 0);
  // Prefixes are not matches: `startsWith` here would show one user another
  // user's payments, which is the worst possible version of this bug.
  eq("a prefix of another address does not match", forAgent([{ agent: "0xABCDEF" }], "0xABC").length, 0);
}

console.log(
  `\n${failed ? `❌ ${failed} failed` : "✅ chart data is sound"}, ${passed} passed\n`
);
process.exit(failed ? 1 : 0);
