// ---------------------------------------------------------------------------
// test-autopay — offline tests for the automated-spending state machine.
//
//   npm run test:autopay       (frontend/)
//   npm run test:browser       (repo root — runs this too)
//
// WHY OFFLINE
//   Everything here is arithmetic over on-chain numbers: which run a cap refuses,
//   how much actually moved, when the loop must stop. None of it needs a wallet,
//   a seller or a chain, and all of it is what a judge reads on screen — so a
//   wrong number here is a wrong claim in a demo. Fake AgentStatus objects are
//   used with the real values read off Mezo testnet (0.001 MUSD quotes, 2.0
//   per-call max, 10.0 daily cap) so the fixtures are not invented.
//
// BigInts are compared as strings: JSON.stringify throws on them, and this
// codebase has paid for that three times already.
// ---------------------------------------------------------------------------

import {
  DEFAULT_SCHEDULE, FLOW, LIMITS, OUTCOME, OUTCOME_LABEL, REFUSAL_STEP,
  STEP_STATE, STOP_REASON_LABEL, normalizeSchedule, describeSchedule,
  classifyRun, refusalCodes, flowStep, makeRun, summarize, shouldContinue,
  budgetView,
} from "../src/lib/autopay.js";

let failures = 0;
let count = 0;
const eq = (name, actual, expected) => {
  count++;
  const a = typeof actual === "bigint" ? `${actual}n` : String(actual);
  const e = typeof expected === "bigint" ? `${expected}n` : String(expected);
  if (a === e) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n      expected ${e}\n      actual   ${a}`); }
};
const ok = (name, cond, detail = "") => {
  count++;
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ""}`); }
};

// Real numbers from the deployed testnet agent, so the arithmetic under test is
// the arithmetic a judge will watch.
const QUOTE = 1000000000000000n;        // 0.001 MUSD — Mezo's hosted demo price
const musd = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/** A treasury AgentStatus shaped exactly like the contract's struct. */
function status({ perCallMax = musd(2), dailyCap = musd(10), spentToday = 0n, walletBalance = musd(10) } = {}) {
  const remaining = dailyCap > spentToday ? dailyCap - spentToday : 0n;
  return { active: true, perCallMax, dailyCap, dayFunded: spentToday, remainingToday: remaining, walletBalance };
}

console.log(`\n== autopay: the automated-spending state machine ============================\n`);

// --- 1. the schedule a user configures ---------------------------------------
console.log("  -- schedule --");
{
  const d = normalizeSchedule({});
  eq("defaults to a sane interval", d.intervalSec, DEFAULT_SCHEDULE.intervalSec);
  eq("defaults to a bounded number of runs", d.maxRuns, DEFAULT_SCHEDULE.maxRuns);
  eq("defaults to stopping on refusal", d.stopOnRefusal, true);

  eq("an interval of 0 is clamped, not accepted", normalizeSchedule({ intervalSec: 0 }).intervalSec, LIMITS.intervalSec.min);
  eq("an absurd interval is clamped down", normalizeSchedule({ intervalSec: 99999 }).intervalSec, LIMITS.intervalSec.max);
  eq("a nonsense interval falls back to the default", normalizeSchedule({ intervalSec: "fast" }).intervalSec, DEFAULT_SCHEDULE.intervalSec);
  eq("maxRuns cannot be 0", normalizeSchedule({ maxRuns: 0 }).maxRuns, LIMITS.maxRuns.min);
  eq("maxRuns cannot be unbounded", normalizeSchedule({ maxRuns: 1e9 }).maxRuns, LIMITS.maxRuns.max);
  eq("a fractional interval is rounded", normalizeSchedule({ intervalSec: 4.6 }).intervalSec, 5);
  eq("stopOnRefusal can be turned off", normalizeSchedule({ stopOnRefusal: false }).stopOnRefusal, false);
  eq("stopOnRefusal coerces truthy input", normalizeSchedule({ stopOnRefusal: "yes" }).stopOnRefusal, true);

  ok("the description names the interval", describeSchedule({ intervalSec: 6, maxRuns: 8 }).includes("every 6s"));
  ok("the description names the run budget", describeSchedule({ intervalSec: 6, maxRuns: 8 }).includes("up to 8 runs"));
  ok("the description says refusals stop it", /stops on refusal/.test(describeSchedule({})));
  ok("the description says when refusals do not stop it", /keeps going/.test(describeSchedule({ stopOnRefusal: false })));
  eq("one run is not pluralized", describeSchedule({ maxRuns: 1 }).includes("1 runs"), false);
}

