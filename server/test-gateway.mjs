// ---------------------------------------------------------------------------
// Offline tests for the Wave 1 gateway modules.
//
//   npm run test:gateway        (from the repo root or from server/)
//
// WHY THESE EXIST
//   Three new server-side powers, each of which is dangerous if it is subtly
//   wrong:
//
//     relay.js   makes the operator's machine fetch a URL chosen by a stranger.
//                Get the guard wrong and it is an open proxy into their LAN and
//                their cloud metadata endpoint.
//     limits.js  spends the operator's gas and moves on-chain caps, authorized by
//                a signature. Get the verification wrong and anyone can change
//                anyone's budget.
//     telegram.js sends messages to real people's phones. Get the binding wrong
//                and one user receives another user's spending alerts.
//
//   None of that needs a chain, a bot token or a seller to test: the guards are
//   pure functions, the signature check is a local recovery, and the renderer is
//   a string. So they are pinned here, in plain Node, with no network.
// ---------------------------------------------------------------------------

import { ethers } from "ethers";
import { encodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";

import {
  RelayError, isPrivateAddress, isIpLiteral, assertRelayable, decodeOffer, inspectPaymentHeader,
  PAYMENT_HEADER_NAMES, paymentHeadersFrom, executeWithPayment,
} from "./relay.js";
import { buildMessage, ceilingsFrom, parseMusd } from "./limits.js";
import { PERMIT2_ADDRESS, buildGasMessage, evaluateGasClaim, gasConfigFrom, gasThreshold } from "./gas.js";
import { dayStartSec, judgeDailySpend, sumSpentSince } from "./spend.js";
import { renderEvent, escapeHtml } from "./telegram.js";

let failures = 0;
let count = 0;
// JSON.stringify THROWS on a BigInt, and this codebase compares BigInts all the
// time — wei amounts, allowances, gas thresholds. The same trap has bitten two API
// responses already; the harness must not become the third. Render them explicitly:
// `1n` and `1` stay unequal, which is what a test wants to see.
const show = (v) => (typeof v === "bigint" ? `${v}n` : JSON.stringify(v));
const eq = (name, actual, expected) => {
  count++;
  const a = show(actual);
  const e = show(expected);
  if (a === e) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n      expected ${e}\n      actual   ${a}`); }
};
const ok = (name, cond, extra = "") => {
  count++;
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
};
const rejects = async (name, code, fn) => {
  count++;
  try {
    const v = await fn();
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name} — did not throw (returned ${JSON.stringify(v)})`);
  } catch (e) {
    if (code && !(e instanceof RelayError) ) { failures++; console.log(`  \x1b[31m✗\x1b[0m ${name} — threw a non-RelayError: ${e.message}`); return; }
    if (code && e.code !== code) { failures++; console.log(`  \x1b[31m✗\x1b[0m ${name} — code ${e.code}, expected ${code}`); return; }
    console.log(`  \x1b[32m✓\x1b[0m ${name}${code ? ` (${code})` : ""}`);
  }
};
const allows = async (name, fn) => {
  count++;
  try { const v = await fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); return v; }
  catch (e) { failures++; console.log(`  \x1b[31m✗\x1b[0m ${name} — refused: ${e.code || ""} ${e.message}`); }
};

const SELF = new Set(["http://127.0.0.1:4022", "http://localhost:4022"]);

// ===========================================================================
console.log(`\n== relay: address classification ==========================================\n`);
eq("127.0.0.1 is private", isPrivateAddress("127.0.0.1"), true);
eq("10.0.0.5 is private", isPrivateAddress("10.0.0.5"), true);
eq("192.168.1.195 is private", isPrivateAddress("192.168.1.195"), true);
eq("172.16.0.1 is private", isPrivateAddress("172.16.0.1"), true);
eq("172.31.255.255 is private", isPrivateAddress("172.31.255.255"), true);
eq("172.32.0.1 is NOT private", isPrivateAddress("172.32.0.1"), false);
eq("169.254.169.254 (cloud metadata) is private", isPrivateAddress("169.254.169.254"), true);
eq("100.64.0.1 (CGNAT) is private", isPrivateAddress("100.64.0.1"), true);
eq("0.0.0.0 is private", isPrivateAddress("0.0.0.0"), true);
eq("224.0.0.1 (multicast) is private", isPrivateAddress("224.0.0.1"), true);
eq("::1 is private", isPrivateAddress("::1"), true);
eq("fd00:: is private", isPrivateAddress("fd00::1"), true);
eq("fe80:: is private", isPrivateAddress("fe80::1"), true);
eq("::ffff:127.0.0.1 (v4-mapped) is private", isPrivateAddress("::ffff:127.0.0.1"), true);
eq("8.8.8.8 is public", isPrivateAddress("8.8.8.8"), false);
eq("2606:4700::1 is public", isPrivateAddress("2606:4700::1"), false);
eq("garbage is treated as private (refuse)", isPrivateAddress("not-an-ip"), true);
eq("empty is treated as private (refuse)", isPrivateAddress(""), true);
eq("null is treated as private (refuse)", isPrivateAddress(null), true);
eq("isIpLiteral: v4", isIpLiteral("127.0.0.1"), true);
eq("isIpLiteral: v6", isIpLiteral("::1"), true);
eq("isIpLiteral: hostname is NOT a literal", isIpLiteral("demo.vativ.io"), false);
eq("isIpLiteral: name that merely contains digits", isIpLiteral("1.2.3.4.example.com"), false);

