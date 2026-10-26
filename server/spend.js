// ---------------------------------------------------------------------------
// spend — how much an agent has ACTUALLY spent today.
//
// WHY THIS MODULE EXISTS
//   A live test drove eight automated purchases of 0.001 MUSD against an agent
//   whose daily cap had been lowered to 0.005 MUSD, and not one was refused. The
//   wallet lost 0.008 MUSD while the number the policy checked never moved.
//
//   The cause is a name that means two things. The treasury's Agent struct keeps
//   `dayFunded` — "MUSD released so far in dayIndex" — and `agentStatus()` exposes
//   `remainingToday = dailyCap - dayFunded`. That is a cap on FUNDING: how much
//   float the treasury will hand an agent in a day. It is enforced on-chain in
//   fundAgent(), and it is real. But the gateway was comparing a PAYMENT against
//   it, and nothing in the payment path ever touches dayFunded. For an agent whose
//   float arrived by any route other than fundAgent() — the faucet transfers MUSD
//   directly — dayFunded stays 0, remainingToday stays equal to the whole cap, and
//   "daily cap" degenerates into a second per-call max.
//
//   So the daily SPEND cap is enforced here, in the trusted policy layer, which is
//   where this architecture always said per-payment policy lives: the contract
//   bounds custody and funding, the gateway bounds each payment.
//
// WHERE THE NUMBER COMES FROM
//   Not from a local counter. The treasury stores an on-chain receipt for every
//   settled payment (recordPayment) and exposes paymentsByAgent(agent, limit),
//   newest first, each with `amount` in wei and `timestamp` in seconds. Summing the
//   receipts from today's UTC day gives spend that any gateway would agree on, and
//   that survives a restart — a counter in a JSON file would not.
//
// ALL AMOUNTS ARE WEI BIGINTS. res.json() throws on a BigInt, so anything leaving
// the gateway is .toString()'d at the edge.
// ---------------------------------------------------------------------------

const SECONDS_PER_DAY = 86_400;

/**
 * Start of the UTC day containing `nowSec`, in seconds.
 *
 * UTC, not local: the contract's own `_today()` is `block.timestamp / 1 days`, so a
 * gateway in Lagos and a gateway in Berlin must bucket the same receipts into the
 * same day or the cap means something different per timezone.
 */
export function dayStartSec(nowSec) {
  const n = Number(nowSec);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

/**
 * Sum the receipts that belong to today.
 *
 * @param payments  treasury receipts, `{ amount, timestamp }`, newest first
 * @param dayStart  from dayStartSec()
 * @param lookback  the window that was read, so truncation can be detected
 * @returns {{ total: bigint, counted: number, truncated: boolean, oldestSeen: bigint|null }}
 *
 * `truncated` means "every receipt in the window is from today, and the window was
 * full" — so there may be more spending today than this sum shows. The caller
 * decides what to do about that; the honest options are to refuse, or to allow and
 * say the figure is a lower bound. Silently treating a lower bound as exact is how
 * a budget product ends up lying.
 */
export function sumSpentSince(payments = [], { dayStart, lookback = null } = {}) {
  const start = BigInt(dayStart ?? 0);
  const list = Array.isArray(payments) ? payments : [];

  // paymentsByAgent() returns newest first, which lets the scan stop at the first
  // receipt from yesterday. If a caller ever hands over the other order, breaking
  // early would under-count spend — so detect the order and scan everything.
  const newestFirst = list.length < 2
    || BigInt(list[0]?.timestamp ?? 0) >= BigInt(list[list.length - 1]?.timestamp ?? 0);

  let total = 0n;
  let counted = 0;
  let oldestSeen = null;
  for (const p of list) {
    const ts = BigInt(p?.timestamp ?? 0);
    if (ts < start) {
      if (newestFirst) break;
      continue;
    }
    total += BigInt(p?.amount ?? 0);
    counted += 1;
    oldestSeen = oldestSeen === null || ts < oldestSeen ? ts : oldestSeen;
  }

  const windowFull = lookback !== null && list.length >= Number(lookback);
  return { total, counted, truncated: Boolean(windowFull && counted === list.length && list.length > 0), oldestSeen };
}

/**
 * The verdict for one payment against a daily spend cap.
 *
 * Kept separate from the gateway so the arithmetic a judge is shown ("run six will
 * be refused") is the same arithmetic that refuses it — and so both can be tested
 * without a chain.
 *
 * @returns {{ allowed: boolean, projected: bigint, dailyCap: bigint, leftToday: bigint, over: boolean }}
 */
export function judgeDailySpend({ amountWei, spentTodayWei, dailyCapWei, truncated = false }) {
  const amount = BigInt(amountWei ?? 0);
  const spent = BigInt(spentTodayWei ?? 0);
  const cap = BigInt(dailyCapWei ?? 0);
  const projected = spent + amount;
  const leftToday = cap > spent ? cap - spent : 0n;
  return {
    allowed: projected <= cap,
    projected,
    dailyCap: cap,
    spentToday: spent,
    leftToday,
    over: projected > cap,
    // A truncated window can only understate spend, so "allowed" here is provisional.
    provisional: Boolean(truncated) && projected <= cap,
  };
}