// --- 2. what a run's result means -------------------------------------------
console.log("\n  -- classifying a run --");
{
  eq("a policy refusal is a refusal", classifyRun({ blockedByPolicy: true, reasons: [{ code: "daily_cap" }] }), OUTCOME.refused);
  eq("charged without delivery is its own outcome", classifyRun({ ok: false, warning: "charged_without_delivery" }), OUTCOME.charged);
  eq("an endpoint that asked for nothing is free", classifyRun({ ok: true, paid: false, status: 200 }), OUTCOME.free);
  eq("settlement failure is a failure", classifyRun({ ok: false, settled: false }), OUTCOME.failed);
  eq("a paid, settled, delivered run is settled", classifyRun({ ok: true, paid: true, settled: true, delivered: true }), OUTCOME.settled);
  eq("nothing at all is a failure, not a success", classifyRun(null), OUTCOME.failed);
  eq("a refusal outranks a failed settlement flag", classifyRun({ blockedByPolicy: true, settled: false }), OUTCOME.refused);
  eq("the policy codes come through", refusalCodes({ reasons: [{ code: "per_call_max" }, { code: "daily_cap" }] }).join(","), "per_call_max,daily_cap");
  eq("a result with no reasons has no codes", refusalCodes({ ok: true }).length, 0);
}

// --- 3. the run log ----------------------------------------------------------
console.log("\n  -- the run log --");
{
  const settled = makeRun({ index: 1, quoteWei: QUOTE, result: { ok: true, settled: true, via: "relay", status: 200, ms: 700, receipt: { settlementTx: "0xabc" } } });
  eq("a settled run records what moved", settled.movedWei, QUOTE);
  eq("a settled run records its tx", settled.tx, "0xabc");
  eq("a settled run records its path", settled.via, "relay");

  const refused = makeRun({ index: 2, quoteWei: QUOTE, result: { blockedByPolicy: true, error: "refused", reasons: [{ code: "daily_cap", detail: "over cap" }], denial: { txHash: "0xden" } } });
  eq("a refused run moved NOTHING", refused.movedWei, 0n);
  eq("but it still records what was attempted", refused.attemptedWei, QUOTE);
  eq("and why", refused.codes.join(","), "daily_cap");
  eq("and the on-chain denial", refused.denialTx, "0xden");

  // A refusal carries a generic error AND a reason that explains itself. The
  // second is what a user needs; losing it turns "0.005 already spent across 5
  // on-chain receipts" into "payment refused by policy: daily_cap".
  const explained = makeRun({
    index: 3, quoteWei: QUOTE,
    result: {
      blockedByPolicy: true,
      error: "payment refused by policy: daily_cap",
      reasons: [{ code: "daily_cap", detail: "0.001 MUSD would take today's spend to 0.006 MUSD — 0.005 already spent across 5 on-chain receipts" }],
    },
  });
  ok("the explanatory detail wins over the generic error", /already spent across 5 on-chain receipts/.test(explained.detail), explained.detail);
  eq("every reason detail is kept", explained.reasonDetails.length, 1);
  eq("and the code is still there", explained.codes.join(","), "daily_cap");
  eq("a refusal with no reasons falls back to the error", makeRun({ index: 4, result: { blockedByPolicy: true, error: "nope" } }).detail, "nope");

  const thrown = makeRun({ index: 3, quoteWei: QUOTE, error: new Error("gateway unreachable") });
  eq("a thrown error is a failed run", thrown.outcome, OUTCOME.failed);
  eq("the message is kept for the log", thrown.error, "gateway unreachable");
  eq("a failed run moved nothing", thrown.movedWei, 0n);

  const charged = makeRun({ index: 3, quoteWei: QUOTE, result: { ok: false, paid: true, settled: true, warning: "charged_without_delivery" } });
  eq("a charge without delivery still counts as money moved", charged.movedWei, QUOTE);
  const free = makeRun({ index: 4, quoteWei: QUOTE, result: { ok: true, paid: false, status: 200 } });
  eq("but a free endpoint moves nothing", free.movedWei, 0n);
  eq("and is counted as free", summarize([free]).free, 1);
  // A live run caught this: the counters are keyed `charged` while the outcome is
  // `charged_without_delivery`, so indexing by outcome counted nothing at all.
  eq("a charged run is counted as charged", summarize([charged]).charged, 1);
  eq("and its money is in the total", summarize([charged]).movedWei, QUOTE);

  const runs = [settled, refused, thrown];
  const sum = summarize(runs);
  eq("three runs are counted", sum.count, 3);
  eq("one settled", sum.settled, 1);
  eq("one refused", sum.refused, 1);
  eq("one failed", sum.failed, 1);
  eq("only the settled MUSD is counted as moved", sum.movedWei, QUOTE);
  eq("all three are counted as attempted", sum.attemptedWei, QUOTE * 3n);
  eq("the last halt is reported", sum.lastHalt.outcome, OUTCOME.failed);
  eq("a clean log reports no halt", summarize([settled]).lastHalt, null);
  eq("an empty log sums to zero", summarize([]).movedWei, 0n);
  // Every outcome must be named, and named honestly: a refusal is the product
  // working, a charge without delivery is the user losing money.
  ok("every outcome has a label", Object.values(OUTCOME).every((o) => OUTCOME_LABEL[o]),
    Object.values(OUTCOME).filter((o) => !OUTCOME_LABEL[o]).join(","));
  eq("a refusal is not called a failure", OUTCOME_LABEL[OUTCOME.refused], "refused by policy");
  eq("a charge without delivery is not called paid", OUTCOME_LABEL[OUTCOME.charged], "charged, no delivery");
}

