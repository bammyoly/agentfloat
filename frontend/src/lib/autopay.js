// ---------------------------------------------------------------------------
// autopay — the state machine behind "run this purchase automatically".
//
// WHY THIS IS NOT IN THE PAGE
//   The interesting part of automated spending is not the timer. It is the
//   arithmetic that tells a user what is ABOUT to happen and why it stopped:
//   which run the daily cap bites on, whether the quote already exceeds the
//   per-call max before a single signature exists, and how much really moved.
//   Those are pure functions over on-chain numbers, so they are testable with no
//   browser, no wallet and no chain — see scripts/test-autopay.mjs. Keeping them
//   out of Spend.jsx also means the page cannot drift from the rules it displays.
//
// WHOSE NUMBERS THESE ARE
//   `status` is the treasury's AgentStatus for the wallet that will SIGN: the
//   user's own agent, or the gateway's demo agent. From it come the CAPS
//   (perCallMax, dailyCap) and the balance — the same on-chain values the gateway
//   enforces against.
//
//   Today's SPEND does not come from there. The contract's `remainingToday` is
//   `dailyCap - dayFunded`, and dayFunded only moves in fundAgent(): it is how much
//   more FLOAT the treasury may release today, not what the agent has spent. Spend
//   arrives as `spentTodayWei`, summed by the gateway from the treasury's own
//   payment receipts (server/spend.js). Predicting from the funding counter is the
//   bug that let eight live payments through a five-payment cap.
//
// ALL AMOUNTS ARE WEI BIGINTS. Never a float, never a formatted string: 0.001
// MUSD is 1000000000000000n and dividing that as a Number loses the exactness
// the caps are enforced with. Display formatting belongs to fmtMusd() at the edge.
//
// ONE DELIBERATE LIMIT: this schedules repeats of ONE purchase. It is not a
// cron, not a subscription and not a standing allowance — every run is a real
// payment, individually signed and individually checked against policy, which is
// the point of the demonstration.
// ---------------------------------------------------------------------------

/** What the schedule defaults to before the user touches anything. */
export const DEFAULT_SCHEDULE = Object.freeze({
  intervalSec: 6,
  maxRuns: 8,
  stopOnRefusal: true,
});

/** Hard bounds. A typo must not be able to start a loop that hammers a seller. */
export const LIMITS = Object.freeze({
  intervalSec: { min: 2, max: 600 },
  maxRuns: { min: 1, max: 200 },
});

/** How a single run ended, in the page's own words. */
export const OUTCOME = Object.freeze({
  settled: "settled",
  refused: "refused",
  charged: "charged_without_delivery",
  failed: "failed",
  free: "free",
});

/**
 * What each outcome is called on screen. Kept here rather than in the page because
 * these are claims about money: "refused" must never be rendered as "failed" (the
 * product worked) and "charged without delivery" must never be rendered as "paid"
 * (the user lost MUSD and got nothing).
 */
export const OUTCOME_LABEL = Object.freeze({
  settled: "settled",
  refused: "refused by policy",
  charged_without_delivery: "charged, no delivery",
  failed: "failed",
  free: "no payment needed",
});