// ===========================================================================
console.log(`\n== relay: URL guard (SSRF) ================================================\n`);

await rejects("file:// refused", "bad_protocol", () => assertRelayable("file:///etc/passwd", { selfOrigins: SELF }));
await rejects("ftp:// refused", "bad_protocol", () => assertRelayable("ftp://example.com/x", { selfOrigins: SELF }));
await rejects("javascript: refused", "bad_protocol", () => assertRelayable("javascript:alert(1)", { selfOrigins: SELF }));
await rejects("plain http refused", "bad_protocol", () => assertRelayable("http://demo.vativ.io/", { selfOrigins: SELF }));
await rejects("unparseable refused", "bad_url", () => assertRelayable("not a url", { selfOrigins: SELF }));
await rejects("loopback https refused", "ssrf_blocked", () => assertRelayable("https://127.0.0.1/x", { selfOrigins: SELF }));
await rejects("cloud metadata refused", "ssrf_blocked", () => assertRelayable("https://169.254.169.254/latest/meta-data/", { selfOrigins: SELF }));
await rejects("LAN address refused", "ssrf_blocked", () => assertRelayable("https://192.168.1.195:5173/", { selfOrigins: SELF }));
await rejects(".local refused", "ssrf_blocked", () => assertRelayable("https://printer.local/admin", { selfOrigins: SELF }));
await rejects(".internal refused", "ssrf_blocked", () => assertRelayable("https://metadata.google.internal/", { selfOrigins: SELF }));
// Protocol is judged before host, so plain http reports bad_protocol — the more
// accurate of the two reasons. The host rule is covered by the https cases.
await rejects("non-self localhost refused", "bad_protocol", () => assertRelayable("http://localhost:3000/admin", { selfOrigins: SELF }));
await rejects("https loopback name refused", "ssrf_blocked", () => assertRelayable("https://localhost/admin", { selfOrigins: SELF }));
await rejects("non-resolving host refused", null, () => assertRelayable("https://no-such-host.invalid/x", { selfOrigins: SELF }));

// The gateway's OWN demo seller is the one exemption — it is this process.
await allows("self origin over http is allowed (built-in seller)", () =>
  assertRelayable("http://127.0.0.1:4022/paid/insight", { selfOrigins: SELF }));
await allows("public https is allowed", () => assertRelayable("https://demo.vativ.io/", { selfOrigins: SELF }));

// Allowlist wins over "any public https".
await rejects("allowlist refuses an unlisted origin", "not_allowlisted", () =>
  assertRelayable("https://evil.example/x", { selfOrigins: SELF, allowlist: ["https://demo.vativ.io"] }));
await allows("allowlist accepts a listed origin", () =>
  assertRelayable("https://demo.vativ.io/x", { selfOrigins: SELF, allowlist: ["https://demo.vativ.io"] }));

// Trailing-slash and case games must not smuggle a private host past the guard.
await rejects("uppercase scheme still judged", "ssrf_blocked", () => assertRelayable("HTTPS://10.0.0.1/x", { selfOrigins: SELF }));
await rejects("userinfo trick refused", "ssrf_blocked", () => assertRelayable("https://demo.vativ.io@127.0.0.1/x", { selfOrigins: SELF }));