// --- 4. when the loop must stop ---------------------------------------------
console.log("\n  -- stopping --");
{
  const S = { intervalSec: 2, maxRuns: 3, stopOnRefusal: true };
  const run = (outcome, over = {}) => ({ index: 1, outcome, codes: [], movedWei: 0n, attemptedWei: QUOTE, ...over });

  eq("an empty log starts at run 1", shouldContinue({ runs: [], schedule: S }).nextIndex, 1);
  ok("an empty log is ready to run", shouldContinue({ runs: [], schedule: S }).run);

  const two = [run(OUTCOME.settled, { index: 1 }), run(OUTCOME.settled, { index: 2 })];
  ok("a settled run continues", shouldContinue({ runs: two, schedule: S }).run);
  eq("and the next index follows the log", shouldContinue({ runs: two, schedule: S }).nextIndex, 3);

  const full = [...two, run(OUTCOME.settled, { index: 3 })];
  eq("the run budget ends the loop", shouldContinue({ runs: full, schedule: S }).reason, "finished");
  ok("the run budget outranks everything else", shouldContinue({ runs: [...two, run(OUTCOME.refused, { index: 3, codes: ["daily_cap"] })], schedule: S }).reason === "finished");

  const refusedLog = [...two.slice(0, 1), run(OUTCOME.refused, { index: 2, codes: ["daily_cap"] })];
  eq("a policy refusal halts by default", shouldContinue({ runs: refusedLog, schedule: S }).reason, "halted_by_policy");
  eq("and names the rule that stopped it", shouldContinue({ runs: refusedLog, schedule: S }).codes.join(","), "daily_cap");
  ok("opting out lets refusals continue", shouldContinue({ runs: refusedLog, schedule: { ...S, stopOnRefusal: false } }).run);

  eq("a hard failure always halts", shouldContinue({ runs: [run(OUTCOME.failed, { error: "boom" })], schedule: { ...S, stopOnRefusal: false } }).reason, "halted_by_error");
  eq("charged-without-delivery halts by default", shouldContinue({ runs: [run(OUTCOME.charged)], schedule: S }).reason, "halted_by_seller");
  eq("a free endpoint is not worth repeating", shouldContinue({ runs: [run(OUTCOME.free)], schedule: S }).reason, "nothing_to_pay");

  // Every reason the loop can end has words a user reads.
  const labels = Object.keys(STOP_REASON_LABEL);
  ok("every stop reason has a label", ["finished", "halted_by_policy", "halted_by_error", "halted_by_seller", "nothing_to_pay", "ready"].every((r) => labels.includes(r)), labels.join(","));
}

