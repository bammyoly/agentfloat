// ---------------------------------------------------------------------------
// LIVE end-to-end test of the x402 relay: the one path that needs a real seller,
// a real signature and real MUSD to prove.
//
//   npm run test:relay            (from the repo root or from server/)
//
// WHAT IT COSTS
//   One payment of the seller's price against https://demo.vativ.io/ — 0.001 MUSD
//   on Mezo testnet, from the agent wallet in server/.env. The refusal cases at
//   the end must NOT spend anything, and the script asserts that too.
//
// WHAT IT NEEDS
//   * the gateway running on 127.0.0.1:4022   (npm run gateway)
//   * AGENT_PRIVATE_KEY in server/.env, for a wallet that is REGISTERED with the
//     treasury and funded (the faucet will do it: npm run setup-agent, or /faucet)
//   * network access to Mezo testnet and to the seller
//
// WHY IT EXISTS
//   The offline suites pin the pure functions. They cannot catch the two ways this
//   path has actually failed in the wild:
//
//     1. The header NAME is part of the protocol. v1 travels as X-PAYMENT, v2 as
//        PAYMENT-SIGNATURE. A relay that hardcodes one sends a header the seller
//        never reads: it answers 402 again, ~30 s pass, no MUSD moves, and the log
//        says "settlement failed". Only a live v2 seller shows that.
//
//     2. The payer and the amount are NOT at payload.payer / paymentRequirements.
//        v2 keeps them in payload.permit2Authorization.from and accepted.amount;
//        v1 keeps the requirement in an ARRAY. A guard written as
//        `if (decoded.payer && mismatch)` fails OPEN — it let a payment it could
//        not attribute through at a price of zero.
//
//   This script is the Node twin of frontend/src/lib/x402-browser.js
//   makeRelaySigner(): probe -> sign locally -> hand the gateway the header map ->
//   relayed fetch -> settlement verified against the MUSD Transfer logs.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import { createWalletClient, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { ethers } from "ethers";

const B = process.env.GATEWAY_URL || "http://127.0.0.1:4022";
const URL_TARGET = process.env.RELAY_TARGET || "https://demo.vativ.io/";
const RPC = "https://rpc.test.mezo.org";
const CAIP2 = "eip155:31611";
const MUSD = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
const TREASURY = "0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79";

const envPath = new URL("./.env", import.meta.url);
if (!fs.existsSync(envPath)) {
  console.log("❌ no server/.env — copy server/.env.example and set AGENT_PRIVATE_KEY");
  process.exit(1);
}
const env = fs.readFileSync(envPath, "utf8");
const pk = (env.match(/^AGENT_PRIVATE_KEY=(.*)$/m) || [])[1]?.trim();
if (!pk) { console.log("❌ AGENT_PRIVATE_KEY is not set in server/.env"); process.exit(1); }

const account = privateKeyToAccount(pk);
const agent = account.address;

const chain = {
  id: 31611, name: "Mezo Testnet",
  nativeCurrency: { name: "BTC", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

// A LocalAccount already satisfies the { address, signTypedData } shape the exact
// scheme asks for. A BROWSER wallet client built from an address does not — see
// schemeSigner() in x402-browser.js, which is what makeRelaySigner() uses.
const walletClient = createWalletClient({ account, chain, transport: viemHttp(RPC) });

/** Build a paying client for one signer, exactly as the browser does. */
function payerFor(acc) {
  const wc = createWalletClient({ account: acc, chain, transport: viemHttp(RPC) });
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: { address: wc.account.address, signTypedData: wc.signTypedData.bind(wc) },
    networks: [CAIP2],
    schemeOptions: { rpcUrl: RPC },
  });
  return new x402HTTPClient(client);
}

const x = payerFor(account);
const headerGetter = (headers = {}) => (name) => headers[String(name).toLowerCase()] ?? null;

