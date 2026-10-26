// ---------------------------------------------------------------------------
// Offline tests for src/lib/permit2.js — the approval a normal user signs so that
// x402 payments can settle at all.
//
//   npm run test:permit2       (also runs inside npm run test:browser)
//
// WHY THESE EXIST
//   The refusal `permit2_not_approved` used to print
//
//       fix with: cd contract && node scripts/grant-permit2.js
//
//   A person who signed in with Google cannot run that. So the remedy moved into
//   the product, and the parts that must not be wrong are small and pure:
//
//     * what "all future payments" means on chain — maxUint256, never a number
//       quietly derived from a quote;
//     * what "this payment only" means — exactly the quoted amount, and a refusal
//       to build an approval for zero;
//     * the calldata — right selector, right spender, right amount, and NO gas
//       fields, because an embedded provider that does not implement one of
//       viem's optional estimation methods would fail before the user ever saw a
//       prompt;
//     * the confirmation — poll the allowance, never `tx.wait()`, which on this
//       RPC hangs for minutes after the transaction has confirmed.
//
//   No browser, no Privy, no chain: a fake EIP-1193 provider records the request
//   and an injected reader stands in for the RPC.
// ---------------------------------------------------------------------------

import { ethers } from "ethers";

import {
  PERMIT2_ADDRESS, UNLIMITED, approvalArgs, approvalData, approvePermit2,
  waitForAllowance, approvalExplainer,
} from "../src/lib/permit2.js";
import { MUSD_ADDRESS } from "../src/contracts/index.js";