// ===========================================================================
console.log(`\n== relay: header decoding =================================================\n`);
{
  const requirements = [{
    scheme: "exact", network: "eip155:31611", asset: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
    maxAmountRequired: "1000000000000000", payTo: "0x7623F74AE5d8a19d3B0aC0d3a81aDAC45a3Edf79",
    maxTimeoutSeconds: 60, extra: { assetTransferMethod: "permit2", name: "MUSD" },
  }];
  const header = encodePaymentRequiredHeader({ x402Version: 2, requirements });
  const dec = decodeOffer({ "payment-required": header }, "");
  ok("decodeOffer: parses the requirement", Boolean(dec.offer), JSON.stringify(dec));
  eq("decodeOffer: amount", dec.offer?.amount, "1000000000000000");
  eq("decodeOffer: network", dec.offer?.network, "eip155:31611");
  eq("decodeOffer: payTo", dec.offer?.payTo, requirements[0].payTo);
  eq("decodeOffer: transfer method survives in extra", dec.offer?.extra?.assetTransferMethod, "permit2");
  eq("decodeOffer: no header -> no offer", decodeOffer({}, "").offer, null);
}
// ---- inspectPaymentHeader: the shapes a wallet ACTUALLY signs --------------
// Captured from a live relay against https://demo.vativ.io/ (Mezo's hosted x402
// demo). These are not the shapes the protocol documentation implies, and the
// difference is the whole bug:
//
//   v2 permit2  -> payer in payload.permit2Authorization.from, amount in accepted.amount
//   v2 eip3009  -> payer in payload.authorization.from,        amount in accepted.amount
//   v1          -> wrapper { x402Version: 1, ... } with paymentRequirements as an
//                  ARRAY inside payload. Read as an object, every field comes
//                  back undefined — which is how a well-formed v1 header used to
//                  attribute the payment to nobody and price it at zero.
//
// A gateway that cannot read the payer cannot enforce "only this agent's budget",
// and one that cannot read the amount cannot enforce the caps. Both must now fail
// CLOSED: see /api/relay/execute returning 422 payer_unverifiable / amount_unverifiable.
{
  const ASSET = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
  const PAY_TO = "0xC3376296a18ef364eA19287203EEd7a87f18e738";
  const SPENDER = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
  const AGENT = "0xF8F5a2bE9d2E4a6bCdE11b1a4b0aA2d8F0b02686";
  const OTHER = "0x7623F74AE5d8a19d3B0aC0d3a81aDAC45a3Edf79";
  const SIG = "0x" + "ab".repeat(65);
  const accepted = (transferMethod) => ({
    scheme: "exact", network: "eip155:31611", amount: "1000000000000000",
    asset: ASSET, payTo: PAY_TO, maxTimeoutSeconds: 300,
    extra: { name: "Mezo USD", version: "1", assetTransferMethod: transferMethod },
  });

  const v2Permit2 = encodePaymentSignatureHeader({
    x402Version: 2, scheme: "exact", network: "eip155:31611", accepted: accepted("permit2"),
    payload: {
      scheme: "exact", network: "eip155:31611", signature: SIG,
      permit2Authorization: {
        signature: SIG, from: AGENT, permitted: { token: ASSET, amount: "1000000000000000" },
        spender: SPENDER, nonce: "1", deadline: "1900000000", witness: { to: PAY_TO, validAfter: "0" },
      },
    },
  });

  const v2Eip3009 = encodePaymentSignatureHeader({
    x402Version: 2, scheme: "exact", network: "eip155:31611", accepted: accepted("eip3009"),
    payload: {
      scheme: "exact", network: "eip155:31611", signature: SIG,
      authorization: { from: AGENT, to: PAY_TO, value: "1000000000000000", validAfter: "0", validBefore: "1900000000", nonce: "1" },
    },
  });

  // v1: no `accepted`; the requirement is an array inside payload.
  const v1Permit2 = encodePaymentSignatureHeader({
    x402Version: 1, scheme: "exact", network: "eip155:31611",
    payload: {
      scheme: "exact", network: "eip155:31611", signature: SIG,
      paymentRequirements: [{
        scheme: "exact", network: "eip155:31611", asset: ASSET, maxAmountRequired: "1000000000000000",
        payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "MUSD", version: "1", assetTransferMethod: "permit2" },
      }],
      permit2Authorization: {
        signature: SIG, from: AGENT, permitted: { token: ASSET, amount: "1000000000000000" },
        spender: SPENDER, nonce: "1", deadline: "1900000000", witness: { to: PAY_TO, validAfter: "0" },
      },
    },
  });

  const p2 = inspectPaymentHeader(v2Permit2);
  ok("v2 permit2: decodes", p2.ok, p2.error);
  eq("v2 permit2: version", p2.version, 2);
  eq("v2 permit2: payer", p2.payer, AGENT);
  eq("v2 permit2: payerFound", p2.payerFound, true);
  eq("v2 permit2: amount", p2.amount, "1000000000000000");
  eq("v2 permit2: asset", p2.asset, ASSET);
  eq("v2 permit2: payee", p2.payTo, PAY_TO);
  eq("v2 permit2: network", p2.network, "eip155:31611");
  eq("v2 permit2: transfer method", p2.transferMethod, "permit2");
  eq("v2 permit2: permit2 spender (the allowance target)", p2.spender, SPENDER);
  eq("v2 permit2: maxTimeoutSeconds", p2.maxTimeoutSeconds, 300);

  const a3 = inspectPaymentHeader(v2Eip3009);
  eq("v2 eip3009: payer comes from authorization.from", a3.payer, AGENT);
  eq("v2 eip3009: amount", a3.amount, "1000000000000000");
  eq("v2 eip3009: payee", a3.payTo, PAY_TO);
  eq("v2 eip3009: transfer method", a3.transferMethod, "eip3009");
  eq("v2 eip3009: no permit2 spender", a3.spender, null);

  const v1 = inspectPaymentHeader(v1Permit2);
  ok("v1 array: decodes", v1.ok, v1.error);
  eq("v1 array: version", v1.version, 1);
  eq("v1 array: payer", v1.payer, AGENT);
  eq("v1 array: amount read out of paymentRequirements[0]", v1.amount, "1000000000000000");
  eq("v1 array: asset", v1.asset, ASSET);
  eq("v1 array: payee", v1.payTo, PAY_TO);
  eq("v1 array: transfer method", v1.transferMethod, "permit2");

  // The browser now sends the header MAP encodePaymentSignatureHeader() returned,
  // so inspection must accept that too — otherwise the relay cannot price what it
  // is about to forward.
  const asMap = inspectPaymentHeader({ "PAYMENT-SIGNATURE": v2Permit2 });
  eq("header map: payer still read", asMap.payer, AGENT);
  eq("header map: amount still read", asMap.amount, "1000000000000000");

  // --- fail closed ---------------------------------------------------------
  const noPayer = inspectPaymentHeader(encodePaymentSignatureHeader({
    x402Version: 2, accepted: accepted("permit2"), payload: { signature: SIG },
  }));
  eq("unattributable payment: payer is null", noPayer.payer, null);
  eq("unattributable payment: payerFound false (gateway answers 422)", noPayer.payerFound, false);
  eq("unattributable payment: still priced", noPayer.amount, "1000000000000000");

  const noAmount = inspectPaymentHeader(encodePaymentSignatureHeader({
    x402Version: 2, payload: { permit2Authorization: { from: AGENT, signature: SIG } },
  }));
  eq("unpriceable payment: amount is null (gateway answers 422)", noAmount.amount, null);
  eq("unpriceable payment: payer still read", noAmount.payer, AGENT);

  // A mismatched payer is the 403 case; these are the fields that decide it.
  ok("two different payers compare unequal", inspectPaymentHeader(v2Permit2).payer !== OTHER);

  eq("garbage is not ok", inspectPaymentHeader("not-base64-payment").ok, false);
  eq("empty is not ok", inspectPaymentHeader("").ok, false);
  eq("null is not ok", inspectPaymentHeader(null).ok, false);
}

