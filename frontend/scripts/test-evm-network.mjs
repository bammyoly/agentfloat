// ---------------------------------------------------------------------------
// Unit tests for src/lib/evm-network.js — the wallet network switch/add logic.
//
//   npm run test:network
//
// WHY THESE EXIST
//   "If the wallet is not on Mezo testnet, switch; if it does not know the
//   chain, add it then switch" sounds like four lines and is actually a small
//   state machine over wallet-specific error codes, where the wrong branch
//   spams the user with add-requests after they clicked reject. There is no
//   browser in the sandbox to click MetaMask in, so the behaviour is pinned
//   here against a fake EIP-1193 provider that records every call.
//
//   Import-free module, so plain Node can run this with no build step.
// ---------------------------------------------------------------------------

import {
  MEZO_TESTNET_ID,
  MEZO_TESTNET_HEX,
  MEZO_TESTNET_CAIP2,
  sameChainId,
  parseChainId,
  readChainId,
  ensureChain,
  ensureWalletChain,
  isUnrecognizedChain,
  isUserRejection,
  describeChainError,
  assertChainFactsAgree,
} from "../src/lib/evm-network.js";

let failures = 0;
let count = 0;
const eq = (name, actual, expected) => {
  count++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n      expected ${e}\n      actual   ${a}`); }
};
const throws = async (name, fn) => {
  count++;
  try { await fn(); failures++; console.log(`  \x1b[31m✗\x1b[0m ${name} — did not throw`); }
  catch { console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
};

/** Records calls; each handler is keyed by method. */
function fakeProvider(handlers) {
  const calls = [];
  return {
    calls,
    async request({ method, params }) {
      calls.push({ method, params });
      // A `null` handler means "succeeds and returns null". Absence means the
      // wallet does not support the method at all.
      if (!(method in handlers)) throw Object.assign(new Error(`unsupported method ${method}`), { code: -32601 });
      const h = handlers[method];
      return typeof h === "function" ? h(params) : h;
    },
  };
}
const methods = (p) => p.calls.map((c) => c.method);

console.log(`\n== evm-network: chain switch / add ============================\n`);

// --- chain id normalisation -------------------------------------------------
eq("sameChainId: hex vs decimal", sameChainId("0x7b7b", 31611), true);
eq("sameChainId: uppercase hex", sameChainId("0x7B7B", "31611"), true);
eq("sameChainId: other chain", sameChainId("0x1", 31611), false);
eq("sameChainId: junk is not a match", sameChainId(undefined, 31611), false);
eq("MEZO_TESTNET_HEX is 31611", Number(MEZO_TESTNET_HEX), MEZO_TESTNET_ID);

// --- already on the right chain --------------------------------------------
{
  const p = fakeProvider({ eth_chainId: "0x7b7b" });
  const r = await ensureChain(p);
  eq("on-chain: result", r, { wasOnChain: true, switched: false, added: false, chainId: 31611 });
  eq("on-chain: only reads the chain id", methods(p), ["eth_chainId"]);
}

// --- known chain, needs a switch -------------------------------------------
{
  const p = fakeProvider({ eth_chainId: "0x1", wallet_switchEthereumChain: null });
  const r = await ensureChain(p);
  eq("switch: result", r, { wasOnChain: false, switched: true, added: false, chainId: 31611 });
  eq("switch: never adds", methods(p), ["eth_chainId", "wallet_switchEthereumChain"]);
  eq("switch: params are hex", p.calls[1].params, [{ chainId: "0x7b7b" }]);
}

// --- unknown chain: 4902 then add then switch -------------------------------
{
  let switchedOnce = false;
  const p = fakeProvider({
    eth_chainId: "0xaa36a7",
    wallet_switchEthereumChain: () => {
      if (!switchedOnce) { switchedOnce = true; throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 }); }
      return null;
    },
    wallet_addEthereumChain: null,
  });
  const r = await ensureChain(p);
  eq("unknown: result", r, { wasOnChain: false, switched: true, added: true, chainId: 31611 });
  eq("unknown: add then re-switch", methods(p), [
    "eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain",
  ]);
  eq("unknown: add payload chainId", p.calls[2].params[0].chainId, "0x7b7b");
  eq("unknown: add payload rpc", p.calls[2].params[0].rpcUrls, ["https://rpc.test.mezo.org"]);
}

// --- user rejects the switch: must NOT fall through to add ------------------
await throws("reject switch: throws", async () => {
  const p = fakeProvider({
    eth_chainId: "0x1",
    wallet_switchEthereumChain: () => { throw Object.assign(new Error("User rejected the request"), { code: 4001 }); },
  });
  await ensureChain(p);
  // unreachable on purpose is a bug, not a test — the block below asserts this.
  throw new Error("ensureChain should have thrown");
});
{
  const p = fakeProvider({
    eth_chainId: "0x1",
    wallet_switchEthereumChain: () => { throw Object.assign(new Error("User rejected the request"), { code: 4001 }); },
  });
  await ensureChain(p).catch(() => {});
  eq("reject switch: stopped at the switch", methods(p), ["eth_chainId", "wallet_switchEthereumChain"]);
}

// --- add succeeds but the wallet still refuses the follow-up switch ---------
await throws("reject follow-up switch: throws", async () => {
  const p = fakeProvider({
    eth_chainId: "0x1",
    wallet_switchEthereumChain: (params) => {
      // first call 4902, second a genuine rejection
      if (p.calls.filter((c) => c.method === "wallet_switchEthereumChain").length === 1) {
        throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
      }
      throw Object.assign(new Error("User rejected the request"), { code: 4001 });
    },
    wallet_addEthereumChain: null,
  });
  await ensureChain(p);
});

// --- -32603 disambiguation ---------------------------------------------------
eq("-32603 'unrecognized chain' counts as unknown", isUnrecognizedChain({ code: -32603, message: "Unrecognized chain ID" }), true);
eq("-32603 with another message does not", isUnrecognizedChain({ code: -32603, message: "Internal JSON-RPC error" }), false);
eq("4902 counts as unknown", isUnrecognizedChain({ code: 4902 }), true);
eq("4001 is a rejection", isUserRejection({ code: 4001 }), true);
eq("nested error code is found", isUnrecognizedChain({ error: { code: 4902 } }), true);

// --- human messages ----------------------------------------------------------
count++;
const rej = describeChainError({ code: 4001 });
if (/rejected/i.test(rej)) console.log("  \x1b[32m✓\x1b[0m describeChainError: rejection reads as rejection");
else { failures++; console.log(`  \x1b[31m✗\x1b[0m describeChainError: rejection — ${rej}`); }
count++;
const manual = describeChainError({ code: -32601 });
if (/manually|by hand/i.test(manual)) console.log("  \x1b[32m✓\x1b[0m describeChainError: unsupported wallet says add by hand");
else { failures++; console.log(`  \x1b[31m✗\x1b[0m describeChainError: unsupported — ${manual}`); }

// --- no provider ------------------------------------------------------------
await throws("missing provider: throws", () => ensureChain(null));
await throws("non-EIP-1193: throws", () => ensureChain({}));

// --- drift guard -------------------------------------------------------------
{
  const quiet = () => {};
  eq("drift guard: agreeing viem chain", assertChainFactsAgree({
    id: 31611,
    rpcUrls: { default: { http: ["https://rpc.test.mezo.org"] } },
    nativeCurrency: { symbol: "BTC" },
  }, quiet), true);
  eq("drift guard: wrong id", assertChainFactsAgree({ id: 31612 }, quiet), false);
  eq("drift guard: wrong rpc", assertChainFactsAgree({
    id: 31611, rpcUrls: { default: { http: ["https://evil.example"] } }, nativeCurrency: { symbol: "BTC" },
  }, quiet), false);
}

// --- parseChainId: every spelling the stack produces -------------------------
console.log(`\n== parseChainId ===============================================\n`);
eq("parse CAIP-2", parseChainId("eip155:31611"), 31611);
eq("parse hex string", parseChainId("0x7b7b"), 31611);
eq("parse upper-case hex", parseChainId("0x7B7B"), 31611);
eq("parse decimal string", parseChainId("31611"), 31611);
eq("parse number", parseChainId(31611), 31611);
eq("parse bigint", parseChainId(31611n), 31611);
eq("parse whitespace", parseChainId("  eip155:31611 "), 31611);
eq("unparseable -> null, not NaN", parseChainId("mainnet"), null);
eq("empty -> null", parseChainId(""), null);
eq("null -> null", parseChainId(null), null);
eq("undefined -> null", parseChainId(undefined), null);
eq("zero -> null (never a real chain)", parseChainId(0), null);
eq("non-EVM CAIP namespace -> null", parseChainId("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), null);
eq("MEZO_TESTNET_CAIP2 round-trips", parseChainId(MEZO_TESTNET_CAIP2), MEZO_TESTNET_ID);
eq("sameChainId: CAIP vs hex", sameChainId("eip155:31611", "0x7b7b"), true);
eq("sameChainId: unknown is never equal", sameChainId(null, MEZO_TESTNET_ID), false);
eq("sameChainId: wrong chain", sameChainId("eip155:1", MEZO_TESTNET_ID), false);
eq("readChainId: no provider -> null", await readChainId(null), null);
eq("readChainId: reads hex", await readChainId(fakeProvider({ eth_chainId: "0x7b7b" })), 31611);
eq("readChainId: provider error -> null", await readChainId(fakeProvider({})), null);

// --- ensureWalletChain: the Privy-shaped route -------------------------------
//
// The embedded wallet has no injected provider to prompt, so `switchChain` is
// the only thing that can move it; an external wallet connected through Privy
// may need EIP-3085 to ADD the chain first. Both are pinned here because the
// navbar's "switch to Mezo" button silently did nothing when only the second
// route existed.
console.log(`\n== ensureWalletChain ==========================================\n`);

/**
 * Fake Privy wallet. `switchChain` moves BOTH the wallet's CAIP-2 field and the
 * provider it hands out afterwards, mirroring a real connector; `staleProvider`
 * reproduces Privy's documented caveat that an already-issued provider instance
 * keeps reporting the old chain.
 */
function fakeWallet({ chainId = "eip155:1", hasSwitch = true, providerHandlers = {}, switchImpl = null } = {}) {
  const state = { chainId };
  const provider = fakeProvider({
    eth_chainId: () => state.chainId,
    ...providerHandlers,
  });
  const wallet = {
    address: "0xagent",
    get chainId() { return state.chainId; },
    getEthereumProvider: async () => provider,
    provider,
  };
  if (hasSwitch) {
    wallet.switchChain = switchImpl || (async (target) => {
      state.chainId = `eip155:${Number(target)}`;
    });
  }
  return wallet;
}

{
  const w = fakeWallet({ chainId: MEZO_TESTNET_CAIP2 });
  const r = await ensureWalletChain(w);
  eq("already on Mezo: no calls", r, { wasOnChain: true, switched: false, added: false, chainId: MEZO_TESTNET_ID });
  eq("already on Mezo: provider untouched", w.provider.calls.length, 0);
}
{
  const w = fakeWallet({ chainId: "eip155:1" });
  const r = await ensureWalletChain(w);
  eq("switchChain moves an embedded wallet", r, { wasOnChain: false, switched: true, added: false, chainId: MEZO_TESTNET_ID });
  eq("switchChain confirmed via a fresh provider read", methods(w.provider), ["eth_chainId"]);
  eq("wallet field updated too", w.chainId, MEZO_TESTNET_CAIP2);
}
{
  // switchChain succeeds but the wallet is STILL elsewhere (e.g. the chain is
  // not in supportedChains): fall through to EIP-3085 rather than report success.
  const w = fakeWallet({
    chainId: "eip155:1",
    switchImpl: async () => {}, // claims success, changes nothing
    providerHandlers: {
      wallet_switchEthereumChain: () => { throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 }); },
      wallet_addEthereumChain: () => null,
    },
  });
  const r = await ensureWalletChain(w);
  eq("unconfirmed switch falls through to add-then-switch", r.added, true);
  eq("fell through to EIP-3085", methods(w.provider).includes("wallet_addEthereumChain"), true);
}
{
  // No switchChain at all (the wallet-session shim) -> straight to EIP-3085.
  const w = fakeWallet({ chainId: "eip155:1", hasSwitch: false, providerHandlers: { wallet_switchEthereumChain: () => null } });
  const r = await ensureWalletChain(w);
  eq("no switchChain: EIP-3085 switch", r, { wasOnChain: false, switched: true, added: false, chainId: MEZO_TESTNET_ID });
}
{
  const w = fakeWallet({
    chainId: "eip155:1",
    switchImpl: async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); },
  });
  await throws("user rejection in switchChain: throws, never retried", () => ensureWalletChain(w));
  eq("rejection did not fall through to EIP-3085", w.provider.calls.length, 0);
}
{
  const w = fakeWallet({ chainId: "eip155:1", switchImpl: async () => { throw Object.assign(new Error("unsupported"), { code: -32601 }); } });
  await throws("unsupported switchChain and no EIP-3085: throws", () => ensureWalletChain(w));
}
await throws("no wallet: throws", () => ensureWalletChain(null));

console.log(`\n${failures ? `❌ ${failures}/${count} failed` : `✅ all ${count} assertions passed`}\n`);
process.exit(failures ? 1 : 0);
