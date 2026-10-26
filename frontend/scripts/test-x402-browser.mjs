// ---------------------------------------------------------------------------
// Offline tests for src/lib/x402-browser.js — the BROWSER half of an x402 payment.
//
//   npm run test:x402
//
// WHY THESE EXIST
//   This is the one path that cannot be exercised without a real Privy login, so
//   it is also the one that shipped two bugs which only a user could hit:
//
//   1. `signer.signTypedData is not a function`. Passing an ADDRESS to
//      createWalletClient() yields a viem JSON-RPC account — `{ address, type }`,
//      no methods — and that is what was handed to registerExactEvmScheme(). The
//      scheme asks for `{ address, signTypedData }`. The quote worked, the wallet
//      was connected, and the payment died naming a function instead of a cause.
//
//   2. The header NAME is part of the protocol. v1 travels as `X-PAYMENT`; v2 —
//      which is what Mezo's facilitator and its hosted demo speak — travels as
//      `PAYMENT-SIGNATURE`. A relay that guesses the name sends a header nobody
//      reads, the seller answers 402 again, no MUSD moves, and it looks like a
//      settlement failure.
//
//   Both are pinned here against a fake EIP-1193 provider that records every call
//   and signs with a throwaway key — the same technique test-evm-network.mjs uses
//   for the network state machine. No browser, no Privy, no network, no chain.
//
//   The 402 fixture below is the REAL one captured from https://demo.vativ.io/,
//   so the shapes are not invented.
// ---------------------------------------------------------------------------

import { privateKeyToAccount } from "viem/accounts";
import { encodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";

import { makeRelaySigner, makeBrowserPayer, probeUnpaid } from "../src/lib/x402-browser.js";

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

// --- the real v2 offer from Mezo's hosted demo ------------------------------
const ASSET = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
const PAY_TO = "0xC3376296a18ef364eA19287203EEd7a87f18e738";
const PAYMENT_REQUIRED_V2 = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: "https://demo.vativ.io/",
    description: "Mezo x402 Quickstart — pay $0.001 in MUSD to unlock",
    mimeType: "",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:31611",
      amount: "1000000000000000",
      asset: ASSET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { name: "Mezo USD", version: "1", assetTransferMethod: "permit2" },
    },
  ],
};
const V2_HEADER = encodePaymentRequiredHeader(PAYMENT_REQUIRED_V2);

// v1 names the amount differently and carries an array of requirements. Parsing
// both is what stops a correct 402 from reading as "no offer found".
const PAYMENT_REQUIRED_V1 = {
  x402Version: 1,
  error: "Payment required",
  accepts: [
    {
      scheme: "exact",
      network: "eip155:31611",
      maxAmountRequired: "1000000000000000",
      resource: "https://demo.vativ.io/",
      description: "v1 shaped offer",
      outputSchema: undefined,
      maxTimeoutSeconds: 300,
      asset: ASSET,
      payTo: PAY_TO,
      extra: { name: "Mezo USD", version: "1", assetTransferMethod: "permit2" },
    },
  ],
};
const V1_HEADER = encodePaymentRequiredHeader(PAYMENT_REQUIRED_V1);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

/**
 * A Privy-shaped wallet: `address` + `getEthereumProvider()`, where the provider
 * is a bare EIP-1193 object that signs with a throwaway key. Every request is
 * recorded, so a test can assert that signing really went THROUGH the transport
 * rather than through a local key we happened to have.
 */
function fakeWallet(pk = "0x5b2f6c9a0d4e8f2a1c3b5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f41") {
  const account = privateKeyToAccount(pk);
  const calls = [];
  const provider = {
    calls,
    async request({ method, params }) {
      calls.push(method);
      switch (method) {
        case "eth_chainId":
          return "0x7b7b"; // 31611
        case "eth_signTypedData_v4": {
          const typed = JSON.parse(params[1]);
          return account.signTypedData({
            domain: typed.domain,
            types: typed.types,
            primaryType: typed.primaryType,
            message: typed.message,
          });
        }
        case "personal_sign":
          return account.signMessage({ message: params[0] });
        default:
          throw Object.assign(new Error(`unsupported method ${method}`), { code: -32601 });
      }
    },
  };
  return { address: account.address, walletClientType: "privy", provider, getEthereumProvider: async () => provider };
}

console.log("\n== x402 in the browser: signer shape, header names, offer parsing ==\n");

// --- 1. the relay signer ----------------------------------------------------
const wallet = fakeWallet();
const signer = await makeRelaySigner(wallet);

ok("makeRelaySigner returns the documented surface",
  signer.address === wallet.address && typeof signer.signProbe === "function" && typeof signer.parseResult === "function");

const probe = {
  status: 402,
  headers: { "content-type": "application/json", "payment-required": V2_HEADER },
  body: JSON.stringify(PAYMENT_REQUIRED_V2),
};