// ---- paymentHeadersFrom: the header NAME is part of the protocol -----------
// v1 travels as X-PAYMENT, v2 as PAYMENT-SIGNATURE. Hardcoding either one means a
// v2 seller never sees the payment: it answers 402 again, nothing settles, and it
// looks like a facilitator failure. Forwarding the map the client returned is what
// wrapFetchWithPayment itself does, and the allowlist is what stops a client from
// smuggling Host / Authorization / Cookie through the operator's machine.
{
  eq("the allowlist is exactly the two protocol names", PAYMENT_HEADER_NAMES.join(","), "x-payment,payment-signature");

  const v2 = encodePaymentSignatureHeader({ x402Version: 2, payload: {} });
  const v1 = encodePaymentSignatureHeader({ x402Version: 1, payload: {} });

  const fromV2 = paymentHeadersFrom(v2);
  ok("v2 string: ok", fromV2.ok, fromV2.error);
  eq("v2 string: sent as PAYMENT-SIGNATURE only", Object.keys(fromV2.headers).join(","), "PAYMENT-SIGNATURE");
  eq("v2 string: value preserved", fromV2.headers["PAYMENT-SIGNATURE"], v2);

  const fromV1 = paymentHeadersFrom(v1);
  eq("v1 string: sent as X-PAYMENT only", Object.keys(fromV1.headers).join(","), "X-PAYMENT");

  const opaque = paymentHeadersFrom("not-decodable-base64!!");
  eq("undecodable string: both names, so either seller can read it",
    Object.keys(opaque.headers).sort().join(","), "PAYMENT-SIGNATURE,X-PAYMENT");

  const fromMap = paymentHeadersFrom({
    Host: "demo.vativ.io",
    Authorization: "Bearer operator-secret",
    Cookie: "session=abc",
    "PAYMENT-SIGNATURE": v2,
    "content-type": "application/json",
  });
  ok("map: ok", fromMap.ok, fromMap.error);
  eq("map: only the payment header survives the allowlist", Object.keys(fromMap.headers).join(","), "PAYMENT-SIGNATURE");
  ok("map: a smuggled bearer token is dropped", !JSON.stringify(fromMap.headers).includes("operator-secret"));
  ok("map: a smuggled cookie is dropped", !JSON.stringify(fromMap.headers).includes("session=abc"));

  const both = paymentHeadersFrom({ "X-PAYMENT": v1, "PAYMENT-SIGNATURE": v2 });
  eq("map with both names: both forwarded (seller picks)", Object.keys(both.headers).length, 2);

  eq("map with no payment header: not ok", paymentHeadersFrom({ Host: "x", Authorization: "Bearer y" }).ok, false);
  ok("map with no payment header: says which names it wanted",
    paymentHeadersFrom({ Host: "x" }).error.includes("x-payment"));
  eq("map with an empty value: not ok", paymentHeadersFrom({ "X-PAYMENT": "" }).ok, false);
  eq("empty input: not ok", paymentHeadersFrom("").ok, false);
  eq("null input: not ok", paymentHeadersFrom(null).ok, false);
  eq("a number is not a payment", paymentHeadersFrom(1234).ok, false);

  // executeWithPayment must refuse BEFORE it fetches: an unusable header map would
  // otherwise reach the seller as an unpaid request and come back as a confusing
  // second 402.
  let threw = null;
  try { executeWithPayment("https://demo.vativ.io/", { Host: "x" }); } catch (e) { threw = e; }
  ok("executeWithPayment refuses a map with no payment header", threw instanceof RelayError, String(threw));
  eq("executeWithPayment names the refusal", threw?.code, "no_payment_header");

  let threw2 = null;
  try { executeWithPayment("https://demo.vativ.io/", ""); } catch (e) { threw2 = e; }
  eq("executeWithPayment refuses an empty payment", threw2?.code, "no_payment_header");
}