// --- 5. the budget projection: the part a judge reads -----------------------
console.log("\n  -- budget projection --");
{
  eq("no status means no projection", budgetView({ status: null, quoteWei: QUOTE }).available, false);
  eq("and no claim about spend", budgetView({ status: null, quoteWei: QUOTE }).spendKnown, false);

  // THE REGRESSION THIS SECTION EXISTS FOR. The contract's `remainingToday` is
  // funding headroom (dailyCap - dayFunded), not money spent. A projection derived
  // from it predicted a refusal on run 6 while eight live payments of 0.001 MUSD
  // went through a 0.005 MUSD cap untouched. Spend must come from the gateway's
  // receipt sum, and these assertions fail if it is ever read from the contract
  // field again.
  const lying = budgetView({
    status: status({ dailyCap: musd(0.005) }),   // remainingToday = the whole cap
    spentTodayWei: musd(0.005),                  // but the receipts say it is all gone
    quoteWei: QUOTE,
    runsDone: 5,
  });
  eq("an exhausted budget is exhausted even when the contract's funding field says otherwise",
    lying.leftToday, 0n);
  eq("and the next run is refused", lying.nextRefusal?.code, "daily_cap");
  eq("on run 6", lying.nextRefusal?.onRun, 6);
  eq("the contract's funding headroom is reported separately, not spent",
    lying.fundingHeadroomToday, musd(0.005));

  // Spend not read yet: unknown is not zero.
  const unknown = budgetView({ status: status(), spentTodayWei: null, quoteWei: QUOTE, runsDone: 0 });
  eq("unread spend is flagged as unknown", unknown.spendKnown, false);
  eq("no run projection is invented", unknown.runsLeft, null);
  eq("no refusal is invented", unknown.nextRefusal, null);
  eq("no gauge percentage is invented", unknown.dailyPct, null);
  ok("but the per-call max is still judged without spend", unknown.perCallOk === true);
  eq("and an over-large quote is still refused", budgetView({
    status: status({ perCallMax: musd(0.0005) }), spentTodayWei: null, quoteWei: QUOTE, runsDone: 0,
  }).nextRefusal?.code, "per_call_max");

  const fresh = budgetView({ status: status(), spentTodayWei: "0", quoteWei: QUOTE, runsDone: 0 });
  eq("nothing spent yet", fresh.spentToday, 0n);
  eq("the full cap is available", fresh.leftToday, musd(10));
  // 10 MUSD / 0.001 MUSD = ten thousand payments. The demo agent's cap is far too
  // generous to bite in a three-minute video, which is why the walkthrough lowers
  // it first — that scenario is pinned below.
  eq("ten thousand 0.001 runs fit in a 10 MUSD cap", fresh.runsLeft, 10000n);
  eq("so run 10001 is the one the cap refuses", fresh.capHitsOnRun, 10001);
  eq("the binding rule is the daily cap", fresh.binding, "daily_cap");
  eq("the gauge starts empty", fresh.dailyPct, 0);

  // What the loop does mid-session: the gateway's figure was read before the runs
  // started, so the log's own total is added on top — no double count, no lag.
  const midLoop = budgetView({
    status: status({ dailyCap: musd(0.005) }),
    spentTodayWei: musd(0.002),   // read when the quote was taken
    sessionWei: musd(0.002),      // two runs have settled since
    quoteWei: QUOTE,
    runsDone: 2,
  });
  eq("the session's own spend is added to the gateway's figure", midLoop.spentToday, musd(0.004));
  eq("one run still fits", midLoop.runsLeft, 1n);
  eq("and the refusal lands on run 4 of this session", midLoop.capHitsOnRun, 4);
  ok("the gauge is 80% full", midLoop.dailyPct === 80, `${midLoop.dailyPct}%`);

  const empty = budgetView({ status: status({ dailyCap: musd(0.005) }), spentTodayWei: musd(0.005), quoteWei: QUOTE, runsDone: 0 });
  eq("an exhausted cap leaves no runs", empty.runsLeft, 0n);
  eq("the very next run is refused", empty.nextRefusal?.onRun, 1);
  eq("by the daily cap", empty.nextRefusal?.code, "daily_cap");
  eq("the gauge reads 100%", empty.dailyPct, 100);

  // A cap lowered below what has already been spent: the budget is gone, and the
  // arithmetic must saturate instead of going negative.
  const lowered = budgetView({ status: status({ dailyCap: musd(0.005) }), spentTodayWei: musd(0.02), quoteWei: QUOTE, runsDone: 0 });
  eq("overspend saturates the remaining budget at zero", lowered.leftToday, 0n);
  eq("and refuses the next run", lowered.nextRefusal?.onRun, 1);
  ok("the gauge can exceed 100% rather than lie", lowered.dailyPct > 100, `${lowered.dailyPct}%`);

  const tooBig = budgetView({ status: status({ perCallMax: musd(0.0005) }), spentTodayWei: "0", quoteWei: QUOTE, runsDone: 0 });
  ok("a quote over the per-call max is flagged", !tooBig.perCallOk);
  eq("the binding rule is the per-call max", tooBig.binding, "per_call_max");

  const broke = budgetView({ status: status({ walletBalance: QUOTE }), spentTodayWei: "0", quoteWei: QUOTE, runsDone: 0 });
  eq("one run's worth of float allows exactly one run", broke.runsLeft, 1n);
  eq("and the balance is the binding rule", broke.binding, "insufficient_float");

  const noQuote = budgetView({ status: status(), spentTodayWei: "0", quoteWei: null, runsDone: 0 });
  eq("no quote yet means no run projection", noQuote.runsLeft, null);
  eq("and no refusal predicted", noQuote.nextRefusal, null);
  ok("a zero quote never divides by zero", budgetView({ status: status(), spentTodayWei: "0", quoteWei: 0n }).runsLeft === null);

  const zeroCap = budgetView({ status: status({ dailyCap: 0n }), spentTodayWei: "0", quoteWei: QUOTE, runsDone: 0 });
  // 0 spent of a 0 cap is not 0% (that reads as headroom) and not 100% (nothing
  // was spent). No percentage is honest here, so there is none — the refusal below
  // is what carries the information.
  eq("a zero cap invents no gauge percentage", zeroCap.dailyPct, null);
  eq("and refuses the next run", zeroCap.nextRefusal?.code, "daily_cap");

  // THE DEMO SCENARIO, pinned: a user lowers their own daily cap to 0.005 MUSD on
  // the Operate page, then runs the automation. Five payments settle and the sixth
  // is refused — the whole product in one screen.
  const demo = budgetView({ status: status({ dailyCap: musd(0.005), walletBalance: musd(10) }), spentTodayWei: "0", quoteWei: QUOTE, runsDone: 0 });
  eq("a 0.005 MUSD cap allows five 0.001 runs", demo.runsLeft, 5n);
  eq("and refuses the sixth", demo.capHitsOnRun, 6);
  eq("on the daily cap", demo.binding, "daily_cap");
}