let signed;
try {
  signed = await signer.signProbe(probe);
} catch (e) {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m signProbe threw — ${e.message}`);
  console.log("      This is the user-visible failure: the wallet is connected and the");
  console.log("      quote is correct, but the scheme could not sign it.");
}

if (signed) {
  ok("signing went through the EIP-1193 transport (not a local key)",
    wallet.provider.calls.includes("eth_signTypedData_v4"),
    `calls seen: ${JSON.stringify(wallet.provider.calls)}`);

  const names = Object.keys(signed.paymentHeaders || {});
  eq("a v2 payment travels as PAYMENT-SIGNATURE", names.join(","), "PAYMENT-SIGNATURE");
  ok("paymentHeaders carries the value the client produced",
    signed.payment && signed.payment === signed.paymentHeaders["PAYMENT-SIGNATURE"]);

  const decoded = decodePaymentSignatureHeader(signed.payment);
  eq("payload is protocol v2", decoded.x402Version, 2);
  eq("payer is the signed-in wallet",
    String(decoded.payload?.permit2Authorization?.from || "").toLowerCase(), wallet.address.toLowerCase());
  eq("amount is the seller's price", decoded.payload?.permit2Authorization?.permitted?.amount, "1000000000000000");
  eq("asset is canonical MUSD", decoded.payload?.permit2Authorization?.permitted?.token, ASSET);
  eq("payee is the seller's payTo", decoded.payload?.permit2Authorization?.witness?.to, PAY_TO);
  eq("accepted requirement echoes the network", decoded.accepted?.network, "eip155:31611");
  ok("a signature is present", /^0x[0-9a-fA-F]{130}$/.test(String(decoded.payload?.signature || "")),
    `signature: ${String(decoded.payload?.signature).slice(0, 24)}…`);

  // The gateway decodes this same header to enforce the caps, so the fields the
  // relay reads must be the fields the wallet signed.
  ok("the relay can attribute and price this payment",
    Boolean(decoded.payload?.permit2Authorization?.from) && Boolean(decoded.accepted?.amount));

  const settled = signer.parseResult({
    status: 200,
    headers: { "content-type": "application/json", "payment-response": b64({ success: true, transaction: "0xabc123" }) },
    body: '{"ok":true,"message":"Paid!"}',
  });
  ok("parseResult reads a relayed settlement without throwing", Boolean(settled), JSON.stringify(settled)?.slice(0, 120));
}

// --- 2. the direct-from-browser payer ---------------------------------------
// Stubbed fetch: first call returns the 402, second call must carry the payment
// header and returns the resource. This is the whole browser flow offline, and it
// is what proves the "Failed to fetch" a user sees on this path is CORS and not
// signing — everything here signs and settles with no network at all.
const realFetch = globalThis.fetch;
let seen = [];
const headersOf = (input, init) => {
  // The wrapper may call fetch(url, { headers }) or fetch(new Request(url, { headers })).
  const h = new Headers(init?.headers || (input && typeof input === "object" && input.headers) || {});
  return { paymentSignature: h.get("payment-signature"), xPayment: h.get("x-payment") };
};

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  seen.push({ url, ...headersOf(input, init) });
  if (seen.length === 1) {
    return new Response(JSON.stringify(PAYMENT_REQUIRED_V2), {
      status: 402,
      headers: { "content-type": "application/json", "payment-required": V2_HEADER },
    });
  }
  return new Response('{"ok":true,"message":"Paid! You unlocked the Mezo x402 Quickstart."}', {
    status: 200,
    headers: {
      "content-type": "application/json",
      "payment-response": b64({ success: true, transaction: "0xdeadbeef", network: "eip155:31611" }),
    },
  });
};

try {
  const payer = await makeBrowserPayer(fakeWallet());
  ok("makeBrowserPayer exposes a paying fetch", typeof payer.fetchWithPay === "function");

  const res = await payer.fetchWithPay("https://demo.vativ.io/");
  const text = await res.text();
  eq("the paid request returned the resource", res.status, 200);
  ok("the resource body came back", text.includes("unlocked"), text.slice(0, 80));
  eq("two fetches happened: unpaid probe, then paid", seen.length, 2);
  ok("the second request carried PAYMENT-SIGNATURE", Boolean(seen[1]?.paymentSignature),
    `headers seen: ${JSON.stringify({ ps: Boolean(seen[1]?.paymentSignature), xp: Boolean(seen[1]?.xPayment) })}`);
  ok("the first request carried no payment header", !seen[0]?.paymentSignature && !seen[0]?.xPayment);

  const paid = decodePaymentSignatureHeader(seen[1].paymentSignature);
  eq("the direct path also pays as the signed-in wallet",
    String(paid.payload?.permit2Authorization?.from || "").toLowerCase(), payer.address.toLowerCase());

  // --- 3. probeUnpaid parses both protocol versions --------------------------
  seen = [];
  globalThis.fetch = async () => new Response(JSON.stringify(PAYMENT_REQUIRED_V2), {
    status: 402,
    headers: { "content-type": "application/json", "payment-required": V2_HEADER },
  });
  const q2 = await probeUnpaid("https://demo.vativ.io/");
  eq("v2 offer: amount read from accepts[]", q2.offer?.amount, "1000000000000000");
  eq("v2 offer: asset", q2.offer?.asset, ASSET);
  eq("v2 offer: payee", q2.offer?.payTo, PAY_TO);
  eq("v2 offer: transfer method from extra", q2.offer?.transferMethod, "permit2");
  eq("v2 offer: description", q2.description?.includes("Mezo x402 Quickstart"), true);

  globalThis.fetch = async () => new Response(JSON.stringify(PAYMENT_REQUIRED_V1), {
    status: 402,
    headers: { "content-type": "application/json", "x-payment-required": V1_HEADER },
  });
  const q1 = await probeUnpaid("https://demo.vativ.io/");
  eq("v1 offer: amount read from maxAmountRequired", q1.offer?.amount, "1000000000000000");
  eq("v1 offer: payee", q1.offer?.payTo, PAY_TO);

  globalThis.fetch = async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  const free = await probeUnpaid("https://demo.vativ.io/free");
  eq("a free endpoint is reported as free", free.requiresPayment, false);
  eq("a free endpoint has no offer", free.offer, null);
} finally {
  globalThis.fetch = realFetch;
}

console.log(
  `\n${failures ? `❌ ${failures} of ${count} failed` : `✅ all ${count} assertions passed`}\n`
);
process.exit(failures ? 1 : 0);