function clampInt(value, fallback, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Sanitize user input into a schedule that is safe to run.
 *
 * Every field is clamped, and a missing or nonsense value falls back to the
 * default rather than to zero: an interval of 0 would be a tight loop against a
 * live seller, and maxRuns of Infinity would be an unbounded spend.
 */
export function normalizeSchedule(input = {}) {
  return {
    intervalSec: clampInt(input.intervalSec, DEFAULT_SCHEDULE.intervalSec, LIMITS.intervalSec),
    maxRuns: clampInt(input.maxRuns, DEFAULT_SCHEDULE.maxRuns, LIMITS.maxRuns),
    stopOnRefusal: input.stopOnRefusal === undefined ? DEFAULT_SCHEDULE.stopOnRefusal : Boolean(input.stopOnRefusal),
  };
}

/** Human-readable form of a schedule, for the button and the panel header. */
export function describeSchedule(s = DEFAULT_SCHEDULE) {
  const { intervalSec, maxRuns, stopOnRefusal } = normalizeSchedule(s);
  return `every ${intervalSec}s · up to ${maxRuns} run${maxRuns === 1 ? "" : "s"}` +
    (stopOnRefusal ? " · stops on refusal" : " · keeps going after refusals");
}

/**
 * Classify a gateway/browser payment result.
 *
 * Order matters and mirrors ResultView: a policy refusal is not a failure (it is
 * the product working), and `charged_without_delivery` is not a success (money
 * moved and nothing came back), so neither may be folded into ok/!ok.
 */
export function classifyRun(result) {
  if (!result) return OUTCOME.failed;
  if (result.blockedByPolicy) return OUTCOME.refused;
  if (result.warning === "charged_without_delivery") return OUTCOME.charged;
  if (result.paid === false) return OUTCOME.free;
  if (result.settled === false) return OUTCOME.failed;
  return result.ok ? OUTCOME.settled : OUTCOME.failed;
}

/** The policy codes that stopped a run — the words the judge should see. */
export function refusalCodes(result) {
  return (result?.reasons || []).map((r) => r?.code).filter(Boolean);
}

/**
 * Turn one payment attempt into one row of the run log.
 *
 * `movedWei` is deliberately NOT the quote for a refused run: a refusal moves
 * nothing, and showing the attempted amount as spent would overstate the damage
 * in exactly the situation where the user is worried about damage.
 */
export function makeRun({ index, quoteWei = null, result = null, error = null, at = Date.now(), ms = null }) {
  const outcome = error ? OUTCOME.failed : classifyRun(result);
  // Only a settlement moves MUSD. `charged_without_delivery` counts because the
  // charge is real even though nothing came back; a FREE endpoint counts as nothing
  // moved, because no payment was made at all.
  const moved = outcome === OUTCOME.settled || outcome === OUTCOME.charged;
  const receipt = result?.receipt || {};
  return {
    index,
    at,
    ms: ms ?? result?.ms ?? null,
    outcome,
    attemptedWei: quoteWei === null || quoteWei === undefined ? null : BigInt(quoteWei),
    movedWei: moved && quoteWei != null ? BigInt(quoteWei) : 0n,
    codes: refusalCodes(result),
    // A refusal arrives with BOTH a generic `error` ("payment refused by policy:
    // daily_cap") and a `reasons[].detail` that says what was counted ("...0.005
    // already spent across 5 on-chain receipts"). The second is the one worth
    // putting in front of a user, so it wins.
    detail: (result?.reasons || []).map((r) => r?.detail).filter(Boolean)[0] || result?.error || null,
    reasonDetails: (result?.reasons || []).map((r) => r?.detail).filter(Boolean),
    status: result?.status ?? null,
    via: result?.via || null,
    tx: receipt.settlementTx || receipt.txHash || null,
    denialTx: result?.denial?.txHash || null,
    error: error ? String(error?.message || error) : null,
  };
}

/** Outcome → the counter it belongs to. */
const COUNT_KEY = Object.freeze({
  settled: "settled",
  refused: "refused",
  charged_without_delivery: "charged",
  failed: "failed",
  free: "free",
});

/**
 * Totals across a run log. BigInt wei in, BigInt wei out.
 *
 * The counters are keyed by short names while OUTCOME uses the protocol's own
 * `charged_without_delivery`, so the mapping is explicit: indexing the totals
 * object with the outcome directly silently counted nothing, and a live run showed
 * the panel reporting "0 charged without delivery" for a run that had been.
 */
export function summarize(runs = []) {
  const out = {
    count: runs.length,
    settled: 0, refused: 0, charged: 0, failed: 0, free: 0,
    movedWei: 0n, attemptedWei: 0n,
    lastHalt: null,
  };
  for (const r of runs) {
    const key = COUNT_KEY[r.outcome];
    if (key) out[key] += 1;
    out.movedWei += BigInt(r.movedWei || 0n);
    if (r.attemptedWei != null) out.attemptedWei += BigInt(r.attemptedWei);
  }
  const last = runs[runs.length - 1];
  if (last && last.outcome !== OUTCOME.settled && last.outcome !== OUTCOME.free) {
    out.lastHalt = { index: last.index, outcome: last.outcome, codes: last.codes, detail: last.detail || last.error };
  }
  return out;
}

/**
 * Should the loop go again?
 *
 * The answer is derived from the log, never from a counter kept in a ref, so the
 * same function decides in the UI ("Start" vs "Stop" vs "Finished") and in the
 * effect that arms the next timer. Two sources of truth here is how a loop ends
 * up running forever.
 *
 * Stopping rules, in order:
 *   - the run budget is used up            → finished
 *   - a hard failure (network, seller 5xx) → halted_by_error, always
 *   - the endpoint needed no payment       → nothing_to_pay, always
 *   - a policy refusal, if stopOnRefusal   → halted_by_policy
 *   - charged without delivery, if stopping → halted_by_seller
 * A policy refusal with stopOnRefusal OFF continues: that is the mode for
 * demonstrating a cap repeatedly, and it is opt-in.
 */
export function shouldContinue({ runs = [], schedule = DEFAULT_SCHEDULE }) {
  const s = normalizeSchedule(schedule);
  if (runs.length >= s.maxRuns) return { run: false, reason: "finished" };
  const last = runs[runs.length - 1];
  if (!last) return { run: true, reason: "ready", nextIndex: 1 };
  if (last.outcome === OUTCOME.failed) return { run: false, reason: "halted_by_error", index: last.index, detail: last.error || last.detail };
  if (last.outcome === OUTCOME.free) return { run: false, reason: "nothing_to_pay", index: last.index };
  if (last.outcome === OUTCOME.refused && s.stopOnRefusal) {
    return { run: false, reason: "halted_by_policy", index: last.index, codes: last.codes };
  }
  if (last.outcome === OUTCOME.charged && s.stopOnRefusal) {
    return { run: false, reason: "halted_by_seller", index: last.index };
  }
  return { run: true, reason: "ready", nextIndex: last.index + 1 };
}

/** Plain-language verdict for the panel, from a shouldContinue() answer. */
export const STOP_REASON_LABEL = Object.freeze({
  finished: "run budget used up",
  halted_by_policy: "stopped by your own budget policy",
  halted_by_error: "stopped after a failed run",
  halted_by_seller: "stopped — the seller charged without delivering",
  nothing_to_pay: "stopped — that endpoint asked for nothing",
  ready: "running",
});

/**
 * What the paying wallet's budget means for THIS quote.
 *
 * This is the part a judge should read before the loop starts: it says whether the
 * purchase is allowed at all, how many runs will settle, and which run the cap will
 * refuse.
 *
 * TWO SOURCES, AND MIXING THEM UP IS THE BUG THIS GUARDS AGAINST
 *   `status` is the treasury's AgentStatus: the CAPS (perCallMax, dailyCap) and the
 *   wallet balance, all on-chain.
 *   `spentTodayWei` is what the agent has SPENT today, which the gateway sums from
 *   the treasury's own payment receipts (server/spend.js). It is NOT
 *   `status.remainingToday` — that is `dailyCap - dayFunded`, i.e. how much more
 *   FLOAT the treasury may release today. Deriving spend from it produced a panel
 *   that predicted a refusal on run 6 while eight live payments sailed through.
 *   `sessionWei` adds what this page's own loop has moved since that figure was
 *   read, so the projection stays live mid-run without double-counting.
 *
 * @param status        treasury AgentStatus for the wallet that will sign (or null)
 * @param spentTodayWei today's spend per the gateway; null means "not read yet"
 * @param sessionWei    MUSD this session has moved since that figure was read
 * @param quoteWei      the seller's quoted price, in wei
 * @param runsDone      runs already in this session's log
 */
export function budgetView({ status = null, spentTodayWei = null, sessionWei = 0n, quoteWei = null, runsDone = 0 } = {}) {
  if (!status) return { available: false, spendKnown: false };

  const perCallMax = BigInt(status.perCallMax ?? 0n);
  const dailyCap = BigInt(status.dailyCap ?? 0n);
  const walletBalance = BigInt(status.walletBalance ?? 0n);
  const q = quoteWei === null || quoteWei === undefined ? 0n : BigInt(quoteWei);

  // Unknown spend is not zero spend. The per-call max can still be judged, but the
  // cap projection cannot, and the panel must say so instead of inventing a number.
  const spendKnown = spentTodayWei !== null && spentTodayWei !== undefined;
  const spentToday = spendKnown ? BigInt(spentTodayWei) + BigInt(sessionWei || 0n) : null;
  const leftToday = spendKnown ? (dailyCap > spentToday ? dailyCap - spentToday : 0n) : null;

  const perCallOk = q > 0n ? q <= perCallMax : true;
  // A zero quote means "nothing to buy": do not divide by it.
  const untilCap = q > 0n && leftToday !== null ? leftToday / q : null;
  const untilBroke = q > 0n ? walletBalance / q : null;
  const runsLeft = untilCap === null
    ? null
    : (untilBroke !== null && untilBroke < untilCap ? untilBroke : untilCap);
  const binding = !perCallOk
    ? "per_call_max"
    : untilBroke !== null && untilCap !== null && untilBroke < untilCap
      ? "insufficient_float"
      : "daily_cap";

  let nextRefusal = null;
  if (!perCallOk) nextRefusal = { code: "per_call_max", onRun: runsDone + 1 };
  else if (runsLeft !== null && runsLeft === 0n) nextRefusal = { code: binding, onRun: runsDone + 1 };

  // Which run of THIS session the budget refuses, 1-based. Spelled out as a chain
  // rather than a ternary because the three cases are genuinely different: refused
  // already, refused next, or refused after `runsLeft` more settle.
  let capHitsOnRun = null;
  if (nextRefusal) capHitsOnRun = nextRefusal.onRun;
  else if (runsLeft !== null) capHitsOnRun = runsDone + Number(runsLeft) + 1;

  return {
    available: true,
    spendKnown,
    perCallMax, dailyCap, walletBalance, quoteWei: q,
    spentToday, leftToday,
    // What the contract's remainingToday really is, kept separate and named for
    // what it is so no label calls it money the agent may still spend.
    fundingHeadroomToday: BigInt(status.remainingToday ?? 0n),
    perCallOk,
    runsLeft,
    capHitsOnRun,
    binding,
    nextRefusal,
    dailyPct: spendKnown && dailyCap > 0n ? Number((spentToday * 10000n) / dailyCap) / 100 : null,
  };
}

// ---------------------------------------------------------------------------
// The five-step x402 flow, as DATA.
//
// The Spend page has always listed the flow in words so a first-time reader knows
// what is about to happen. What it could not do was say WHERE in that flow the
// purchase currently is — which is the difference between a caption and an
// instrument. A judge watching an automated loop needs to see "policy refused this
// run" land on the policy step, and a user whose payment failed on the signature
// step needs to be pointed at the signature step rather than at a wall of prose.
//
// So the flow is a list here, and flowStep() maps the page's real state onto it.
// Pure, offline-tested (scripts/test-autopay.mjs), and it owns the mapping from a
// refusal CODE to the step that produced it — knowledge that belongs with the
// other refusal arithmetic, not scattered through JSX.
// ---------------------------------------------------------------------------

/** One entry per stage of a purchase, in the order they actually happen. */
export const FLOW = Object.freeze([
  { id: "request", label: "agent requests the URL", short: "request" },
  { id: "quote", label: "seller answers 402 with a price", short: "402" },
  { id: "policy", label: "policy rules on the real quote", short: "policy" },
  { id: "signature", label: "permit2 signature from the payer", short: "signature" },
  { id: "settle", label: "settled in MUSD, verified on chain", short: "settled" },
]);

/** The visual states a step can be in. */
export const STEP_STATE = Object.freeze({
  todo: "todo",         // not reached yet
  active: "active",     // happening now
  done: "done",         // succeeded
  refused: "refused",   // stopped here, and stopping is the product working
  failed: "failed",     // stopped here, and something is wrong
  skipped: "skipped",   // did not apply (a free endpoint needs no signature)
});

/**
 * Which step a refusal happened at.
 *
 * `permit2_not_approved` belongs to the SIGNATURE step, not the policy step: the
 * policy is fine with the payment, the wallet has not granted the allowance that
 * lets it settle. Getting this wrong sends the user to fix a budget that was never
 * the problem. Everything else the policy engine emits is genuinely step 3.
 */
export const REFUSAL_STEP = Object.freeze({
  // --- the signature step: the budget was fine, the wallet side was not -------
  // Getting these wrong sends a user to lower a cap that was never the problem.
  permit2_not_approved: "signature",
  payer_mismatch: "signature",

  // --- the request step: the seller was never reached -----------------------
  ssrf_blocked: "request",
  bad_protocol: "request",
  dns_failed: "request",

  // --- the settle step: a signature existed and settlement is what broke ----
  settlement_failed: "settle",
  charged_without_delivery: "settle",

  // --- the quote step: no usable price came back ---------------------------
  quote_failed: "quote",

  // --- everything else is genuinely the policy engine's verdict -------------
  per_call_max: "policy",
  daily_cap: "policy",
  spend_read_failed: "policy",
  insufficient_float: "policy",
  insufficient_funds: "policy",
  not_registered: "policy",
  agent_inactive: "policy",
  paused: "policy",
  paused_onchain: "policy",
  not_allowlisted: "policy",
  wrong_asset: "policy",
  wrong_network: "policy",
  no_agent_key: "policy",
  no_agent: "policy",
});

const indexOfStep = (id) => FLOW.findIndex((s) => s.id === id);
const all = (state) => FLOW.map((s) => ({ ...s, state }));

/**
 * Map the page's state onto the five steps.
 *
 * @param busy    null | "quote" | "signing" | "settling" — the page's own flag
 * @param quote   a quote object exists (the seller has answered 402)
 * @param policy  the gateway's verdict on that quote, if it gave one
 * @param result  the outcome of the most recent purchase, if any
 * @returns {{ steps: Array, at: number|null, verdict: string }}
 *
 * `at` is the index of the step the eye should be on, or null when nothing is in
 * flight — a stepper with no current step is a diagram, and that is the correct
 * thing to show before anyone presses Quote.
 */
export function flowStep({ busy = null, quote = null, policy = null, result = null } = {}) {
  // --- a completed attempt outranks everything: it is the newest truth -------
  if (result) {
    const codes = refusalCodes(result);
    if (result.blockedByPolicy) {
      // Point at the step the refusal actually came from, and leave the steps
      // after it untouched — they were never reached.
      const stepId = REFUSAL_STEP[codes[0]] || "policy";
      const at = Math.max(indexOfStep(stepId), 0);
      const steps = FLOW.map((s, i) => ({
        ...s,
        state: i < at ? STEP_STATE.done : i === at ? STEP_STATE.refused : STEP_STATE.todo,
      }));
      return { steps, at, verdict: "refused", codes };
    }
    if (result.warning === "charged_without_delivery") {
      // The money moved, so every step up to settlement happened. The last one is
      // marked failed because the seller did not deliver — NOT done, because that
      // would tell the user the purchase worked.
      const steps = FLOW.map((s, i) => ({
        ...s,
        state: i < 4 ? STEP_STATE.done : STEP_STATE.failed,
      }));
      return { steps, at: 4, verdict: "charged_without_delivery", codes };
    }
    if (result.paid === false) {
      // A free endpoint: the seller answered without asking for money, so there
      // was nothing to rule on, sign or settle. "Skipped" beats a red X here —
      // this is not a failure.
      const steps = FLOW.map((s, i) => ({
        ...s,
        state: i < 2 ? STEP_STATE.done : STEP_STATE.skipped,
      }));
      return { steps, at: null, verdict: "free", codes };
    }
    if (result.settled === false || result.ok === false) {
      const stepId = REFUSAL_STEP[codes[0]] || "settle";
      const at = Math.max(indexOfStep(stepId), 0);
      const steps = FLOW.map((s, i) => ({
        ...s,
        state: i < at ? STEP_STATE.done : i === at ? STEP_STATE.failed : STEP_STATE.todo,
      }));
      return { steps, at, verdict: "failed", codes };
    }
    return { steps: all(STEP_STATE.done), at: null, verdict: "settled", codes };
  }

  // --- in flight -------------------------------------------------------------
  if (busy === "quote") {
    const steps = FLOW.map((s, i) => ({ ...s, state: i === 0 ? STEP_STATE.active : STEP_STATE.todo }));
    return { steps, at: 0, verdict: "quoting", codes: [] };
  }
  if (busy === "signing") {
    const steps = FLOW.map((s, i) => ({
      ...s, state: i < 3 ? STEP_STATE.done : i === 3 ? STEP_STATE.active : STEP_STATE.todo,
    }));
    return { steps, at: 3, verdict: "signing", codes: [] };
  }
  if (busy === "settling") {
    const steps = FLOW.map((s, i) => ({
      ...s, state: i < 4 ? STEP_STATE.done : STEP_STATE.active,
    }));
    return { steps, at: 4, verdict: "settling", codes: [] };
  }

  // --- a quote on screen, nothing in flight ---------------------------------
  if (policy && policy.allowed === false) {
    const codes = (policy.reasons || []).map((r) => r?.code).filter(Boolean);
    const at = Math.max(indexOfStep(REFUSAL_STEP[codes[0]] || "policy"), 0);
    const steps = FLOW.map((s, i) => ({
      ...s,
      state: i < at ? STEP_STATE.done : i === at ? STEP_STATE.refused : STEP_STATE.todo,
    }));
    return { steps, at, verdict: "refused", codes };
  }
  if (quote) {
    // Priced and allowed: three steps behind us, and the next one is a click away.
    const steps = FLOW.map((s, i) => ({
      ...s, state: i < 3 ? STEP_STATE.done : i === 3 ? STEP_STATE.active : STEP_STATE.todo,
    }));
    return { steps, at: 3, verdict: policy ? "allowed" : "quoted", codes: [] };
  }

  return { steps: all(STEP_STATE.todo), at: null, verdict: "idle", codes: [] };
}