// ---- decodeOffer: the real v2 header names the offer `accepts` --------------
{
  const ASSET = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
  const PAY_TO = "0xC3376296a18ef364eA19287203EEd7a87f18e738";
  const real = encodePaymentRequiredHeader({
    x402Version: 2, error: "Payment required",
    resource: { url: "https://demo.vativ.io/", description: "Mezo x402 Quickstart", mimeType: "" },
    accepts: [{
      scheme: "exact", network: "eip155:31611", amount: "1000000000000000", asset: ASSET,
      payTo: PAY_TO, maxTimeoutSeconds: 300,
      extra: { name: "Mezo USD", version: "1", assetTransferMethod: "permit2" },
    }],
  });
  const dec = decodeOffer({ "payment-required": real }, "");
  ok("real v2 402: offer decoded from accepts[]", Boolean(dec.offer), JSON.stringify(dec).slice(0, 200));
  eq("real v2 402: amount", dec.offer?.amount, "1000000000000000");
  eq("real v2 402: payee", dec.offer?.payTo, PAY_TO);
  eq("real v2 402: transfer method", dec.offer?.extra?.assetTransferMethod, "permit2");
  eq("real v2 402: description", dec.description, "Mezo x402 Quickstart");
}

// ===========================================================================
console.log(`\n== limits: the ceiling and the signature ==================================\n`);
eq("parseMusd: decimal", String(parseMusd("1.5")), ethers.parseUnits("1.5", 18).toString());
eq("parseMusd: integer", String(parseMusd("50")), ethers.parseUnits("50", 18).toString());
eq("parseMusd: 18 dp", String(parseMusd("0.000000000000000001")), "1");
eq("parseMusd: refuses letters", parseMusd("abc"), null);
eq("parseMusd: refuses negative", parseMusd("-1"), null);
eq("parseMusd: refuses exponent notation", parseMusd("1e3"), null);
eq("parseMusd: refuses empty", parseMusd(""), null);
eq("parseMusd: refuses 19 dp (rounding surprise)", parseMusd("0.0000000000000000001"), null);

{
  const ceilings = ceilingsFrom({});
  eq("default per-call ceiling", ceilings.perCallMaxMusd, "5");
  eq("default daily ceiling", ceilings.dailyCapMusd, "50");
  const custom = ceilingsFrom({ USER_PER_CALL_MAX_MUSD: "12", USER_DAILY_CAP_MUSD: "340" });
  eq("env overrides the ceiling", custom, { perCallMaxMusd: "12", dailyCapMusd: "340", minPerCallMusd: "0.001" });
}

// The auth scheme, end to end, with a wallet that signs via personal_sign —
// which is what a Privy embedded wallet does. No key ever reaches the server;
// only this recovery decides whether the change is applied.
{
  const wallet = ethers.Wallet.createRandom();
  const attacker = ethers.Wallet.createRandom();
  const nonce = "test-nonce-1234";
  const msg = buildMessage({
    address: wallet.address, action: "limits", nonce,
    perCallMaxMusd: "1.5", dailyCapMusd: "30",
    ceilings: { perCallMaxMusd: "5", dailyCapMusd: "50" },
  });
  ok("message names the agent", msg.includes(wallet.address));
  ok("message binds the requested values", msg.includes("per-call max: 1.5 MUSD") && msg.includes("daily cap: 30 MUSD"));
  ok("message binds the nonce", msg.includes(`nonce: ${nonce}`));
  ok("message states the ceiling", msg.includes("per-call <= 5 MUSD"));

  const sig = await wallet.signMessage(msg);
  eq("the owner's signature recovers to the owner", ethers.verifyMessage(msg, sig), wallet.address);

  const forged = await attacker.signMessage(msg);
  ok("an attacker's signature does NOT recover to the owner", ethers.verifyMessage(msg, forged) !== wallet.address);

  // Changing one digit of the request must invalidate the signature: the values
  // applied are the values that were signed.
  const tampered = msg.replace("per-call max: 1.5 MUSD", "per-call max: 5.0 MUSD");
  ok("tampering with the amount invalidates the signature", ethers.verifyMessage(tampered, sig) !== wallet.address);

  const freezeMsg = buildMessage({ address: wallet.address, action: "freeze", nonce, ceilings: { perCallMaxMusd: "5", dailyCapMusd: "50" } });
  ok("freeze message is a different string than limits", freezeMsg !== msg && freezeMsg.includes("freeze my agent wallet"));
  ok("a limits signature does not authorize a freeze", ethers.verifyMessage(freezeMsg, sig) !== wallet.address);
}