const post = async (path, body) => {
  const r = await fetch(B + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

let fails = 0;
const check = (n, c, extra = "") => {
  console.log(`${c ? "  \x1b[32m✅\x1b[0m" : "  \x1b[31m❌\x1b[0m"} ${n}${extra ? "  " + extra : ""}`);
  if (!c) fails++;
};

const ro = new ethers.JsonRpcProvider(RPC, 31611);
const musd = new ethers.Contract(MUSD, [
  "function balanceOf(address) view returns (uint256)",
], ro);
const treasury = new ethers.Contract(TREASURY, ["function paymentCount() view returns (uint256)"], ro);

const health = await fetch(`${B}/api/health`).then((r) => r.json()).catch(() => null);
if (!health) {
  console.log(`❌ the gateway is not answering on ${B} — start it first: npm run gateway`);
  process.exit(1);
}

const bal0 = await musd.balanceOf(agent);
const count0 = await treasury.paymentCount();
console.log(`\n== relay E2E =============================================`);
console.log(`  gateway   ${B} (relay ${health.relay?.enabled ? "enabled" : "DISABLED"})`);
console.log(`  seller    ${URL_TARGET}`);
console.log(`  agent     ${agent}`);
console.log(`  float     ${ethers.formatUnits(bal0, 18)} MUSD · paymentCount ${count0}\n`);

if (bal0 === 0n) {
  console.log("❌ the agent wallet holds no MUSD — fund it first (/faucet, or npm run setup-agent)");
  process.exit(1);
}

// --- 1. probe: the gateway fetches, nothing is signed ------------------------
console.log("== 1. probe ==");
const p = await post("/api/relay/probe", { url: URL_TARGET, agent });
check("gateway saw a 402 that requires payment",
  p.body.ok === true && p.body.status === 402 && p.body.requiresPayment === true,
  `HTTP ${p.status} · seller status ${p.body.status} · ${p.body.ms} ms`);
check("offer decoded from the relayed header",
  p.body.offer?.amount === "1000000000000000" && p.body.offer?.transferMethod === "permit2",
  JSON.stringify(p.body.offer));
check("policy allows this agent to pay it", p.body.policy?.allowed === true,
  JSON.stringify(p.body.policy?.reasons || p.body.policy?.reason));

// --- 2. sign locally: the browser half, in Node ------------------------------
console.log("\n== 2. sign locally (the browser's job) ==");
let probeBody = p.body.body;
if (typeof probeBody === "string") { try { probeBody = JSON.parse(probeBody); } catch { /* keep as text */ } }
const pr = x.getPaymentRequiredResponse(headerGetter(p.body.headers), probeBody);
check("payment requirements rebuilt from the relayed headers", Boolean(pr), pr ? `scheme ${pr.scheme || "?"}` : "");

const payload = await x.createPaymentPayload(pr);
const payer = payload?.payload?.permit2Authorization?.from || payload?.payload?.authorization?.from || null;
check("payload names this wallet as payer", String(payer).toLowerCase() === agent.toLowerCase(), payer);
check("payload is protocol v2", payload?.x402Version === 2, `v${payload?.x402Version}`);

// encodePaymentSignatureHeader returns a MAP of headers — that is what
// wrapFetchWithPayment sets on the outgoing request, and that is what the relay
// must forward verbatim rather than re-name.
const paymentHeaders = x.encodePaymentSignatureHeader(payload);
const names = Object.keys(paymentHeaders || {});
check("the client chose the header name", names.length === 1, names.join(","));
const payment = paymentHeaders[names[0]];
check("a payment header was produced", typeof payment === "string" && payment.length > 40, `${payment?.length} chars`);

// --- 3. execute: gateway re-checks, fetches with the payment, verifies --------
console.log("\n== 3. execute through the relay ==");
const t0 = Date.now();
const e = await post("/api/relay/execute", { url: URL_TARGET, agent, payment, paymentHeaders });
console.log("   " + JSON.stringify({
  ok: e.body.ok, paid: e.body.paid, settled: e.body.settled, delivered: e.body.delivered,
  status: e.body.status, via: e.body.via, ms: e.body.ms, settlementTx: e.body.receipt?.settlementTx,
  recorded: e.body.receipt?.recorded, error: e.body.error, code: e.body.code,
}).slice(0, 500));
check("relay execute ok", e.body.ok === true, e.body.error || "");
check("gateway attributed and priced the payment before relaying",
  e.body.paid === true, `paid=${e.body.paid}`);
check("settlement verified against the chain", e.body.settled === true);
check("seller delivered the resource", e.body.delivered === true, `HTTP ${e.body.status}`);
const tx = e.body.receipt?.settlementTx;
check("a settlement tx hash came back", Boolean(tx), tx || "");
check("it took under a minute", Date.now() - t0 < 60000, `${Date.now() - t0} ms`);

// --- 4. chain proof ----------------------------------------------------------
console.log("\n== 4. chain proof ==");
const bal1 = await musd.balanceOf(agent);
const count1 = await treasury.paymentCount();
check("MUSD actually left the agent wallet", bal1 < bal0,
  `${ethers.formatUnits(bal0, 18)} → ${ethers.formatUnits(bal1, 18)}`);
check("exactly the quoted 0.001 MUSD moved", bal0 - bal1 === 1000000000000000n,
  `${ethers.formatUnits(bal0 - bal1, 18)} MUSD`);
check("paymentCount incremented on chain", count1 > count0, `${count0} → ${count1}`);
if (tx) {
  // rpc.test.mezo.org LAGS on eth_getTransactionReceipt: a mined tx can return a
  // null receipt — or "method handler crashed" — for minutes, while
  // eth_getTransaction reports its block immediately. The gateway has already
  // verified this settlement on chain (that is what `settled: true` means), so
  // poll, then accept a mined tx rather than blaming the chain for the RPC.
  let rc = null;
  let mined = null;
  for (let i = 0; i < 8; i++) {
    rc = await ro.getTransactionReceipt(tx).catch(() => null);
    if (rc) break;
    mined = mined || (await ro.getTransaction(tx).catch(() => null));
    if (mined?.blockNumber) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  check("settlement tx is on chain and succeeded", rc ? rc.status === 1 : Boolean(mined?.blockNumber),
    rc ? `block ${rc.blockNumber} · status ${rc.status}`
      : mined?.blockNumber ? `block ${mined.blockNumber} (this RPC is still lagging on the receipt)`
      : "not found");
}

// --- 5. refusals must not spend anything ------------------------------------
console.log("\n== 5. refusals (these must cost 0 MUSD) ==");
const balBefore = await musd.balanceOf(agent);

// (a) a payment signed by somebody else
const stranger = privateKeyToAccount(ethers.Wallet.createRandom().privateKey);
const x2 = payerFor(stranger);
const forgedPayload = await x2.createPaymentPayload(pr);
const forgedHeaders = x2.encodePaymentSignatureHeader(forgedPayload);
const forged = forgedHeaders[Object.keys(forgedHeaders)[0]];
const bad = await post("/api/relay/execute", { url: URL_TARGET, agent, payment: forged, paymentHeaders: forgedHeaders });
check("another wallet's payment is refused 403 payer_mismatch",
  bad.status === 403 && bad.body.code === "payer_mismatch", `HTTP ${bad.status} ${bad.body.code || bad.body.error}`);

// (b) a payment the gateway cannot attribute at all — must fail CLOSED, not open
const unattributable = encodePaymentSignatureHeader({
  x402Version: 2, scheme: "exact", network: CAIP2, accepted: p.body.offer && {
    scheme: "exact", network: CAIP2, amount: p.body.offer.amount, asset: p.body.offer.asset,
    payTo: p.body.offer.payTo, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "permit2" },
  }, payload: { scheme: "exact", network: CAIP2, signature: "0x" + "11".repeat(65) },
});
const blind = await post("/api/relay/execute", { url: URL_TARGET, agent, payment: unattributable });
check("an unattributable payment is refused 422 payer_unverifiable",
  blind.status === 422 && blind.body.code === "payer_unverifiable", `HTTP ${blind.status} ${blind.body.code || blind.body.error}`);

// (c) an over-cap price must be refused before anything is relayed
const overpriced = encodePaymentSignatureHeader({
  x402Version: 2, scheme: "exact", network: CAIP2,
  accepted: {
    scheme: "exact", network: CAIP2, amount: "999000000000000000000", asset: MUSD,
    payTo: p.body.offer?.payTo, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "permit2" },
  },
  payload: {
    scheme: "exact", network: CAIP2, signature: "0x" + "11".repeat(65),
    permit2Authorization: { from: agent, signature: "0x" + "11".repeat(65), permitted: { token: MUSD, amount: "999000000000000000000" } },
  },
});
const over = await post("/api/relay/execute", { url: URL_TARGET, agent, payment: overpriced });
check("a 999 MUSD price is refused by policy", over.status >= 400 && over.body.ok !== true,
  `HTTP ${over.status} ${over.body.code || over.body.error || ""}`);

// (d) a header map with no payment in it
const smuggled = await post("/api/relay/execute", {
  url: URL_TARGET, agent, paymentHeaders: { Host: "demo.vativ.io", Authorization: "Bearer not-mine" },
});
check("a map with no payment header is refused", smuggled.status >= 400 && smuggled.body.ok !== true,
  `HTTP ${smuggled.status} ${smuggled.body.code || smuggled.body.error || ""}`);

const balAfter = await musd.balanceOf(agent);
check("no refusal moved any MUSD", balAfter === balBefore,
  `${ethers.formatUnits(balBefore, 18)} → ${ethers.formatUnits(balAfter, 18)}`);

console.log(fails
  ? `\n❌ ${fails} check(s) failed — the relay is NOT verified\n`
  : `\n✅ relay verified end to end: browser-side signature, protocol-version header name,\n   gateway policy, chain-verified settlement, and refusals that cost nothing\n`);
process.exit(fails ? 1 : 0);