let failures = 0;
let count = 0;
const eq = (name, actual, expected) => {
  count++;
  const a = String(actual);
  const e = String(expected);
  if (a === e) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n      expected ${e}\n      actual   ${a}`); }
};
const ok = (name, cond, detail = "") => {
  count++;
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const throws = async (name, fn) => {
  count++;
  try { await fn(); failures++; console.log(`  \x1b[31m✗\x1b[0m ${name} — did not throw`); }
  catch { console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
};

const AGENT = "0x3C0F7989627AdFdcfd8Ccae1ef093a477d9966e5";
const QUOTE = "1000000000000000"; // 0.001 MUSD — Mezo's hosted demo price

/** A Privy-shaped wallet whose provider records every request it is asked for. */
function fakeWallet(address = AGENT, { hash = "0x" + "ab".repeat(32), fail = null } = {}) {
  const calls = [];
  return {
    address,
    calls,
    walletClientType: "privy",
    async getEthereumProvider() {
      return {
        async request({ method, params }) {
          calls.push({ method, params });
          if (fail) throw new Error(fail);
          if (method === "eth_sendTransaction") return hash;
          throw Object.assign(new Error(`unsupported method ${method}`), { code: -32601 });
        },
      };
    },
  };
}

const decode = (data) => {
  const iface = new ethers.Interface(["function approve(address spender, uint256 value) returns (bool)"]);
  return iface.parseTransaction({ data });
};

console.log("\n== the Permit2 approval a user signs =====================================\n");

// --- 1. the two choices ------------------------------------------------------
const unlimited = approvalArgs({ unlimited: true });
eq("unlimited approves the canonical Permit2 spender", unlimited.spender.toLowerCase(), PERMIT2_ADDRESS.toLowerCase());
eq("unlimited means maxUint256, not a number from a quote", unlimited.amount, UNLIMITED);
eq("unlimited is labelled as such", unlimited.label, "unlimited");

const exact = approvalArgs({ unlimited: false, amountWei: QUOTE });
eq("exact approves the quoted amount", exact.amount, QUOTE);
eq("exact is labelled in MUSD", exact.label, "0.001 MUSD");
eq("exact uses the same spender", exact.spender.toLowerCase(), PERMIT2_ADDRESS.toLowerCase());

// A zero-amount approval is the silent version of the relay bug that priced a
// payment at 0: it succeeds on chain and authorizes nothing.
await throws("an exact approval of zero is refused", async () => approvalArgs({ unlimited: false, amountWei: "0" }));
await throws("an exact approval with no amount is refused", async () => approvalArgs({ unlimited: false }));

// --- 2. the calldata ---------------------------------------------------------
const data = approvalData(exact);
ok("calldata starts with the approve(address,uint256) selector", data.startsWith("0x095ea7b3"), data.slice(0, 10));
const parsed = decode(data);
eq("calldata names Permit2 as the spender", parsed.args[0].toLowerCase(), PERMIT2_ADDRESS.toLowerCase());
eq("calldata carries the exact amount", parsed.args[1].toString(), QUOTE);
eq("unlimited calldata carries maxUint256", decode(approvalData(unlimited)).args[1].toString(), UNLIMITED.toString());

// --- 3. sending it -----------------------------------------------------------
const w = fakeWallet();
const sent = await approvePermit2(w, { unlimited: false, amountWei: QUOTE });
eq("one request, and it is eth_sendTransaction", w.calls.length, 1);
eq("the method asked of the provider", w.calls[0].method, "eth_sendTransaction");
eq("the tx is sent from the signed-in wallet", w.calls[0].params[0].from, AGENT);
eq("the tx targets MUSD, not Permit2", w.calls[0].params[0].to.toLowerCase(), MUSD_ADDRESS.toLowerCase());
eq("the tx data is the approval", w.calls[0].params[0].data, data);
eq("no gas fields — the provider fills them", Object.keys(w.calls[0].params[0]).sort().join(","), "data,from,to");
eq("the hash comes back to the caller", sent.hash, "0x" + "ab".repeat(32));
eq("the caller learns what it approved", sent.label, "0.001 MUSD");

// Unlimited, the way the popup's default choice sends it.
const w2 = fakeWallet();
const sent2 = await approvePermit2(w2, { unlimited: true });
eq("the unlimited path also sends exactly one tx", w2.calls.length, 1);
eq("unlimited approves maxUint256", decode(w2.calls[0].params[0].data).args[1].toString(), UNLIMITED.toString());
eq("unlimited reports itself", sent2.unlimited, true);

await throws("a wallet with no provider cannot approve", async () => approvePermit2({ address: AGENT }, { unlimited: true }));
await throws("no wallet at all is refused", async () => approvePermit2(null, { unlimited: true }));

// A rejection must surface as the provider's own error, not as a silent success:
// the popup turns 4001 into "you declined, nothing changed".
const w3 = fakeWallet(AGENT, { fail: "user rejected" });
let rejection = null;
try { await approvePermit2(w3, { unlimited: true }); } catch (e) { rejection = e.message; }
eq("a rejected approval throws", rejection, "user rejected");

// --- 4. confirmation polls the allowance ------------------------------------
// tx.wait() on this RPC can hang for minutes AFTER the tx has confirmed, so the
// thing we wait for is the allowance — which is also what the policy engine reads.
let ticks = 0;
let reads = 0;
const landed = await waitForAllowance({
  agent: AGENT,
  minWei: BigInt(QUOTE),
  intervalMs: 1,
  timeoutMs: 500,
  read: async () => { reads++; return reads < 3 ? 0n : BigInt(QUOTE); },
  onTick: () => { ticks++; },
});
eq("the wait ends when the allowance covers the amount", landed.ok, true);
eq("the wait reports the allowance it saw", landed.allowance.toString(), QUOTE);
ok("it polled rather than trusting one read", reads >= 3, `${reads} reads`);
eq("every poll was reported to the UI", ticks, reads);
eq("it did not time out", landed.timedOut, false);

const unlimitedWait = await waitForAllowance({
  agent: AGENT, minWei: 1n, intervalMs: 1, timeoutMs: 200, read: async () => UNLIMITED,
});
eq("an unlimited approval is confirmed by any non-zero allowance", unlimitedWait.ok, true);

const timedOut = await waitForAllowance({
  agent: AGENT, minWei: BigInt(QUOTE), intervalMs: 5, timeoutMs: 30, read: async () => 0n,
});
eq("a stalled approval times out instead of hanging", timedOut.ok, false);
eq("a timeout says so", timedOut.timedOut, true);
eq("a timeout still reports the last allowance seen", timedOut.allowance.toString(), "0");

const unreadable = await waitForAllowance({
  agent: AGENT, minWei: BigInt(QUOTE), intervalMs: 5, timeoutMs: 30, read: async () => null,
});
eq("a failed read is not treated as approved", unreadable.ok, false);

// The case a mutation run found UNTESTED: an allowance that is non-zero but too
// small. "This payment only" approves exactly the quoted amount, so a wallet
// holding an older, smaller approval must not be reported as ready — that
// distinction is the whole difference between the two scopes the popup offers.
const partial = await waitForAllowance({
  agent: AGENT, minWei: BigInt(QUOTE), intervalMs: 5, timeoutMs: 30, read: async () => BigInt(QUOTE) / 2n,
});
eq("a partial allowance is not treated as approved", partial.ok, false);
eq("a partial allowance times out rather than passing", partial.timedOut, true);
eq("and reports the amount it did see", partial.allowance.toString(), (BigInt(QUOTE) / 2n).toString());

let partialReads = 0;
const topped = await waitForAllowance({
  agent: AGENT, minWei: BigInt(QUOTE), intervalMs: 1, timeoutMs: 500,
  read: async () => { partialReads++; return partialReads < 3 ? BigInt(QUOTE) / 2n : BigInt(QUOTE); },
});
eq("a topped-up allowance ends the wait", topped.ok, true);
ok("it kept polling through the partial reads", partialReads >= 3, `${partialReads} reads`);

// --- 5. the words the popup uses --------------------------------------------
const exU = approvalExplainer({ unlimited: true });
ok("the unlimited option says what it approves", exU.what.includes("any amount"), exU.what);
ok("the unlimited option states what still bounds it", /caps/i.test(exU.detail), exU.detail.slice(0, 80));
ok("the unlimited option is honest about being broadest", Boolean(exU.risk));

const exE = approvalExplainer({ unlimited: false, amountWei: QUOTE });
ok("the exact option names the amount", exE.what.includes("0.001"), exE.what);
ok("the exact option warns you will sign again", /each new amount|one more approval/i.test(exE.detail), exE.detail.slice(0, 90));

console.log(
  `\n${failures ? `❌ ${failures} of ${count} failed` : `✅ all ${count} assertions passed`}\n`
);
process.exit(failures ? 1 : 0);