// ===========================================================================
console.log(`\n== telegram: rendering and escaping =======================================\n`);
{
  const pay = renderEvent({
    kind: "payment", amount: "1000000000000000", payee: "0x7623F74AE5d8a19d3B0aC0d3a81aDAC45a3Edf79",
    endpoint: "https://demo.vativ.io/", remainingToday: "1900000000000000000", dailyCap: "20000000000000000000",
  });
  ok("payment alert shows the amount", pay.includes("0.001"), pay);
  ok("payment alert shows the endpoint", pay.includes("demo.vativ.io"));
  ok("payment alert shows what is left today", pay.includes("Left today"));

  const denial = renderEvent({ kind: "denial", reason: "per_call_max", attempted: "9000000000000000000", endpoint: "https://x.example" });
  ok("denial names the reason", denial.includes("per_call_max"));
  ok("denial says nothing was spent", denial.includes("Nothing was signed"));

  const limits = renderEvent({ kind: "limits_changed", change: { perCallMaxMusd: "1.5", dailyCapMusd: "30", txHash: "0xabc123" } });
  ok("budget alert shows the new caps", limits.includes("1.5") && limits.includes("30"));

  const cap = renderEvent({ kind: "cap_warning", pct: 82, remainingToday: "3600000000000000000", dailyCap: "20000000000000000000" });
  ok("cap warning shows the percentage", cap.includes("82%"));

  const claim = renderEvent({ kind: "faucet_claim", amount: "10000000000000000000" });
  ok("faucet alert shows 10 MUSD", claim.includes("10"));

  // HTML parse mode means unescaped user input would be markup injection.
  const evil = renderEvent({ kind: "denial", reason: "<script>alert(1)</script>", attempted: "0", endpoint: "https://x" });
  ok("user-controlled text is escaped", !evil.includes("<script>") && evil.includes("&lt;script&gt;"));
  eq("escapeHtml handles & < >", escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  ok("every alert is branded", renderEvent({ kind: "test", address: "0x1234" }).includes("AgentFloat"));
}

// ===========================================================================
console.log(`\n== gas drip: the caps that keep an operator's BTC safe ====================\n`);
// A new agent wallet has MUSD and no native BTC, and `MUSD.approve(Permit2, …)` is
// a transaction — so without gas the user cannot enable payments at all. The drip
// sends that dust from the operator key, which makes its caps the security
// boundary. All of them are decided by pure functions, so they are tested here
// without a chain.
{
  const cfg = gasConfigFrom({});
  eq("default drip amount", cfg.amountBtc, 0.00005);
  eq("default safety margin on the gas estimate", cfg.gasSafetyFactor, 50);
  eq("default absolute gas floor", Number(ethers.formatEther(cfg.minUsable)), 0.00000001);
  eq("default cooldown", cfg.cooldownHours, 24);
  eq("default daily cap", Number(ethers.formatEther(cfg.dailyCap)), 0.005);
  eq("default total cap", Number(ethers.formatEther(cfg.totalCap)), 0.02);
  eq("default operator reserve", Number(ethers.formatEther(cfg.operatorReserve)), 0.01);
  eq("the spender every approval targets is canonical Permit2",
    PERMIT2_ADDRESS, "0x000000000022D473030F116dDEE9F6B43aC78BA3");

  const tuned = gasConfigFrom({ GAS_DRIP_BTC: "0.001", GAS_DRIP_COOLDOWN_HOURS: "1", GAS_DRIP_TOTAL_CAP_BTC: "0.5", GAS_DRIP_SAFETY_FACTOR: "3" });
  eq("env overrides the amount", tuned.amountBtc, 0.001);
  eq("env overrides the cooldown", tuned.cooldownHours, 1);
  eq("env overrides the total cap", Number(ethers.formatEther(tuned.totalCap)), 0.5);
  eq("env overrides the safety factor", tuned.gasSafetyFactor, 3);

  // A typo in an env file must not silently become "send everything".
  eq("nonsense falls back to the default", gasConfigFrom({ GAS_DRIP_BTC: "abc" }).amountBtc, 0.00005);
  eq("zero falls back to the default", gasConfigFrom({ GAS_DRIP_BTC: "0" }).amountBtc, 0.00005);
  eq("a negative amount falls back to the default", gasConfigFrom({ GAS_DRIP_BTC: "-5" }).amountBtc, 0.00005);

  // -- the threshold is derived from the live cost, not guessed ----------------
  // Mezo testnet measured at 146 wei/gas × 60 000 gas = 8.76e-12 BTC per approval.
  const live = gasThreshold({ gasPriceWei: 146n, config: cfg });
  eq("at today's gas price the absolute floor decides", live, cfg.minUsable);
  ok("a dripped wallet therefore has gas", cfg.amount > live, `drip ${ethers.formatEther(cfg.amount)} vs floor ${ethers.formatEther(live)}`);
  ok("one drip buys far more approvals than any user will send", cfg.amount / live > 100n);
  const hot = gasThreshold({ gasPriceWei: 1_000_000_000n, config: cfg });
  eq("if gas gets expensive the margin decides instead", hot, 1_000_000_000n * cfg.approveGasUnits * BigInt(cfg.gasSafetyFactor));
  ok("the margin always covers the real cost of an approval", hot > 1_000_000_000n * cfg.approveGasUnits);
  eq("a gas price the RPC fails to return cannot declare everyone ready",
    gasThreshold({ gasPriceWei: null, config: cfg }), cfg.minUsable);

  const msg = buildGasMessage({ address: "0x3C0F7989627AdFdcfd8Ccae1ef093a477d9966e5", amountBtc: 0.00005, nonce: "0xdeadbeef" });
  ok("the message names the address", msg.includes("0x3C0F7989627AdFdcfd8Ccae1ef093a477d9966e5"));
  ok("the message names the amount", msg.includes("0.00005 BTC"));
  ok("the message binds the nonce", msg.includes("0xdeadbeef"));
  ok("the message says signing moves nothing", /authorizes no transfer/i.test(msg));

  const ADDR = "0x3C0F7989627AdFdcfd8Ccae1ef093a477d9966e5";
  const fresh = () => ({ claims: {}, totalDistributed: "0", daily: null });
  const now = Date.now();
  const decide = (over = {}) => evaluateGasClaim({
    address: ADDR, state: fresh(), config: cfg, balanceWei: 0n, needsThresholdWei: live,
    registered: true, operatorBalanceWei: ethers.parseEther("0.09"), now, ...over,
  });

  eq("a wallet with no BTC and a registration is eligible", decide().eligible, true);
  eq("an unregistered address is refused", decide({ registered: false }).reason, "not_registered");
  ok("the unregistered refusal says what to do first",
    /claim MUSD first/i.test(decide({ registered: false }).hint || ""));
  eq("a wallet at the threshold already has gas", decide({ balanceWei: live }).reason, "not_needed");
  eq("one wei below the threshold still qualifies", decide({ balanceWei: live - 1n }).eligible, true);
  eq("a wallet holding a drip's worth has gas", decide({ balanceWei: cfg.amount }).reason, "not_needed");

  // Need is checked BEFORE history: a wallet with gas is refused whatever it
  // claimed yesterday, and the message is the one that explains the real state.
  const claimedRecently = {
    claims: { [ADDR.toLowerCase()]: { lastClaimAt: now - 3_600_000, claims: 1 } },
    totalDistributed: cfg.amount.toString(), daily: null,
  };
  const withHistory = (over = {}) => evaluateGasClaim({
    address: ADDR, state: claimedRecently, config: cfg, balanceWei: 0n, needsThresholdWei: live,
    registered: true, operatorBalanceWei: ethers.parseEther("0.09"), now, ...over,
  });
  eq("a recent claim is refused on cooldown", withHistory().reason, "cooldown");
  ok("a cooldown refusal says when to come back", Boolean(withHistory().nextClaimAt));
  eq("need beats cooldown", withHistory({ balanceWei: live }).reason, "not_needed");
  eq("registration beats need", withHistory({ registered: false }).reason, "not_registered");
  eq("a claim older than the cooldown is allowed again", evaluateGasClaim({
    address: ADDR, config: cfg, balanceWei: 0n, needsThresholdWei: live, registered: true,
    operatorBalanceWei: ethers.parseEther("0.09"), now,
    state: { claims: { [ADDR.toLowerCase()]: { lastClaimAt: now - cfg.cooldownMs - 1000, claims: 1 } }, totalDistributed: "0", daily: null },
  }).eligible, true);

  const today = new Date(now).toISOString().slice(0, 10);
  eq("the daily cap stops the drip", decide({ state: { claims: {}, totalDistributed: "0", daily: { date: today, amount: cfg.dailyCap.toString() } } }).reason, "daily_cap");
  eq("yesterday's spending does not count against today",
    decide({ state: { claims: {}, totalDistributed: "0", daily: { date: "2000-01-01", amount: cfg.dailyCap.toString() } } }).eligible, true);
  eq("the total cap stops the drip", decide({ state: { claims: {}, totalDistributed: cfg.totalCap.toString(), daily: null } }).reason, "total_cap");
  eq("an exhausted budget is marked as such",
    decide({ state: { claims: {}, totalDistributed: cfg.totalCap.toString(), daily: null } }).budgetExhausted, true);

  // The reserve protects the owner key's own gas: it must keep enough to record
  // receipts, register agents and recall float, so the drip stops first.
  const atReserve = cfg.operatorReserve + cfg.amount;
  eq("spending down to exactly the reserve is allowed", decide({ operatorBalanceWei: atReserve }).eligible, true);
  eq("spending below the reserve is refused", decide({ operatorBalanceWei: atReserve - 1n }).reason, "operator_reserve");
  eq("an unreadable operator balance does not block a user", decide({ operatorBalanceWei: null }).eligible, true);

  // The renderer: the operator is spending their own BTC, so they should hear about it.
  const drip = renderEvent({ kind: "gas_drip", amountBtc: 0.00005, txHash: "0xabc123" });
  ok("the gas alert says gas was sent", /Gas sent/i.test(drip), drip.slice(0, 80));
  ok("the gas alert names the amount", drip.includes("0.00005"));
  ok("the gas alert says what it is for", /Permit2 approval/i.test(drip));
  ok("the gas alert is branded", drip.includes("AgentFloat"));
}

// ===========================================================================
console.log(`\n== daily spend: the cap that used not to cap anything =======================\n`);
// A live run sent eight purchases of 0.001 MUSD through a 0.005 MUSD daily cap and
// not one was refused, because the policy compared the payment against the
// contract's `remainingToday` — which is dailyCap - dayFunded, i.e. how much more
// FLOAT the treasury may release today. Nothing in the payment path moves it. Spend
// is summed here from the treasury's own receipts instead.
{
  const MUSD = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
  const DAY = 86_400;
  const today = dayStartSec(Math.floor(Date.now() / 1000));

  // -- the day boundary, which has to be the contract's ----------------------
  eq("the epoch starts a day", dayStartSec(0), 0);
  eq("one second before midnight is still that day", dayStartSec(DAY - 1), 0);
  eq("midnight starts the next", dayStartSec(DAY), DAY);
  eq("a real timestamp floors to UTC midnight",
    dayStartSec(Date.parse("2026-10-25T13:45:00Z") / 1000),
    Date.parse("2026-10-25T00:00:00Z") / 1000);
  eq("nonsense falls back to the epoch rather than NaN", dayStartSec("yesterday"), 0);

  // -- summing receipts ------------------------------------------------------
  const receipt = (amount, ts) => ({ amount, timestamp: ts });
  const newestFirst = [
    receipt(MUSD(0.001), today + 3600),
    receipt(MUSD(0.002), today + 1800),
    receipt(MUSD(9), today - 10),          // yesterday: the scan must stop here
    receipt(MUSD(50), today - DAY),
  ];
  const sum = sumSpentSince(newestFirst, { dayStart: today, lookback: 10 });
  eq("only today's receipts are summed", sum.total, MUSD(0.003));
  eq("and counted", sum.counted, 2);
  eq("a window with yesterday in it is not truncated", sum.truncated, false);
  eq("the oldest receipt seen today is reported", sum.oldestSeen, BigInt(today + 1800));

  const allToday = [receipt(MUSD(0.001), today + 60), receipt(MUSD(0.001), today + 30)];
  eq("a full window of today's receipts is flagged truncated",
    sumSpentSince(allToday, { dayStart: today, lookback: 2 }).truncated, true);
  eq("the same receipts in a bigger window are exact",
    sumSpentSince(allToday, { dayStart: today, lookback: 50 }).truncated, false);
  eq("truncation still reports the lower bound it did sum",
    sumSpentSince(allToday, { dayStart: today, lookback: 2 }).total, MUSD(0.002));

  // paymentsByAgent() is newest-first, but a caller could hand over the other
  // order; breaking early there would silently under-count spend.
  const oldestFirst = [...newestFirst].reverse();
  eq("an oldest-first list is still summed correctly",
    sumSpentSince(oldestFirst, { dayStart: today, lookback: 10 }).total, MUSD(0.003));
  eq("an empty window sums to zero", sumSpentSince([], { dayStart: today }).total, 0n);
  eq("string amounts from an API are handled", sumSpentSince([receipt("1000000000000000", today + 5)], { dayStart: today }).total, MUSD(0.001));
  eq("a receipt with no timestamp is not counted as today", sumSpentSince([{ amount: MUSD(1) }], { dayStart: today }).total, 0n);

  // -- the verdict on one payment -------------------------------------------
  const cap = MUSD(0.005);
  eq("a payment that lands exactly on the cap is allowed",
    judgeDailySpend({ amountWei: MUSD(0.001), spentTodayWei: MUSD(0.004), dailyCapWei: cap }).allowed, true);
  const oneOver = judgeDailySpend({ amountWei: MUSD(0.001) + 1n, spentTodayWei: MUSD(0.004), dailyCapWei: cap });
  eq("one wei over the cap is refused", oneOver.over, true);
  // `over` and `allowed` are read by different callers, so a mutation that widens
  // one and not the other would pass a test that only looked at `over`.
  eq("and one wei over the cap is not allowed", oneOver.allowed, false);
  const atCap = judgeDailySpend({ amountWei: MUSD(0.001), spentTodayWei: MUSD(0.004), dailyCapWei: cap });
  ok("allowed is always the negation of over",
    [atCap, oneOver, judgeDailySpend({ amountWei: 1n, spentTodayWei: cap, dailyCapWei: cap })]
      .every((v) => v.allowed === !v.over));
  eq("the projection is spend plus this payment",
    judgeDailySpend({ amountWei: MUSD(0.001), spentTodayWei: MUSD(0.004), dailyCapWei: cap }).projected, MUSD(0.005));
  eq("what is left is the cap minus spend",
    judgeDailySpend({ amountWei: MUSD(0.001), spentTodayWei: MUSD(0.002), dailyCapWei: cap }).leftToday, MUSD(0.003));
  eq("overspend saturates the remainder at zero instead of going negative",
    judgeDailySpend({ amountWei: MUSD(0.001), spentTodayWei: MUSD(0.02), dailyCapWei: cap }).leftToday, 0n);
  eq("an exhausted cap refuses everything",
    judgeDailySpend({ amountWei: 1n, spentTodayWei: cap, dailyCapWei: cap }).over, true);
  eq("a zero cap refuses any payment",
    judgeDailySpend({ amountWei: 1n, spentTodayWei: 0n, dailyCapWei: 0n }).over, true);
  eq("a truncated window makes an allowance provisional, not certain",
    judgeDailySpend({ amountWei: MUSD(0.001), spentTodayWei: MUSD(0.001), dailyCapWei: cap, truncated: true }).provisional, true);
  eq("and a refusal is a refusal either way",
    judgeDailySpend({ amountWei: cap, spentTodayWei: MUSD(0.001), dailyCapWei: cap, truncated: true }).allowed, false);
  eq("missing spend is treated as nothing spent, by the CALLER's choice",
    judgeDailySpend({ amountWei: MUSD(0.001), dailyCapWei: cap }).spentToday, 0n);
}

console.log(`\n${failures ? `❌ ${failures}/${count} failed` : `✅ all ${count} assertions passed`}\n`);
process.exit(failures ? 1 : 0);