// ---------------------------------------------------------------------------
// The five-step flow indicator.
//
// The stepper is the one part of the Spend page that tells a judge WHERE a
// purchase is, rather than what it costs. Two of its claims are worth pinning
// because both are easy to get wrong and both misdirect a user:
//   • a refusal must land on the step that produced it, and
//   • the steps after it must stay unreached, not "done".
// ---------------------------------------------------------------------------

console.log("\n  the five-step flow indicator");
{
  eq("the flow has five stages", FLOW.length, 5);
  eq("starting with the request", FLOW[0].id, "request");
  eq("and ending with settlement", FLOW[4].id, "settle");
  eq("policy sits between the price and the signature", FLOW[2].id, "policy");

  const states = (r) => r.steps.map((s) => s.state).join(",");

  const idle = flowStep({});
  eq("nothing happening yet means nothing reached", idle.verdict, "idle");
  eq("no step is current", idle.at, null);
  ok("every step is still to do", states(idle) === Array(5).fill(STEP_STATE.todo).join(","), states(idle));

  const quoting = flowStep({ busy: "quote" });
  eq("quoting is the first step, in flight", quoting.verdict, "quoting");
  eq("and it is the current one", quoting.at, 0);
  eq("step one is active", quoting.steps[0].state, STEP_STATE.active);

  const priced = flowStep({ quote: { status: 402 }, policy: { allowed: true } });
  eq("an allowed quote reports the price was accepted", priced.verdict, "allowed");
  eq("the eye lands on the signature step", priced.at, 3);
  // Written as three separate assertions rather than one slice-and-compare: the
  // first version of this line was a reduce() over string lengths, which "passed"
  // for the wrong reason and told nobody anything.
  eq("the request step is behind us", priced.steps[0].state, STEP_STATE.done);
  eq("so is the 402", priced.steps[1].state, STEP_STATE.done);
  eq("and so is policy", priced.steps[2].state, STEP_STATE.done);
  eq("the signature is what is next", priced.steps[3].state, STEP_STATE.active);
  eq("and settlement has not happened", priced.steps[4].state, STEP_STATE.todo);

  // A quote with NO policy verdict is still progress, but must not claim the
  // policy has ruled — it has not been asked.
  eq("a quote with no verdict says 'quoted', not 'allowed'", flowStep({ quote: { status: 402 } }).verdict, "quoted");

  eq("signing marks step four active", flowStep({ busy: "signing" }).at, 3);
  eq("settling marks step five active", flowStep({ busy: "settling" }).at, 4);

  const settled = flowStep({ result: { ok: true, settled: true, paid: true } });
  eq("a settled payment completes the flow", settled.verdict, "settled");
  ok("all five done", states(settled) === Array(5).fill(STEP_STATE.done).join(","), states(settled));

  // --- where a refusal lands -------------------------------------------------
  const capRefusal = flowStep({ result: { blockedByPolicy: true, reasons: [{ code: "daily_cap" }] } });
  eq("a cap refusal is named as a refusal, not a failure", capRefusal.verdict, "refused");
  eq("and it lands on the POLICY step", capRefusal.steps[2].state, STEP_STATE.refused);
  eq("with the two steps before it done", capRefusal.steps[1].state, STEP_STATE.done);
  // This is the claim that matters: a stepper showing "signature done" for a
  // payment that was never signed tells the user the wrong thing happened.
  eq("the signature step was never reached", capRefusal.steps[3].state, STEP_STATE.todo);
  eq("nor was settlement", capRefusal.steps[4].state, STEP_STATE.todo);
  eq("the current step is the refused one", capRefusal.at, 2);
  eq("and the code is carried for the caption", capRefusal.codes[0], "daily_cap");

  // permit2_not_approved is the one refusal that is NOT the policy's fault: the
  // budget is fine, the wallet has not granted the allowance. Pointing at step 3
  // would send the user to change a cap that was never the problem.
  const permit2 = flowStep({ result: { blockedByPolicy: true, reasons: [{ code: "permit2_not_approved" }] } });
  eq("a missing approval lands on the SIGNATURE step", permit2.steps[3].state, STEP_STATE.refused);
  eq("with policy having passed", permit2.steps[2].state, STEP_STATE.done);
  eq("and it is the current step", permit2.at, 3);
  eq("an unknown refusal code still lands somewhere sane", flowStep({ result: { blockedByPolicy: true, reasons: [{ code: "something_new" }] } }).at, 2);
  eq("a refusal with no reasons at all does not throw", flowStep({ result: { blockedByPolicy: true } }).verdict, "refused");

  // --- the two outcomes that are neither success nor refusal -----------------
  const charged = flowStep({ result: { warning: "charged_without_delivery", ok: true } });
  eq("charged-without-delivery is its own verdict", charged.verdict, "charged_without_delivery");
  eq("the money moved, so the signature happened", charged.steps[3].state, STEP_STATE.done);
  // NOT done: the seller took the MUSD and sent nothing. A green tick here would
  // be the stepper telling the user a loss was a purchase.
  eq("but settlement is marked FAILED, not done", charged.steps[4].state, STEP_STATE.failed);

  const free = flowStep({ result: { paid: false, ok: true, status: 200 } });
  eq("a free endpoint is named as free", free.verdict, "free");
  eq("the request happened", free.steps[0].state, STEP_STATE.done);
  eq("and the 402 was answered", free.steps[1].state, STEP_STATE.done);
  // Skipped, not failed and not done: there was nothing to rule on, sign or
  // settle, and a red X would read as a broken purchase that actually worked.
  eq("policy was SKIPPED, not failed", free.steps[2].state, STEP_STATE.skipped);
  eq("so was the signature", free.steps[3].state, STEP_STATE.skipped);
  eq("and settlement", free.steps[4].state, STEP_STATE.skipped);
  eq("no step is 'current' on a finished free call", free.at, null);

  const failed = flowStep({ result: { settled: false, ok: false, error: "facilitator down" } });
  eq("a settlement failure is failed, not refused", failed.verdict, "failed");
  eq("and lands on the settle step", failed.steps[4].state, STEP_STATE.failed);

  // A refusal seen in the QUOTE (before anything is signed) must be shown as
  // such — that is the whole point of quoting first.
  const quotedRefusal = flowStep({ quote: { status: 402 }, policy: { allowed: false, reasons: [{ code: "per_call_max" }] } });
  eq("a quote the policy refuses is caught before signing", quotedRefusal.verdict, "refused");
  eq("on the policy step", quotedRefusal.steps[2].state, STEP_STATE.refused);
  eq("and nothing was signed", quotedRefusal.steps[3].state, STEP_STATE.todo);

  // A result outranks a stale busy flag: the newest truth is what the user sees.
  eq("a finished result outranks an in-flight flag", flowStep({ busy: "settling", result: { ok: true, settled: true } }).verdict, "settled");
  eq("and no input at all does not throw", flowStep().verdict, "idle");
  eq("always returns five steps", flowStep({ result: null }).steps.length, 5);
}


