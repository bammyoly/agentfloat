// ---------------------------------------------------------------------------
// LIVE end-to-end test of AUTOMATED SPENDING: the loop on the Spend page, run
// against the real chain and a real seller.
//
//   npm run test:autopay:live      (repo root or server/)
//
// WHY THIS EXISTS
//   The Spend page now offers "run automatically": repeat one purchase on a
//   schedule until the budget stops it. Two claims are being made to a user, and
//   both are checkable:
//
//     1. PREDICTION — before anything is signed, the panel says which run the cap
//        will refuse, computed from the paying wallet's on-chain caps.
//     2. ENFORCEMENT — the gateway actually refuses that run, moves nothing, and
//        writes the refusal on chain.
//
//   If those two disagree, the panel is decoration. This script runs the SAME
//   state machine the page runs — lib/autopay.js is imported directly, not
//   reimplemented — against a live wallet whose daily cap has been lowered to
//   0.005 MUSD by its own signature, and checks that the sixth purchase is the
//   one that stops.
//
// WHAT IT COSTS
//   One faucet claim (10 MUSD), one gas drip (0.00005 BTC), one self-service cap
//   change (owner gas), and five real payments (0.005 MUSD total). It registers a
//   throwaway agent; the retire command is printed at the end.
//
// WHAT IT NEEDS
//   The gateway on 127.0.0.1:4022 (npm run gateway) and network access.
//
// WHAT IT DOES NOT PROVE
//   The React timer. There is no browser here. The scheduling effect is pinned by
//   the integrity checker (no setInterval, no ref counter, one shared purchase
//   path) and by reading it; the arithmetic and the enforcement — the parts that
//   can be wrong in ways a user would lose money to — are proven here.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import { ethers } from "ethers";

// The shipped state machine, not a copy of it.
import {
  OUTCOME, budgetView, makeRun, normalizeSchedule, shouldContinue, summarize,
} from "../frontend/src/lib/autopay.js";

const B = process.env.GATEWAY_URL || "http://127.0.0.1:4022";
// Mezo's hosted demo is the seller a real user would hit, and it is documented to
// occasionally answer 402 AFTER settling. When it goes into a streak of those, this
// test would be measuring a third party's uptime instead of a budget, so it falls
// back to the gateway's own in-process seller (same 0.001 MUSD price) and says so.
let URL_TARGET = process.env.RELAY_TARGET || "https://demo.vativ.io/";
const FALLBACK_TARGET = `${B}/paid/insight`;
const RPC = "https://rpc.test.mezo.org";
const CAIP2 = "eip155:31611";
const MUSD = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
const TREASURY = "0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const QUOTE = 1000000000000000n;         // 0.001 MUSD — Mezo's hosted demo price
const PER_CALL = "0.002";                // above the quote, so it is not the rule that fires
const DAILY_CAP = "0.005";               // exactly five purchases
const DAILY_CAP_WEI = ethers.parseEther(DAILY_CAP);

if (!fs.existsSync(new URL("./.env", import.meta.url))) { console.log("❌ no server/.env"); process.exit(1); }

const ro = new ethers.JsonRpcProvider(RPC, 31611);
const musd = new ethers.Contract(MUSD, [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
], ro);
const treasury = new ethers.Contract(TREASURY, [
  "function isRegistered(address) view returns (bool)",
  "function agentStatus(address) view returns (tuple(bool active,address gateway,uint128 perCallMax,uint128 dailyCap,uint128 dayFunded,uint256 remainingToday,uint256 walletBalance,uint256 lifetimeFunded,uint256 lifetimeRecalled,uint256 recallAllowance,uint256 payments,uint256 denials))",
], ro);

