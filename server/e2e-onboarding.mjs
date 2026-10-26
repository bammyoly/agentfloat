// ---------------------------------------------------------------------------
// LIVE end-to-end test of ONBOARDING: the path a brand-new user walks, from an
// empty wallet to a settled x402 payment.
//
//   npm run test:onboarding      (from the repo root or from server/)
//
// WHY THIS EXISTS
//   A user hit this exact wall. They signed in with Google, claimed 10 MUSD, set
//   their own caps, pressed Pay — and were refused with `permit2_not_approved`.
//   The wallet on chain read:
//
//       MUSD 10.0 · MUSD→Permit2 allowance 0 · BTC 0.0
//
//   Two things follow from that, and the advice the gateway printed addressed
//   neither:
//
//     1. The approval is a transaction the USER must sign. The remedy on offer was
//        `cd contract && node scripts/grant-permit2.js` — a developer command that
//        needs a checkout and a private key. It is now a popup (see
//        frontend/src/components/ApprovalModal.jsx).
//     2. That transaction needs native gas, and a Privy-created wallet has never
//        held any. So the popup also has to solve gas, or it is a button that
//        fails with a Latin error. Hence the drip in server/gas.js.
//
//   This script walks the whole thing against the live chain so the two halves are
//   proven together: refuse → drip → approve → pay.
//
// WHAT IT COSTS
//   One faucet claim (10 MUSD from the operator's faucet budget, capped), one gas
//   drip (0.00005 BTC from the operator key, reserve-checked), and one real payment
//   (0.001 MUSD to Mezo's hosted demo). It registers a throwaway agent; the retire
//   command is printed at the end.
//
// WHAT IT NEEDS
//   The gateway running on 127.0.0.1:4022 (npm run gateway), GATEWAY_SIGNER_PRIVATE_KEY
//   in server/.env as the treasury owner, and network access.
//
// ONE HONEST LIMIT
//   Step 6 sends the approval with a local key rather than through a browser
//   provider: `eth_sendTransaction` needs the key, which is exactly what a public
//   RPC does not have. The browser transport — the raw provider call, the calldata,
//   the absence of gas fields — is pinned offline by `npm run test:permit2`. What
//   is proven here is the on-chain half: the same calldata, from a wallet in the
//   same state, unblocks a real payment.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import { ethers } from "ethers";

const B = process.env.GATEWAY_URL || "http://127.0.0.1:4022";
const URL_TARGET = process.env.RELAY_TARGET || "https://demo.vativ.io/";
const RPC = "https://rpc.test.mezo.org";
const CAIP2 = "eip155:31611";
const MUSD = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
const TREASURY = "0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const envPath = new URL("./.env", import.meta.url);
if (!fs.existsSync(envPath)) { console.log("❌ no server/.env"); process.exit(1); }
const env = fs.readFileSync(envPath, "utf8");

const ro = new ethers.JsonRpcProvider(RPC, 31611);
const musd = new ethers.Contract(MUSD, [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
], ro);
const treasury = new ethers.Contract(TREASURY, [
  "function isRegistered(address) view returns (bool)",
  "function paymentCount() view returns (uint256)",
], ro);