// ---------------------------------------------------------------------------
// REFUSAL_STEP: which of the five steps each refusal code belongs to.
//
// REASON_LABEL in src/lib/agent-status.jsx is the list of codes the gateway
// actually emits, and it lives in a .jsx module this suite cannot import (Node
// will not load JSX). The list is therefore mirrored here ON PURPOSE: this test
// is the thing that fails when someone adds a refusal code to the gateway and
// forgets to say which step it belongs to, which would leave the stepper
// pointing at "policy" for a signature problem.
// ---------------------------------------------------------------------------

console.log("\n  refusal codes map to the step that produced them");
{
  const CODES = [
    "per_call_max", "daily_cap", "spend_read_failed", "insufficient_float",
    "permit2_not_approved", "paused", "paused_onchain", "not_registered",
    "agent_inactive", "not_allowlisted", "wrong_asset", "wrong_network",
    "ssrf_blocked", "bad_protocol", "dns_failed", "payer_mismatch",
    "no_agent_key", "no_agent", "charged_without_delivery",
  ];
  // Derived from FLOW, not a literal list: hardcoded here, this test would keep
  // passing after a stage was renamed — the exact drift it exists to catch.
  const STEP_IDS = FLOW.map((s) => s.id);

  let unmapped = 0;
  for (const code of CODES) {
    const step = REFUSAL_STEP[code];
    if (!step || !STEP_IDS.includes(step)) {
      unmapped++;
      eq(`"${code}" maps to a real step`, Boolean(step) && STEP_IDS.includes(step), true);
    }
  }
  eq(`all ${CODES.length} gateway refusal codes map to a step`, unmapped, 0);

  // The two that would misdirect a user if they were wrong.
  eq("a missing Permit2 approval is a SIGNATURE problem, not policy", REFUSAL_STEP.permit2_not_approved, "signature");
  eq("a payment signed by the wrong wallet is a SIGNATURE problem", REFUSAL_STEP.payer_mismatch, "signature");
  eq("an internal address is refused at the REQUEST step", REFUSAL_STEP.ssrf_blocked, "request");
  eq("a non-https seller too", REFUSAL_STEP.bad_protocol, "request");
  eq("an overspend is the POLICY step", REFUSAL_STEP.daily_cap, "policy");
  eq("and so is the per-call max", REFUSAL_STEP.per_call_max, "policy");
  eq("charged-without-delivery is the SETTLE step", REFUSAL_STEP.charged_without_delivery, "settle");

  // flowStep() must survive a code it has never heard of — the gateway adds
  // codes, and a stepper that throws on a new one takes the Spend page down.
  const novel = flowStep({ result: { blockedByPolicy: true, reasons: [{ code: "brand_new_rule" }] } });
  eq("an unknown code falls back to the policy step", novel.steps[2].state, STEP_STATE.refused);
  eq("and the flow still reports a refusal", novel.verdict, "refused");
}

console.log(`\n${failures ? `❌ ${failures}/${count} failed` : `✅ all ${count} assertions passed`}\n`);
process.exit(failures ? 1 : 0);