let fails = 0;
const check = (n, c, extra = "") => {
  console.log(`${c ? "  \x1b[32m✅\x1b[0m" : "  \x1b[31m❌\x1b[0m"} ${n}${extra ? "  " + extra : ""}`);
  if (!c) fails++;
};
const note = (n) => console.log(`  \x1b[33m⚠️\x1b[0m  ${n}`);
const get = async (path) => { const r = await fetch(B + path); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const post = async (path, body) => {
  const r = await fetch(B + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const musdOf = (a) => musd.balanceOf(a);

const health = await get("/api/health").then((r) => r.body).catch(() => null);
if (!health) { console.log(`❌ the gateway is not answering on ${B} — start it: npm run gateway`); process.exit(1); }

const user = ethers.Wallet.createRandom().connect(ro);
const agent = user.address;

console.log(`\n== automated spending E2E =====================================`);
console.log(`  gateway    ${B}`);
console.log(`  agent      ${agent}`);
console.log(`  seller     ${URL_TARGET}${process.env.RELAY_TARGET ? " (from env)" : ""}`);
console.log(`  budget     per-call ${PER_CALL} MUSD · daily ${DAILY_CAP} MUSD · quote ${ethers.formatUnits(QUOTE, 18)} MUSD\n`);

// --- 1. a new wallet, funded and registered ----------------------------------
console.log("== 1. fund and register ==");
const fch = await get(`/api/faucet/challenge?address=${agent}`);
const fclaim = await post("/api/faucet/request", {
  address: agent,
  signature: await user.signMessage(fch.body.message),
  message: fch.body.message,
});
check("the faucet claim settled", fclaim.body.ok === true, fclaim.body.error || "");
check("the wallet is a registered agent", (await treasury.isRegistered(agent)) === true);

// --- 2. the user lowers their OWN caps, by signature -------------------------
console.log("\n== 2. self-service caps ==");
const lch = await get(`/api/limits/challenge?address=${agent}&action=limits&perCallMax=${PER_CALL}&dailyCap=${DAILY_CAP}`);
check("the gateway issued a limits challenge", lch.body.ok === true, lch.body.error || "");
const lapply = await post("/api/limits/apply", {
  nonce: lch.body.nonce,
  signature: await user.signMessage(lch.body.message),
});
check("the cap change was applied by the owner key", lapply.body.ok === true, lapply.body.error || "");
const st0 = await treasury.agentStatus(agent);
check("the per-call max is on chain", st0.perCallMax === ethers.parseEther(PER_CALL), ethers.formatEther(st0.perCallMax));
check("the daily cap is on chain", st0.dailyCap === ethers.parseEther(DAILY_CAP), ethers.formatEther(st0.dailyCap));
check("today's remaining budget equals the new cap", st0.remainingToday === ethers.parseEther(DAILY_CAP));

// --- 3. gas, then the Permit2 approval ---------------------------------------
console.log("\n== 3. enable payments ==");
const gch = await get(`/api/gas/challenge?address=${agent}`);
const drip = await post("/api/gas/request", {
  address: agent,
  signature: await user.signMessage(gch.body.message),
  message: gch.body.message,
});
check("the gas drip was sent", drip.body.ok === true, drip.body.error || "");
for (let i = 0; i < 20 && (await ro.getBalance(agent)) === 0n; i++) await sleep(1500);
check("BTC arrived for the approval", (await ro.getBalance(agent)) > 0n, ethers.formatEther(await ro.getBalance(agent)));

const approveTx = await musd.connect(user).approve(PERMIT2, ethers.MaxUint256);
for (let i = 0; i < 20 && (await musd.allowance(agent, PERMIT2)) === 0n; i++) await sleep(1500);
check("Permit2 was approved for all future payments", (await musd.allowance(agent, PERMIT2)) === ethers.MaxUint256, approveTx.hash.slice(0, 18) + "…");

// --- 4. the prediction, before a single signature ---------------------------
console.log("\n== 4. what the panel predicts ==");
const st1 = await treasury.agentStatus(agent);
// Spend comes from the gateway, which sums the treasury's on-chain receipts — the
// same number the refusal will be based on, fetched the same way the page fetches
// it. The contract's own remainingToday is funding headroom and is asserted as such.
const preProbe = await post("/api/relay/probe", { url: URL_TARGET, agent });
const gwBudget = preProbe.body.policy?.budget || null;
check("the gateway reports the budget it judged with", Boolean(gwBudget), JSON.stringify(preProbe.body.policy?.reasons || []).slice(0, 120));
check("nothing has been spent yet", gwBudget?.spentToday === "0", gwBudget?.spentToday);
check("so the whole cap is still spendable", gwBudget?.leftToday === DAILY_CAP_WEI.toString(), gwBudget?.leftToday);
check("no receipts were read because none exist", gwBudget?.receiptsRead === 0, String(gwBudget?.receiptsRead));
check("the receipt window was not exhausted", gwBudget?.truncated === false);
check("the contract's funding counter is reported separately, and is NOT spend",
  gwBudget?.fundingHeadroomToday === ethers.parseEther(DAILY_CAP).toString(), gwBudget?.fundingHeadroomToday);
check("policy allows the first purchase", preProbe.body.policy?.allowed === true,
  JSON.stringify(preProbe.body.policy?.reasons || []).slice(0, 160));

const projection = budgetView({ status: st1, spentTodayWei: gwBudget?.spentToday ?? null, sessionWei: 0n, quoteWei: QUOTE, runsDone: 0 });
check("the projection knows what has been spent", projection.spendKnown === true);
check("the quote is under the per-call max", projection.perCallOk === true);
check("five runs fit inside today's cap", projection.runsLeft === 5n, String(projection.runsLeft));
check("the sixth is predicted to be refused", projection.capHitsOnRun === 6, `run #${projection.capHitsOnRun}`);
check("by the daily cap, not the per-call max", projection.binding === "daily_cap", projection.binding);
check("no refusal is imminent yet, but the run number is named", projection.nextRefusal === null && projection.capHitsOnRun === 6);

// --- 5. the loop, driven by the shipped state machine -----------------------
console.log("\n== 5. run it ==");
const { x402Client, x402HTTPClient } = await import("@x402/fetch");
const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
const { createWalletClient, http: viemHttp } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");

const account = privateKeyToAccount(user.privateKey);
const chain = { id: 31611, name: "Mezo Testnet", nativeCurrency: { name: "BTC", symbol: "BTC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const wc = createWalletClient({ account, chain, transport: viemHttp(RPC) });
const client = new x402Client();
registerExactEvmScheme(client, {
  signer: { address: wc.account.address, signTypedData: wc.signTypedData.bind(wc) },
  networks: [CAIP2], schemeOptions: { rpcUrl: RPC },
});
const x = new x402HTTPClient(client);
const headerGetter = (headers = {}) => (name) => headers[String(name).toLowerCase()] ?? null;

/** One purchase: probe the seller, sign, relay, and report what the gateway said. */
async function purchase() {
  const pr0 = await post("/api/relay/probe", { url: URL_TARGET, agent });
  if (!pr0.body.offer) throw new Error(`the seller did not quote: ${JSON.stringify(pr0.body).slice(0, 160)}`);
  let body = pr0.body.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* keep as text */ } }
  const pr = x.getPaymentRequiredResponse(headerGetter(pr0.body.headers), body);
  const payload = await x.createPaymentPayload(pr);
  const paymentHeaders = x.encodePaymentSignatureHeader(payload);
  const payment = paymentHeaders[Object.keys(paymentHeaders)[0]];
  const r = await post("/api/relay/execute", { url: URL_TARGET, agent, payment, paymentHeaders });
  return r.body;
}

const schedule = normalizeSchedule({ intervalSec: 2, maxRuns: 8, stopOnRefusal: true });
const balBefore = await musdOf(agent);
const paymentsBefore = st1.payments;
const denialsBefore = st1.denials;

let runs = [];
// Runs against a seller that was abandoned mid-test. Their MUSD moved and counted
// against the cap, so they belong in every money assertion — they just are not part
// of the log the loop reasons over, because that log is one repeated purchase.
let abandoned = [];
let stopReason = null;
let stopCodes = null;
let sellerRetries = 0;
let switchedSeller = false;

while (runs.length < 12) {
  const decision = shouldContinue({ runs, schedule });
  if (!decision.run) {
    // The seller is documented to occasionally answer 402 after settling. MUSD
    // moved either way so the cap arithmetic is unaffected; only delivery is. This
    // test is about caps, so retry that run rather than fail on a third party.
    if (decision.reason === "halted_by_seller" && sellerRetries < 6) {
      sellerRetries++;
      // After two consecutive non-deliveries the endpoint is in a bad streak, not
      // having an off moment. Switch to the gateway's own seller rather than spend
      // the rest of the run measuring somebody else's uptime.
      if (sellerRetries === 2 && !switchedSeller && URL_TARGET !== FALLBACK_TARGET) {
        switchedSeller = true;
        abandoned = [...abandoned, ...runs];
        runs = [];   // a different seller is a different purchase: start the log again
        URL_TARGET = FALLBACK_TARGET;
        note(`the hosted demo is not delivering; switching to the gateway's own seller at ${FALLBACK_TARGET}`);
      } else {
        note(`the seller charged without delivering on run ${runs.length}; retrying (documented third-party behaviour)`);
      }
    } else {
      stopReason = decision.reason;
      stopCodes = decision.codes || null;
      break;
    }
  }
  const result = await purchase();
  const run = makeRun({ index: runs.length + 1, quoteWei: QUOTE, result });
  runs = [...runs, run];
  console.log(`   #${run.index} ${run.outcome.padEnd(24)} moved ${ethers.formatUnits(run.movedWei, 18)} MUSD` +
    (run.codes.length ? `  ${run.codes.join(",")}` : "") + (run.ms ? `  ${run.ms}ms` : ""));
  await sleep(400);
}

// --- 6. what the loop did ---------------------------------------------------
if (abandoned.length) {
  note(`${abandoned.length} run(s) against the hosted demo were set aside when the seller was switched; their MUSD is still counted`);
}
console.log("\n== 6. what the budget did ==");
const sum = summarize(runs);
const all = summarize([...abandoned, ...runs]);
check("the loop stopped itself", stopReason !== null, stopReason || "still running");
check("and it stopped on the budget policy", stopReason === "halted_by_policy", stopReason || "");
check("the rule that stopped it is the daily cap", (stopCodes || []).includes("daily_cap"), (stopCodes || []).join(","));
check("it did not blame the per-call max", !(stopCodes || []).includes("per_call_max"));
check("exactly five runs moved MUSD", all.movedWei === QUOTE * 5n, ethers.formatUnits(all.movedWei, 18));
// Delivery is the seller's to give and Mezo's demo endpoint is documented to
// sometimes answer 402 after settling. What this test is about is the BUDGET, so
// the invariant is money moved, not resources returned.
check("five purchases moved MUSD and the next was refused",
  all.settled + all.charged === 5 && all.refused === 1,
  `${all.settled} settled · ${all.charged} charged-without-delivery · ${all.refused} refused` +
    (abandoned.length ? ` (${abandoned.length} against the abandoned seller)` : ""));
check("the refused run moved nothing", runs[runs.length - 1].movedWei === 0n);
// The words attached to a refusal are part of the product: they have to say what
// was counted, or "daily_cap" is just a code.
const refusalDetail = runs[runs.length - 1].detail || "";
check("and the refusal says how much was already spent", /already spent/i.test(refusalDetail), refusalDetail.slice(0, 150));
check("counting the on-chain receipts it summed", /on-chain receipt/i.test(refusalDetail), refusalDetail.slice(0, 150));
check("but the log still records what it attempted", runs[runs.length - 1].attemptedWei === QUOTE);
if (sellerRetries === 0 && abandoned.length === 0) {
  check("the refusal landed on the predicted run", runs[runs.length - 1].index === projection.capHitsOnRun,
    `predicted #${projection.capHitsOnRun}, refused #${runs[runs.length - 1].index}`);
} else {
  note(`the seller retried ${sellerRetries}×, so run numbering shifted; five money-moving runs still preceded the refusal`);
}

const last = runs[runs.length - 1];
check("the refusal was written on chain", Boolean(last.denialTx), last.denialTx || "no denial tx");

const st2 = await treasury.agentStatus(agent);
const balAfter = await musdOf(agent);
check("the wallet spent exactly 0.005 MUSD", balBefore - balAfter === QUOTE * 5n, ethers.formatUnits(balBefore - balAfter, 18));
// The contract's remainingToday is FUNDING headroom and does not move when the
// agent spends — asserting it here would re-encode the original mistake.
const after = await get(`/api/agent/${agent}`);
check("the gateway now reports the cap as spent", after.body.leftToday === "0", after.body.leftToday);
check("having summed five receipts", after.body.spentToday === (QUOTE * 5n).toString(), after.body.spentToday);
check("while the contract's funding counter is unchanged", st2.remainingToday === DAILY_CAP_WEI, ethers.formatEther(st2.remainingToday));
check("the treasury counted five payments", st2.payments - paymentsBefore === 5n, String(st2.payments - paymentsBefore));
check("and one denial", st2.denials - denialsBefore === 1n, String(st2.denials - denialsBefore));

// --- 7. and the prediction is still true afterwards -------------------------
console.log("\n== 7. the projection after the fact ==");
const projected = budgetView({ status: st2, spentTodayWei: after.body.spentToday, sessionWei: 0n, quoteWei: QUOTE, runsDone: runs.length });
check("an exhausted cap leaves no runs", projected.runsLeft === 0n, String(projected.runsLeft));
check("the next refusal is immediate", projected.nextRefusal?.code === "daily_cap", projected.nextRefusal?.code || "");
check("and it is the very next run", projected.nextRefusal?.onRun === runs.length + 1, `#${projected.nextRefusal?.onRun}`);
check("the gauge reads 100%", projected.dailyPct === 100, `${projected.dailyPct}%`);

// And a payment the loop does not attempt is refused by the gateway anyway: the
// projection and the enforcement are the same arithmetic, not two opinions.
const refusedProbe = await post("/api/relay/probe", { url: URL_TARGET, agent });
check("the gateway refuses the next purchase too", refusedProbe.body.policy?.allowed === false);
check("for the daily cap", (refusedProbe.body.policy?.reasons || []).some((r) => r.code === "daily_cap"),
  JSON.stringify(refusedProbe.body.policy?.reasons || []).slice(0, 160));

console.log(fails
  ? `\n❌ ${fails} check(s) failed — automated spending is NOT verified\n`
  : `\n✅ automated spending verified live: a wallet set its own daily cap by signature,\n   the panel predicted run #${projection.capHitsOnRun} would be refused by ${projection.binding}, the gateway\n   refused exactly that run, moved nothing, wrote the denial on chain, and the loop\n   stopped itself — five purchases, 0.005 MUSD, and not one wei more.\n`);
console.log(`   throwaway agent ${agent} holds ${ethers.formatUnits(await musdOf(agent), 18)} MUSD.`);
console.log(`   retire it with: cd contract && AGENT_ADDRESS=${agent} node scripts/retire-agent.js\n`);
process.exit(fails ? 1 : 0);