let fails = 0;
const check = (n, c, extra = "") => {
  console.log(`${c ? "  \x1b[32m✅\x1b[0m" : "  \x1b[31m❌\x1b[0m"} ${n}${extra ? "  " + extra : ""}`);
  if (!c) fails++;
};
// A third party's behaviour, not this app's: reported but not counted as a failure.
let warns = 0;
const warn = (n, extra = "") => {
  warns++;
  console.log(`  \x1b[33m⚠️\x1b[0m  ${n}${extra ? "  " + extra : ""}`);
};
const post = async (path, body) => {
  const r = await fetch(B + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const get = async (path) => {
  const r = await fetch(B + path);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const musdOf = async (a) => Number(ethers.formatUnits(await musd.balanceOf(a), 18));

const health = await get("/api/health").then((r) => r.body).catch(() => null);
if (!health) { console.log(`❌ the gateway is not answering on ${B} — start it: npm run gateway`); process.exit(1); }

// A brand-new user: a wallet nobody has ever funded.
const newUser = ethers.Wallet.createRandom().connect(ro);
const agent = newUser.address;

console.log(`\n== onboarding E2E ==========================================`);
console.log(`  gateway    ${B}`);
console.log(`  new user   ${agent}`);
console.log(`  seller     ${URL_TARGET}\n`);

// --- 1. the state a new user actually starts in ------------------------------
console.log("== 1. a brand-new wallet ==");
check("it holds no MUSD", (await musdOf(agent)) === 0, `${await musdOf(agent)} MUSD`);
check("it holds no BTC for gas", ethers.formatEther(await ro.getBalance(agent)) === "0.0");
check("it is not registered", (await treasury.isRegistered(agent)) === false);
check("it has not approved Permit2", (await musd.allowance(agent, PERMIT2)) === 0n);

// --- 2. claim from the faucet (nonce + signature, as the app does) ------------
console.log("\n== 2. claim 10 MUSD ==");
const fch = await get(`/api/faucet/challenge?address=${agent}`);
check("the faucet issued a challenge", fch.body.ok === true, fch.body.error || "");
const fsig = await newUser.signMessage(fch.body.message);
const fclaim = await post("/api/faucet/request", { address: agent, signature: fsig, message: fch.body.message });
check("the claim was accepted", fclaim.body.ok === true, fclaim.body.error || "");
check("MUSD arrived", (await musdOf(agent)) > 0, `${await musdOf(agent)} MUSD`);
check("the claim registered the wallet as an agent", (await treasury.isRegistered(agent)) === true);

// --- 3. the refusal the user actually saw ------------------------------------
console.log("\n== 3. paying before approving — the dead end ==");
const probe = await post("/api/relay/probe", { url: URL_TARGET, agent });
check("the seller still quotes 0.001 MUSD", probe.body.offer?.amount === "1000000000000000",
  JSON.stringify(probe.body.offer || probe.body.error).slice(0, 120));
check("policy refuses it for the missing approval", probe.body.policy?.allowed === false);
const reason = (probe.body.policy?.reasons || []).find((r) => r.code === "permit2_not_approved");
check("the reason is permit2_not_approved", Boolean(reason), JSON.stringify(probe.body.policy?.reasons || []).slice(0, 160));
// The advice attached to this refusal is the thing the user actually reads, so it
// is asserted like any other output: no developer command, and a route into the app.
const reasonText = JSON.stringify(reason || {});
check("the refusal no longer tells a user to run a script", !/grant-permit2\.js/.test(reason?.detail || ""), (reason?.detail || "").slice(0, 110));
check("the refusal points at the app instead", /Enable payments/i.test(reasonText), (reason?.hint || "").slice(0, 110));

// --- 4. gas: the half nobody mentions ----------------------------------------
console.log("\n== 4. request gas ==");
const gst = await get(`/api/gas/status?address=${agent}`);
check("the gateway sees a wallet that needs gas", gst.body.ok === true && gst.body.needsGas === true,
  JSON.stringify({ ok: gst.body.ok, needsGas: gst.body.needsGas, balance: gst.body.balanceBtc }));
check("it estimates what the approval costs", typeof gst.body.estimate?.costBtc === "number",
  `${gst.body.estimate?.costBtc} BTC`);
check("the drip is available to it", gst.body.claim?.eligible === true, gst.body.claim?.reason || "");

const gch = await get(`/api/gas/challenge?address=${agent}`);
check("the gateway issued a gas challenge", gch.body.ok === true, gch.body.error || "");
const gsig = await newUser.signMessage(gch.body.message);

// A signature from somebody else must not be able to fund an address it does not
// control — the same rule the faucet enforces.
const impostor = ethers.Wallet.createRandom();
const badSig = await impostor.signMessage(gch.body.message);
const forged = await post("/api/gas/request", { address: agent, signature: badSig, message: gch.body.message });
check("a signature from another wallet is refused", forged.status === 403, `HTTP ${forged.status} ${forged.body.error || ""}`);

// The forged attempt burned nothing, but the nonce was consumed by the refusal
// path only if it matched — request a fresh one either way, as the UI does.
const gch2 = await get(`/api/gas/challenge?address=${agent}`);
const gsig2 = await newUser.signMessage(gch2.body.message);
const drip = await post("/api/gas/request", { address: agent, signature: gsig2, message: gch2.body.message });
check("the drip was sent", drip.body.ok === true, drip.body.error || JSON.stringify(drip.body).slice(0, 160));
check("it returned a tx hash", Boolean(drip.body.txHash), drip.body.txHash || "");

// Poll the balance rather than trusting the receipt: tx.wait() on this RPC can
// hang for minutes after the tx has confirmed.
let btc = 0n;
for (let i = 0; i < 20; i++) {
  btc = await ro.getBalance(agent);
  if (btc > 0n) break;
  await new Promise((r) => setTimeout(r, 1500));
}
check("BTC actually arrived", btc > 0n, `${ethers.formatEther(btc)} BTC`);

const gst2 = await get(`/api/gas/status?address=${agent}`);
check("the wallet no longer needs gas", gst2.body.needsGas === false);
check("the wallet reports enough gas for millions of approvals",
  gst2.body.estimate?.approvalsPerDrip > 1000, `${gst2.body.estimate?.approvalsPerDrip} approvals`);
// A second drip is refused — but on `not_needed`, not on cooldown, because a wallet
// that has been dripped now has gas, and need is checked before history. That
// ordering is deliberate and is pinned offline in test-gateway.mjs ("need beats
// cooldown"); the cooldown branch itself is unreachable live once the threshold is
// honest, since one drip is worth ~5.7 million approvals.
check("a second drip is refused", gst2.body.claim?.eligible === false, gst2.body.claim?.reason || "");
check("and it is refused because the wallet has gas", gst2.body.claim?.reason === "not_needed", gst2.body.claim?.reason || "");

// --- 5. the approval, with the calldata the browser sends --------------------
console.log("\n== 5. approve Permit2 (all future payments) ==");
const musdSigned = musd.connect(newUser);
const approveTx = await musdSigned.approve(PERMIT2, ethers.MaxUint256);
check("the approval was broadcast", Boolean(approveTx.hash), approveTx.hash);
let allowance = 0n;
for (let i = 0; i < 20; i++) {
  allowance = await musd.allowance(agent, PERMIT2);
  if (allowance > 0n) break;
  await new Promise((r) => setTimeout(r, 1500));
}
check("the allowance landed on chain", allowance === ethers.MaxUint256, allowance === ethers.MaxUint256 ? "maxUint256" : allowance.toString());
const gst3 = await get(`/api/gas/status?address=${agent}`);
check("the gateway now reports the wallet as ready", gst3.body.permit2Ready === true);
const probe2 = await post("/api/relay/probe", { url: URL_TARGET, agent });
check("policy now allows the payment", probe2.body.policy?.allowed === true,
  JSON.stringify(probe2.body.policy?.reasons || []).slice(0, 160));

// --- 6. the payment that was impossible before -------------------------------
//
// WHAT IS REQUIRED vs WHAT IS NOT. Settlement is this app's job: sign the
// authorization, move exactly the quoted MUSD, verify it on chain. Delivery is the
// seller's, and Mezo's hosted demo is documented (LIVE-DEPLOYMENT.md) as sometimes
// answering 402 *after* its facilitator has already settled — the
// `charged_without_delivery` condition, which the gateway reports honestly rather
// than pretending the payment failed. So delivery is asserted softly here: a 402
// after a verified settlement is reported as the third-party condition it is.
console.log("\n== 6. pay, then pay again without approving again ==");
const { x402Client, x402HTTPClient } = await import("@x402/fetch");
const { registerExactEvmScheme } = await import("@x402/evm/exact/client");
const { createWalletClient, http: viemHttp } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");

const account = privateKeyToAccount(newUser.privateKey);
const chain = { id: 31611, name: "Mezo Testnet", nativeCurrency: { name: "BTC", symbol: "BTC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const wc = createWalletClient({ account, chain, transport: viemHttp(RPC) });
const client = new x402Client();
registerExactEvmScheme(client, {
  signer: { address: wc.account.address, signTypedData: wc.signTypedData.bind(wc) },
  networks: [CAIP2], schemeOptions: { rpcUrl: RPC },
});
const x = new x402HTTPClient(client);
const headerGetter = (headers = {}) => (name) => headers[String(name).toLowerCase()] ?? null;

/** Probe, sign and relay one payment. Returns the gateway's receipt. */
async function payOnce() {
  const pr0 = await post("/api/relay/probe", { url: URL_TARGET, agent });
  if (!pr0.body.offer) throw new Error(`the seller did not quote: ${JSON.stringify(pr0.body).slice(0, 160)}`);
  let body = pr0.body.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* keep as text */ } }
  const pr = x.getPaymentRequiredResponse(headerGetter(pr0.body.headers), body);
  const payload = await x.createPaymentPayload(pr);
  const paymentHeaders = x.encodePaymentSignatureHeader(payload);
  const payment = paymentHeaders[Object.keys(paymentHeaders)[0]];
  const balBefore = await musd.balanceOf(agent);
  const exec = await post("/api/relay/execute", { url: URL_TARGET, agent, payment, paymentHeaders });
  return { ...exec.body, moved: balBefore - (await musd.balanceOf(agent)), countBefore: await treasury.paymentCount() };
}

// First payment: the one that was refused two minutes ago.
const countBefore = await treasury.paymentCount();
const one = await payOnce();
console.log("   " + JSON.stringify({ ok: one.ok, paid: one.paid, settled: one.settled, delivered: one.delivered, status: one.status, ms: one.ms, tx: one.receipt?.settlementTx, error: one.error }).slice(0, 400));
check("the relayed payment succeeded", one.ok === true, one.error || "");
check("settlement was verified on chain", one.settled === true);
if (one.delivered) check("the seller delivered the resource", true, `HTTP ${one.status}`);
else warn("the seller returned HTTP 402 after settling — the documented third-party condition", one.error || "");

// Second payment: this is the point of "all future payments". The user asked for a
// choice between one permission per transaction and one for everything that
// follows; with the unlimited choice taken, this second payment must need no
// approval at all — no second popup, no second signature.
const allowBeforeSecond = await musd.allowance(agent, PERMIT2);
const two = await payOnce();
console.log("   " + JSON.stringify({ ok: two.ok, paid: two.paid, settled: two.settled, delivered: two.delivered, status: two.status, ms: two.ms, tx: two.receipt?.settlementTx, error: two.error }).slice(0, 400));
check("a second payment settles without approving again", two.settled === true, two.error || "");
check("the approval was untouched by paying", (await musd.allowance(agent, PERMIT2)) === allowBeforeSecond);
if (two.delivered) check("the seller delivered the second resource", true, `HTTP ${two.status}`);
else warn("the seller returned HTTP 402 after settling again", two.error || "");

const spent = await musd.balanceOf(agent).then(async (b) => ethers.parseEther("10") - b);
check("exactly 0.002 MUSD left the new user's wallet across both payments", spent === 2000000000000000n, `${ethers.formatUnits(spent, 18)} MUSD`);
check("paymentCount incremented for both", (await treasury.paymentCount()) > countBefore + 1n,
  `${countBefore} → ${await treasury.paymentCount()}`);
for (const [label, r] of [["first", one], ["second", two]]) {
  const tx = r.receipt?.settlementTx;
  if (!tx) continue;
  // rpc.test.mezo.org LAGS on eth_getTransactionReceipt: a mined transaction can
  // return a null receipt for minutes (observed on both payments in one run, while
  // eth_getTransaction reported the block immediately). The gateway has already
  // verified settlement independently — that is what `settled: true` means — so
  // poll, then accept a mined tx as proof rather than blaming the chain for the RPC.
  let rc = null;
  let mined = null;
  for (let i = 0; i < 8; i++) {
    rc = await ro.getTransactionReceipt(tx).catch(() => null);
    if (rc) break;
    mined = mined || (await ro.getTransaction(tx).catch(() => null));
    if (mined?.blockNumber) break;
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  const good = rc ? rc.status === 1 : Boolean(mined?.blockNumber);
  check(`the ${label} settlement tx is on chain and succeeded`, good,
    rc ? `block ${rc.blockNumber}, status ${rc.status}`
      : mined?.blockNumber ? `block ${mined.blockNumber} (this RPC is still lagging on the receipt)`
      : "not found");
}

if (warns) console.log(`\n   ${warns} warning(s): the seller settled a payment and then returned 402 without\n   the resource. That is Mezo's demo endpoint's documented behaviour, not this app's\n   — the gateway records it as charged_without_delivery and reports it honestly.`);
console.log(fails
  ? `\n❌ ${fails} check(s) failed — onboarding is NOT verified\n`
  : `\n✅ onboarding verified end to end: a wallet that started with nothing claimed MUSD,\n   was refused for want of an approval, got gas from the app, approved Permit2 itself,\n   paid a third-party seller — then paid again with no second approval,\n   with no terminal and no operator key anywhere in the path.\n`);
console.log(`   throwaway agent ${agent} holds ${await musdOf(agent)} MUSD and is registered.`);
console.log(`   retire it with: cd contract && AGENT_ADDRESS=${agent} node scripts/retire-agent.js\n`);
process.exit(fails ? 1 : 0);
