// ---------------------------------------------------------------------------
// AgentFloat — policy gateway
//
//   cd frontend/server && npm install && npm start
//
// This process plays TWO roles so the demo is self-contained:
//
//   1. SELLER   GET /paid/insight — an x402-protected endpoint priced in MUSD
//               on Mezo testnet. Stands in for a third-party paid API.
//   2. GATEWAY  POST /api/pay — the agent's ONLY route to the internet. It
//               reads the seller's 402 quote, applies the human-set policy, and
//               only then signs. Denied attempts are recorded, not silently
//               dropped.
//
// WHY THE KEY LIVES HERE AND NOT IN THE BROWSER
//   The agent wallet is an EOA because x402 authorisation is an EIP-712 permit2
//   signature, which a contract cannot produce. The React app never sees this
//   key: it calls /api/* and this process signs. The gateway binds to
//   127.0.0.1 only — Vite proxies /api to it, so the key is never exposed.
//
// ASSET VALIDATION (important)
//   Mezo testnet has TWO tokens reporting name="Mezo USD", symbol="MUSD",
//   decimals=18. Only 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 is in the x402
//   facilitator registry. Every 402 quote is checked against it before signing,
//   so a malicious or misconfigured seller cannot get the agent to sign a
//   transfer of some other token. See DEPLOYMENT-BRIEF.md §3.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ethers } from "ethers";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFaucetRouter } from "./faucet.js";
import { createGasRouter } from "./gas.js";
import { createLimitsRouter } from "./limits.js";
import { createTelegram } from "./telegram.js";
import { dayStartSec, judgeDailySpend, sumSpentSince } from "./spend.js";
import {
  RelayError, assertRelayable, decodeOffer, executeWithPayment,
  inspectPaymentHeader, probeSeller,
} from "./relay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from THIS folder, never from the cwd. A bare `import "dotenv/config"`
// reads process.cwd(), so launching the gateway from anywhere other than its own
// directory (e.g. `npm run gateway` from frontend/) silently loaded nothing and
// left x402 unarmed — no error, just a gateway that cannot sign.
dotenv.config({ path: path.join(__dirname, ".env") });

// The generated deployment artifacts live in the React app's source tree.
// This folder moved to the repo root, so the path gains a "frontend" segment.
const CONTRACTS_DIR = path.resolve(__dirname, "..", "frontend", "src", "contracts");

// --- config ----------------------------------------------------------------
// PORT: a platform's injected PORT wins over ours. Render and Railway set PORT
// and treat a service that ignores it as unhealthy, so it never comes up;
// GATEWAY_PORT stays the local default and the name Vite's proxy reads.
const PORT = Number(process.env.PORT || process.env.GATEWAY_PORT || 4022);
// HOST: defaults to loopback because this process holds a private key, and on a
// laptop that is the whole security model. A PaaS cannot proxy to 127.0.0.1, so
// GATEWAY_HOST=0.0.0.0 is how it is deployed — and binding 0.0.0.0 is ONLY safe
// because two things below travel with it: an origin allowlist (CORS) and an
// admin token on the kill switch. Setting one without the others is what turns
// "deployed" into "exposed".
const HOST = process.env.GATEWAY_HOST || "127.0.0.1";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://facilitator.vativ.io";
const SELLER_PRICE = process.env.SELLER_PRICE || "$0.001";

/** True when this process answers to something other than the machine it runs on. */
const IS_PUBLIC = !["127.0.0.1", "localhost", "::1"].includes(HOST);

// Where the four *-state.json files live. Render's filesystem is EPHEMERAL —
// wiped on every deploy and restart — so the faucet cooldowns, the gas-drip caps,
// the self-service budget audit trail and the Telegram bindings would all reset,
// and a restart would become a way to claim the faucet again. Point this at a
// mounted disk in production (Render: /var/data). Locally it stays beside the
// code, where it always was.
const STATE_DIR = process.env.STATE_DIR || __dirname;
const stateFile = (name) => path.join(STATE_DIR, name);
// A mounted disk that has not been written to yet may not exist, and every one
// of these files is written lazily — on the first claim, the first drip, the
// first cap change. Creating the directory at boot turns "the faucet silently
// forgot every cooldown" into a startup error that names the path.
try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
} catch (e) {
  log(`  ⚠️  STATE_DIR ${STATE_DIR} is not usable: ${e.message}`);
}

// --- who may call this gateway from a browser ------------------------------
// Comma-separated origins. An entry may be a scheme+wildcard host
// (https://*.vercel.app) to cover preview deployments. Loopback origins are
// always allowed so `npm run dev` keeps working with no configuration.
const ALLOWED_ORIGINS = (process.env.GATEWAY_ALLOWED_ORIGINS || "")
  .split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);

const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compile one allowlist entry into an anchored regex.
 *
 *   *                    -> anything (say so in the log; it is a real choice)
 *   https://app.com      -> that origin exactly
 *   https://*.vercel.app -> that host or ANY depth of subdomain
 *
 * Compiled once at boot rather than per request, and anchored at both ends: an
 * unanchored pattern is how `https://app.com.evil.example` gets through a list
 * that only meant to allow `https://app.com`.
 */
function compileOrigin(pattern) {
  if (pattern === "*") return () => true;
  if (!pattern.includes("*")) {
    const want = pattern.toLowerCase();
    return (o) => o.toLowerCase() === want;
  }
  const body = escapeRe(pattern)
    // `*.` means "a SUBDOMAIN of", so it requires at least one label: `+`, not
    // `*`. With `*` the pattern also matched the apex domain — and since
    // vercel.app is a shared apex, that meant every *.vercel.app deployment in
    // the world, including a stranger's, could call a gateway that holds a
    // signing key. Found by curling https://vercel.app at a live instance.
    .replace(/\\\*\\\./g, "(?:[a-z0-9-]+\\.)+")
    // any other `\*` -> one DNS label, no dots (cannot span into another host)
    .replace(/\\\*/g, "[a-z0-9-]+");
  const re = new RegExp(`^${body}$`, "i");
  // Bound once, and deliberately WITHOUT the /g flag: a global regex is
  // stateful (lastIndex), so binding test() to one and calling it per request
  // would alternate between matching and not matching the same origin.
  return (o) => re.test(o);
}
const ORIGIN_TESTS = ALLOWED_ORIGINS.map(compileOrigin);

/** Loopback is always allowed, so `npm run dev` needs no configuration. */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i;

function originAllowed(origin) {
  if (!origin) return true;                     // no Origin header: not a browser
  const o = origin.replace(/\/+$/, "");
  if (o === "null") return false;               // sandboxed iframe / file://
  if (LOOPBACK_ORIGIN.test(o)) return true;
  return ORIGIN_TESTS.some((test) => test(o));
}

/**
 * Owner-style commands need this token WHEN ONE IS SET, and only then.
 *
 * /api/pause and /api/unpause are the kill switch. Behind loopback that was
 * fine: the only thing that could reach them was the dashboard on the same
 * machine. On a public URL an unauthenticated pause is a one-line denial of
 * service against a live demo. Local dev sets no token and keeps working with
 * no ceremony. The token is NOT a wallet signature and must never be shipped in
 * the browser bundle as a way to make the button work for everyone — that would
 * publish it.
 */
const ADMIN_TOKEN = (process.env.GATEWAY_ADMIN_TOKEN || "").trim();

// This process's own origins. Used to exempt the built-in demo seller from the
// SSRF guard — the gateway is allowed to call itself, but nothing else internal.
const SELF_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);
/** The URL the agent should use to reach the built-in seller. */
const SELLER_SELF_URL = `http://127.0.0.1:${PORT}/paid/insight`;
/**
 * The SAME endpoint as the gateway's own browser will reach it.
 *
 * SELLER_SELF_URL is loopback because the gateway fetches it server-side. On a
 * deployed frontend that string is useless to a browser — 127.0.0.1 is the
 * reader's own machine — so the Spend page offers this path instead and lets its
 * own origin resolve it (Vite proxy locally, vercel.json rewrite in production).
 */
const SELLER_BROWSER_PATH = "/paid/insight";

// How long to wait for an on-chain receipt to CONFIRM before responding anyway.
// The Mezo testnet RPC frequently never resolves tx.wait() even after the tx has
// landed, so this bounds the wait instead of hanging /api/pay indefinitely.
const RECEIPT_CONFIRM_MS = Number(process.env.RECEIPT_CONFIRM_MS || 20_000);

// Canonical Permit2 — identical address on every EVM chain it is deployed to.
// x402 on Mezo settles via `assetTransferMethod: permit2`, so the agent wallet
// MUST have approved this contract to spend its MUSD or every payment is
// rejected with HTTP 412. Distinct from the treasury recall allowance.
const PERMIT2 = ethers.getAddress(
  process.env.PERMIT2_ADDRESS || "0x000000000022D473030F116dDEE9F6B43aC78BA3"
);

function loadDeployment() {
  const depPath = path.join(CONTRACTS_DIR, "deployment.json");
  const chainPath = path.join(CONTRACTS_DIR, "chain.json");
  const agentsPath = path.join(CONTRACTS_DIR, "agents.json");
  if (!fs.existsSync(depPath) || !fs.existsSync(chainPath)) {
    return null;
  }
  const deployment = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const chain = JSON.parse(fs.readFileSync(chainPath, "utf8"));
  const agents = fs.existsSync(agentsPath) ? JSON.parse(fs.readFileSync(agentsPath, "utf8")).agents : [];
  return { deployment, chain, agents };
}

const ctx = loadDeployment();

const log = (...a) => console.log(...a);
const fmtMusd = (wei) => Number(ethers.formatUnits(BigInt(wei || 0), 18));

// --- state -----------------------------------------------------------------
// In-process policy state. The authoritative caps live on-chain in the treasury;
// this mirrors them so the gateway can refuse BEFORE spending gas or signing.
const state = {
  startedAt: Date.now(),
  paused: false,
  pausedReason: null,
  // Endpoints the agent may pay. Empty array = allow any https URL.
  allowlist: (process.env.ALLOWED_ENDPOINTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  receipts: [],   // settled payments, newest first
  denials: [],    // refused attempts, newest first
  treasurySigner: null,
};

let x402 = null; // { account, fetchWithPay } once configured

function initAgent() {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key || !key.startsWith("0x") || key.length !== 66) {
    log("  ⚠️  AGENT_PRIVATE_KEY missing/invalid — x402 payments disabled.");
    log("     Run: cd ../../contract && npx hardhat run scripts/setup-agent.js --network mezoTestnet");
    return;
  }
  const account = privateKeyToAccount(key);
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: account,
    networks: [ctx ? ctx.chain.caip2 : "eip155:31611"],
    schemeOptions: { rpcUrl: ctx ? ctx.chain.rpcUrl : "https://rpc.test.mezo.org" },
  });
  x402 = { account, fetchWithPay: wrapFetchWithPayment(fetch, client) };
  log(`  agent wallet   ${account.address}`);

  // Optional: a funded key that can write receipts to the treasury contract.
  const tk = process.env.GATEWAY_SIGNER_PRIVATE_KEY;
  if (tk && ctx) {
    const provider = new ethers.JsonRpcProvider(ctx.chain.rpcUrl, Number(ctx.chain.chainId));
    state.treasurySigner = new ethers.Wallet(tk, provider);
    log(`  receipt signer ${state.treasurySigner.address} (on-chain receipts enabled)`);
  } else {
    log(`  receipt signer none — receipts stay gateway-local (labelled in the UI)`);
  }
}

// --- read-only chain access ------------------------------------------------
function readOnlyProvider() {
  if (!ctx) return null;
  return new ethers.JsonRpcProvider(ctx.chain.rpcUrl, Number(ctx.chain.chainId));
}

const TREASURY_READ_ABI = [
  "function paused() view returns (bool)",
  "function treasuryBalance() view returns (uint256)",
  "function totalFunded() view returns (uint256)",
  "function totalRecalled() view returns (uint256)",
  "function paymentCount() view returns (uint256)",
  "function denialCount() view returns (uint256)",
  "function isRegistered(address) view returns (bool)",
  "function agents(address) view returns (tuple(bool active, uint64 registeredAt, address gateway, uint128 perCallMax, uint128 dailyCap, uint128 dayFunded, uint64 dayIndex, uint256 totalFunded, uint256 totalRecalled))",
  "function agentStatus(address) view returns (tuple(bool active, address gateway, uint128 perCallMax, uint128 dailyCap, uint128 dayFunded, uint256 remainingToday, uint256 walletBalance, uint256 lifetimeFunded, uint256 lifetimeRecalled, uint256 recallAllowance, uint256 payments, uint256 denials))",
  "function recentPayments(uint256) view returns (tuple(address agent, address payee, uint256 amount, uint64 timestamp, bytes32 settlementTx, string endpoint)[])",
  "function recentDenials(uint256) view returns (tuple(address agent, uint256 attempted, uint64 timestamp, string endpoint, string reason)[])",
  // Per-agent history: what the telegram watcher reports and what a user's own
  // ledger page can show without reading the operator's demo agent.
  "function paymentsByAgent(address agent, uint256 limit) view returns (tuple(address agent, address payee, uint256 amount, uint64 timestamp, bytes32 settlementTx, string endpoint)[])",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  // Needed to check the agent's Permit2 allowance, without which x402
  // settlement fails with HTTP 412 even though policy allows the payment.
  "function allowance(address,address) view returns (uint256)",
];

async function treasury() {
  // Guard the placeholder state: before deploy.js runs, deployment.address is
  // null and constructing a Contract against it throws "invalid value for
  // Contract target". Returning null lets callers skip chain policy reads
  // cleanly instead of surfacing a confusing error in the UI.
  if (!ctx || !ctx.deployment.address) return null;
  const p = readOnlyProvider();
  return new ethers.Contract(ctx.deployment.address, TREASURY_READ_ABI, p);
}

async function musd() {
  if (!ctx) return null;
  const p = readOnlyProvider();
  return new ethers.Contract(ctx.chain.musd.address, ERC20_ABI, p);
}

// --- policy ----------------------------------------------------------------
// The differentiator. Nothing gets signed until this passes.
// `agent` is optional and defaults to the gateway's demo agent, so every
// existing caller is unchanged. The relay passes the USER's agent address, which
// is what makes the same policy engine apply to a wallet this process holds no
// key for: the caps are read from the treasury for whoever is actually paying.
// --- today's spend ---------------------------------------------------------
/**
 * How many on-chain receipts to read when summing a day's spending. Bounded
 * because it is a view call over a growing array; `truncated` says when the window
 * was too small to be exact, and the policy then refuses rather than guesses.
 */
const DAILY_SPEND_LOOKBACK = Number(process.env.DAILY_SPEND_LOOKBACK || 300);

/**
 * Start of today, in UTC seconds, read from the CHAIN.
 *
 * Block timestamps are what the receipts are stamped with, so they are also what
 * the day boundary must come from: a host clock that is minutes fast would move a
 * payment into tomorrow and quietly reset somebody's budget. Cached for a minute
 * because a day is 86 400 seconds wide and this is called on every payment.
 */
let dayCache = { at: 0, value: 0 };
async function chainDayStartSec() {
  const nowMs = Date.now();
  if (dayCache.value && nowMs - dayCache.at < 60_000) return dayCache.value;
  let sec = Math.floor(nowMs / 1000);
  try {
    const p = readOnlyProvider();
    const b = p ? await p.getBlock("latest") : null;
    if (b?.timestamp) sec = Number(b.timestamp);
  } catch { /* the host clock is the fallback; the boundary is a day wide */ }
  dayCache = { at: nowMs, value: dayStartSec(sec) };
  return dayCache.value;
}

/**
 * MUSD one agent has spent today, summed from the treasury's own receipts.
 *
 * `error` is returned rather than thrown, and is NEVER collapsed into `total: 0n`:
 * an unreadable budget must not read as an unspent one.
 */
async function spentTodayWei(t, agentAddr) {
  try {
    const dayStart = await chainDayStartSec();
    const pays = await t.paymentsByAgent(agentAddr, DAILY_SPEND_LOOKBACK);
    const sum = sumSpentSince(pays, { dayStart, lookback: DAILY_SPEND_LOOKBACK });
    return { ...sum, dayStart, error: null };
  } catch (e) {
    return { total: 0n, counted: 0, truncated: false, oldestSeen: null, dayStart: null, error: e.shortMessage || e.message };
  }
}

async function evaluatePolicy({ url, amountWei, asset, network, payTo, agent }) {
  const agentAddr = agent || (x402 ? x402.account.address : null);
  const reasons = [];
  // Filled from the chain below and returned alongside the verdict, so the UI can
  // show the same numbers the refusal was based on. Null when there was nothing to
  // read (no agent, no deployment) — which is different from "zero spend".
  let budget = null;

  if (!agentAddr) {
    reasons.push({
      code: "no_agent",
      detail: agent === undefined
        ? "AGENT_PRIVATE_KEY is not configured"
        : "no agent address supplied — sign in so the relay knows whose caps to enforce",
    });
  }
  if (state.paused) reasons.push({ code: "paused", detail: state.pausedReason || "operator paused the agent" });

  if (ctx) {
    // Asset + network validation: refuse to sign for anything that is not the
    // canonical x402-settleable MUSD on this chain.
    if (asset && asset.toLowerCase() !== ctx.chain.musd.address.toLowerCase()) {
      reasons.push({
        code: "wrong_asset",
        detail: `seller asked for ${asset}, expected ${ctx.chain.musd.address}`,
      });
    }
    if (network && network !== ctx.chain.caip2) {
      reasons.push({ code: "wrong_network", detail: `seller asked for ${network}, expected ${ctx.chain.caip2}` });
    }

    // On-chain policy is authoritative.
    try {
      const t = await treasury();
      if (t) {
        const chainPaused = await t.paused();
        if (chainPaused) reasons.push({ code: "paused_onchain", detail: "treasury is paused on-chain" });

        if (agentAddr) {
          const registered = await t.isRegistered(agentAddr);
          if (!registered) {
            reasons.push({ code: "not_registered", detail: `${agentAddr} is not registered in the treasury` });
          } else {
            const s = await t.agentStatus(agentAddr);
            if (!s.active) reasons.push({ code: "agent_inactive", detail: "agent is disabled on-chain" });

            const amount = BigInt(amountWei || 0);

            // TODAY'S SPEND comes from the treasury's receipts, NOT from the
            // contract's `remainingToday`. That field is `dailyCap - dayFunded`,
            // and `dayFunded` only moves in fundAgent() — it is how much FLOAT the
            // treasury may still release today, not how much the agent has spent.
            // Comparing a payment against it made the daily cap a second per-call
            // max: eight live purchases totalling 0.008 MUSD sailed through a
            // 0.005 MUSD cap without one refusal. See server/spend.js.
            const spend = await spentTodayWei(t, agentAddr);
            const verdict = judgeDailySpend({
              amountWei: amount,
              spentTodayWei: spend.total,
              dailyCapWei: s.dailyCap,
              truncated: spend.truncated,
            });
            budget = {
              source: "treasury receipts (on-chain)",
              perCallMax: s.perCallMax.toString(),
              dailyCap: verdict.dailyCap.toString(),
              spentToday: verdict.spentToday.toString(),
              leftToday: verdict.leftToday.toString(),
              projectedAfterThis: verdict.projected.toString(),
              receiptsRead: spend.counted,
              // True when every receipt in the window was from today, so the sum is
              // a lower bound. Said out loud rather than passed off as exact.
              truncated: spend.truncated,
              // Kept, correctly named: what the contract's remainingToday really is.
              fundingHeadroomToday: s.remainingToday.toString(),
              walletBalance: s.walletBalance.toString(),
              readError: spend.error,
            };

            if (amount > BigInt(s.perCallMax)) {
              reasons.push({
                code: "per_call_max",
                detail: `${fmtMusd(amount)} MUSD exceeds the ${fmtMusd(s.perCallMax)} MUSD per-call max`,
              });
            }
            if (spend.error) {
              // Fail closed. Without today's receipts the cap cannot be checked, and
              // "could not read the budget" must never mean "no budget".
              reasons.push({
                code: "spend_read_failed",
                detail: `could not read today's on-chain receipts for ${agentAddr}: ${spend.error}`,
              });
            } else if (spend.truncated) {
              reasons.push({
                code: "daily_cap",
                detail: `today's spending could not be bounded: the last ${spend.counted} receipts are all from today, ` +
                  `so at least ${fmtMusd(spend.total)} MUSD has been spent against a ${fmtMusd(verdict.dailyCap)} MUSD cap. ` +
                  `Raise DAILY_SPEND_LOOKBACK to widen the window.`,
              });
            } else if (verdict.over) {
              reasons.push({
                code: "daily_cap",
                detail: `${fmtMusd(amount)} MUSD would take today's spend to ${fmtMusd(verdict.projected)} MUSD, over the ` +
                  `${fmtMusd(verdict.dailyCap)} MUSD daily cap — ${fmtMusd(spend.total)} already spent across ` +
                  `${spend.counted} on-chain receipt${spend.counted === 1 ? "" : "s"}`,
              });
            }
            if (amount > BigInt(s.walletBalance)) {
              reasons.push({
                code: "insufficient_float",
                detail: `agent wallet holds ${fmtMusd(s.walletBalance)} MUSD`,
              });
            }
          }
        }
      }

      // Permit2 allowance is a TOKEN-level precondition, independent of whether
      // the treasury knows this agent. Without it the facilitator cannot pull
      // MUSD, so settlement fails with HTTP 412 only AFTER policy has allowed
      // the payment. Refuse up front instead, with an actionable reason.
      // Compare against the amount, not max: a partial allowance that covers
      // this payment is perfectly good.
      if (agentAddr && amountWei) {
        const m = await musd();
        if (m) {
          const allowed = await m.allowance(agentAddr, PERMIT2);
          if (allowed < BigInt(amountWei)) {
            reasons.push({
              code: "permit2_not_approved",
              // Machine-readable, so the UI can offer the fix instead of printing
              // an instruction only a developer could follow.
              action: "approve_permit2",
              detail: `this wallet has not approved Permit2 (${PERMIT2}) for ${fmtMusd(amountWei)} MUSD ` +
                `— in the app, open “Enable payments” and sign one approval from this wallet`,
              hint: "The popup offers two choices: approve this payment only, or all future payments. " +
                "If the wallet holds no BTC for gas — a brand-new agent wallet never has — the same popup " +
                "requests a capped dust amount from the operator wallet, or points at https://faucet.test.mezo.org. " +
                "An operator with the key can instead run contract/scripts/grant-permit2.js.",
            });
          }
        }
      }
    } catch (e) {
      reasons.push({ code: "chain_read_failed", detail: e.shortMessage || e.message });
    }
  }

  // Endpoint allowlist (gateway-local).
  if (state.allowlist.length > 0) {
    const origin = (() => { try { return new URL(url).origin; } catch { return url; } })();
    const allowed = state.allowlist.some(
      (e) => url.startsWith(e) || origin === e || origin.startsWith(e)
    );
    if (!allowed) {
      reasons.push({ code: "not_allowlisted", detail: `${origin} is not an approved service` });
    }
  } else {
    // Default guard even with no allowlist: http(s) only, no SSRF into private
    // ranges or cloud metadata endpoints.
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        reasons.push({ code: "bad_protocol", detail: `refusing ${u.protocol}` });
      }
      const host = u.hostname.toLowerCase();
      // The gateway's OWN seller is deliberately exempt: it is this process, not
      // an arbitrary internal service. Without this the built-in demo endpoint
      // (which lives on loopback) would be blocked by our own SSRF guard.
      const isSelf = SELF_ORIGINS.has(u.origin);
      const blocked = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "169.254.169.254", "metadata.google.internal"];
      if (!isSelf && (blocked.includes(host) || host.endsWith(".local") || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host))) {
        reasons.push({ code: "ssrf_blocked", detail: `refusing to call internal address ${host}` });
      }
    } catch {
      reasons.push({ code: "bad_url", detail: "unparseable URL" });
    }
  }

  return { allowed: reasons.length === 0, reasons, budget };
}

function pushReceipt(r) {
  state.receipts.unshift(r);
  state.receipts = state.receipts.slice(0, 200);
}
function pushDenial(d) {
  state.denials.unshift(d);
  state.denials = state.denials.slice(0, 200);
}

async function recordOnChain(kind, payload) {
  if (!state.treasurySigner || !ctx) return { recorded: false, reason: "no gateway signer configured" };
  try {
    const t = new ethers.Contract(ctx.deployment.address, [
      "function recordPayment(address agent, address payee, uint256 amount, bytes32 settlementTx, string endpoint)",
      "function recordDenial(address agent, uint256 attempted, string endpoint, string reason)",
    ], state.treasurySigner);
    const tx = kind === "payment"
      ? await t.recordPayment(payload.agent, payload.payee, payload.amount, payload.settlementTx || ethers.ZeroHash, payload.endpoint)
      : await t.recordDenial(payload.agent, payload.attempted, payload.endpoint, payload.reason);

    // Do NOT block the HTTP response on tx.wait(). On the Mezo testnet RPC
    // tx.wait() can hang for many minutes AFTER the transaction has already
    // confirmed, which left /api/pay spinning indefinitely even though the x402
    // settlement and the on-chain receipt had both succeeded. The tx hash is the
    // receipt's identity and is known the moment the RPC accepts the broadcast,
    // so return it immediately and report confirmation separately.
    const rc = await Promise.race([
      tx.wait().catch(() => null),
      new Promise((r) => setTimeout(() => r(null), RECEIPT_CONFIRM_MS)),
    ]);
    return { recorded: true, txHash: tx.hash, confirmed: Boolean(rc && rc.status === 1) };
  } catch (e) {
    return { recorded: false, reason: e.shortMessage || e.message };
  }
}

// --- decode a 402 quote ----------------------------------------------------
function decode402(res) {
  // Header is `payment-required`; HTTP/2 lowercases it. Node's fetch exposes both.
  const raw =
    res.headers.get("payment-required") ||
    res.headers.get("PAYMENT-REQUIRED") ||
    res.headers.get("x-payment-required");
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64").toString("utf8");
    const obj = JSON.parse(json);
    const accepts = Array.isArray(obj.accepts) ? obj.accepts : [];
    // Prefer an offer we can actually satisfy: exact scheme, our network, MUSD.
    const mine = accepts.find(
      (a) => a.scheme === "exact" && (!ctx || a.network === ctx.chain.caip2)
    ) || accepts[0];
    return { raw: obj, offer: mine || null };
  } catch {
    return null;
  }
}

/**
 * Did MUSD actually leave the agent wallet?
 *
 * The HTTP status is NOT authoritative. Observed live on Mezo testnet: the
 * facilitator settled the permit2 transfer on chain (tx 0xf0a6dbd2…) while the
 * seller still answered HTTP 402, so a status-only check recorded a DENIAL for a
 * payment the agent had already been charged for. In an audit log that is as
 * wrong as a false receipt — just in the other direction.
 *
 * So on any non-success response we look for the actual Transfer, matching the
 * exact quoted amount, in blocks mined since the attempt began. Retries allow
 * for the RPC lagging behind the settlement.
 */
async function findSettlementTransfer({ agent, amount, fromBlock, attempts = 8 }) {
  const p = readOnlyProvider();
  if (!p || !ctx || fromBlock === null || fromBlock === undefined) return null;
  const token = new ethers.Contract(ctx.chain.musd.address, [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ], p);
  const want = BigInt(amount);
  for (let i = 0; i < attempts; i++) {
    try {
      const latest = await p.getBlockNumber();
      if (latest >= fromBlock) {
        const logs = await token.queryFilter(
          token.filters.Transfer(agent, null), fromBlock, latest
        );
        const hit = logs.find((l) => l.args.value === want);
        if (hit) {
          return { txHash: hit.transactionHash, blockNumber: hit.blockNumber, to: hit.args.to };
        }
      }
    } catch {
      /* RPC hiccup or block range too wide — retry */
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

function decodePaymentResponse(res) {
  const raw = res.headers.get("payment-response") || res.headers.get("PAYMENT-RESPONSE");
  if (!raw) return null;
  try { return JSON.parse(Buffer.from(raw, "base64").toString("utf8")); } catch { return null; }
}

/**
 * Turn a facilitator rejection into something an operator can act on. x402
 * failures are opaque over HTTP (412 + a short string), and the single most
 * common cause on Mezo is a missing Permit2 token allowance — which is NOT the
 * same as the treasury recall allowance setup-agent.js grants.
 */
function settlementHint(reason, status) {
  const r = String(reason || "").toLowerCase();
  if (r.includes("allowance") || r.includes("permit2") || r.includes("transferfrom") || r.includes("insufficient")) {
    return "The agent wallet has not approved Permit2 to spend its MUSD (this is NOT " +
      "the treasury recall allowance). Fix with: cd contract && node scripts/grant-permit2.js";
  }
  if (r.includes("signature") || r.includes("eip712") || r.includes("nonce") || r.includes("deadline")) {
    return "The EIP-712 permit2 authorization was rejected — check the EIP-712 " +
      "domain name/version and the signer's clock skew.";
  }
  if (r.includes("network") || r.includes("chain") || r.includes("unsupported")) {
    return "The facilitator does not serve this network. It supports eip155:31611 " +
      "(testnet) and eip155:31612 (mainnet) only.";
  }
  if (status === 412) {
    return "The seller rejected the attached payment. Inspect denial.settlement " +
      "for the facilitator's full response.";
  }
  return null;
}

// ===========================================================================
// App
// ===========================================================================
const app = express();

// CORS. This used to be a bare `cors()` — every origin allowed — with the
// comment "only reachable via the Vite proxy / loopback", and that was true.
// Deploying it makes it false: a browser page on any domain could then drive a
// gateway that holds a signing key. So the allowlist is explicit, requests with
// no Origin (server-to-server, curl, the relay, health checks) pass untouched,
// and a PUBLIC gateway with no allowlist configured refuses every cross-origin
// browser request rather than defaulting to open. Fail closed.
const CORS_ALLOW_HEADERS = "Content-Type, X-AgentFloat-Admin, X-Requested-With";
// The x402 response headers a browser payer has to be able to READ. Without
// these in Access-Control-Expose-Headers the payment succeeds on chain and the
// page cannot see the receipt — the direct-from-browser path looks broken while
// the money moved.
const CORS_EXPOSE_HEADERS = "PAYMENT-RESPONSE, X-PAYMENT, PAYMENT-SIGNATURE, Payment-Response";

/**
 * Explicit rather than `app.use(cors())`, for two reasons a live test found:
 *
 *   1. `cors()` with `origin: false` does NOT refuse — it omits the headers and
 *      answers 200. The browser then blocks the read, so it is safe, but the
 *      operator gets a silent failure with nothing in the gateway log. A 403
 *      with the rejected origin in the body is debuggable in one look.
 *   2. A preflight from a rejected origin used to fall through to the 404
 *      catch-all, so `OPTIONS /api/quote` answered "no route POST /api/quote" —
 *      a confusing thing to read while diagnosing a deploy.
 */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = origin === undefined || originAllowed(origin) || !IS_PUBLIC;
  if (allowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
    res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
    res.setHeader("Access-Control-Max-Age", "600");
    // Never `Access-Control-Allow-Credentials: true`. Nothing here uses cookies
    // or HTTP auth, and echoing an arbitrary origin back with credentials is the
    // classic CORS misconfiguration.
  }
  if (req.method === "OPTIONS") {
    return allowed
      ? res.sendStatus(204)
      : res.status(403).json({ ok: false, error: "origin_not_allowed", origin: origin || null });
  }
  if (!allowed) {
    log(`  ⛔ cors: refused ${req.method} ${req.path} from ${origin}`);
    return res.status(403).json({
      ok: false,
      error: "origin_not_allowed",
      origin: origin || null,
      allowedOrigins: ALLOWED_ORIGINS,
      detail:
        "This gateway is public and its GATEWAY_ALLOWED_ORIGINS list does not " +
        "include the origin that called it. Add the frontend's domain to that " +
        "variable and redeploy — loopback origins are always allowed, which is " +
        "why this only bites once deployed.",
    });
  }
  return next();
});
app.use(express.json({ limit: "256kb" }));

/**
 * Gate for owner-style commands. No token configured -> open, which is exactly
 * how local dev has always worked. Token configured -> it must be presented, and
 * the refusal says what is missing instead of a bare 403.
 */
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const got = String(req.get("x-agentfloat-admin") || "").trim();
  if (got && got === ADMIN_TOKEN) return next();
  return res.status(403).json({
    ok: false,
    error: "admin_locked",
    detail:
      "This gateway is deployed with GATEWAY_ADMIN_TOKEN set, so owner-only " +
      "commands need it. It is a deployment secret, deliberately not something " +
      "the browser bundle carries — publish it there and anyone can pause the " +
      "gateway. Pause on chain instead: the treasury's pause() needs the owner " +
      "wallet and is the authority that survives a restart.",
  });
}

// --- 1. SELLER: an x402-protected demo endpoint ----------------------------
// PAY_TO must be set explicitly. Mezo warns the middleware silently falls back
// to the hosted demo's receiving address otherwise, so payments "work" while
// your merchant never receives anything.
const SELLER_PAY_TO =
  process.env.SELLER_PAY_TO ||
  (ctx ? ctx.deployment.owner : null);

// The facilitator serves exactly two networks. Mounting the seller on anything
// else (a local Hardhat chain, say) makes x402 throw RouteConfigurationError —
// asynchronously, from a background init handler, so a try/catch around the
// mount does NOT contain it and the whole gateway dies. Gate on the network
// first, and keep a last-resort handler below.
const FACILITATOR_NETWORKS = ["eip155:31611", "eip155:31612"];
const sellerNetworkOk = Boolean(ctx && FACILITATOR_NETWORKS.includes(ctx.chain.caip2));

if (ctx && SELLER_PAY_TO && sellerNetworkOk) {
  try {
    const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
    const resourceServer = new x402ResourceServer(facilitator).register(
      ctx.chain.caip2,
      new ExactEvmScheme()
    );

    app.use(
      paymentMiddleware(
        {
          "GET /paid/insight": {
            accepts: {
              scheme: "exact",
              price: SELLER_PRICE,
              network: ctx.chain.caip2,
              payTo: SELLER_PAY_TO,
            },
            description: `AgentFloat demo API — pay ${SELLER_PRICE} in MUSD for a market insight`,
          },
        },
        resourceServer,
        { appName: "AgentFloat Demo API", testnet: ctx.chain.isTestnet }
      )
    );

    // The paid resource. Reached only after the facilitator settles.
    app.get("/paid/insight", (_req, res) => {
      const insights = [
        { asset: "BTC", signal: "momentum", value: 0.62, note: "Funding rates neutral; open interest flat over 24h." },
        { asset: "MUSD", signal: "peg", value: 1.001, note: "Trading within 10bp of peg across Mezo venues." },
        { asset: "MEZO", signal: "liquidity", value: 0.48, note: "DEX depth improved; spread tightened 3bp." },
      ];
      const pick = insights[Math.floor(Math.random() * insights.length)];
      res.json({
        ok: true,
        source: "AgentFloat demo seller",
        generatedAt: new Date().toISOString(),
        ...pick,
      });
    });
    log(`  seller         GET /paid/insight @ ${SELLER_PRICE} -> payTo ${SELLER_PAY_TO}`);
  } catch (e) {
    log(`  ⚠️  could not mount the x402 seller: ${e.message}`);
  }
} else {
  if (!ctx) {
    log("  ⚠️  seller disabled — run scripts/deploy.js first");
  } else if (!SELLER_PAY_TO) {
    log("  ⚠️  seller disabled — set SELLER_PAY_TO (no treasury owner in the deployment)");
  } else if (!sellerNetworkOk) {
    log(`  ⚠️  seller disabled — the facilitator serves only ${FACILITATOR_NETWORKS.join(" / ")},`);
    log(`     but this deployment is on ${ctx.chain.caip2}. The x402 seller cannot mount here.`);
    log(`     The gateway API still works: point the agent at an existing paid URL instead`);
    log(`     (e.g. https://demo.vativ.io/) once deployed on Mezo testnet.`);
  }
}

// --- 2. GATEWAY API --------------------------------------------------------
app.get("/api/health", async (_req, res) => {
  const out = {
    ok: true,
    service: "agentfloat-gateway",
    version: "1.0.0",
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    deploymentFound: !!ctx,
    // How this instance is deployed. The UI reads it to explain a refusal that
    // comes from configuration rather than from policy — and to show a judge that
    // the same binary runs on a laptop and on a PaaS without a code change.
    deployment: {
      host: HOST,
      port: PORT,
      public: IS_PUBLIC,
      adminLocked: Boolean(ADMIN_TOKEN),
      allowedOrigins: ALLOWED_ORIGINS,
      // Deliberately a BOOLEAN, not the directory: the path is filesystem layout
      // and /api/health is public.
      persistentState: STATE_DIR !== __dirname,
      stateDir: STATE_DIR,
    },
    // True only once deploy.js has written a real treasury address. The UI uses
    // this to distinguish "gateway sees no deployment" from "deployed".
    deployed: Boolean(ctx && ctx.deployment.address),
    x402Ready: !!x402,
    agentWallet: x402 ? x402.account.address : null,
    paused: state.paused,
    allowlist: state.allowlist,
    onChainReceipts: !!state.treasurySigner,
    facilitator: FACILITATOR_URL,
    // The UI reads these to decide what to offer: a relay the user's own wallet
    // can use, self-service caps, and alerts. Each says plainly when it is not
    // configured, so nothing is presented that cannot work.
    relay: {
      enabled: true,
      allowlist: state.allowlist,
      note: "Signing happens in your browser; only the HTTP fetch is relayed, so seller CORS does not apply.",
    },
    limits: limitsApi.config(),
    telegram: telegram.config(),
    seller: {
      mounted: !!(ctx && SELLER_PAY_TO && sellerNetworkOk),
      price: SELLER_PRICE,
      payTo: SELLER_PAY_TO || null,
      // Loopback URL the AGENT uses — the gateway fetches it server-side, so
      // this is reachable and exempt from the SSRF guard.
      selfUrl: SELLER_SELF_URL,
      // Same-origin path for a human opening the paywall in a browser tab
      // (Vite proxies /paid here too).
      browserPath: SELLER_BROWSER_PATH,
      // And the URL a BROWSER should hand back when it wants to buy from this
      // seller. selfUrl is loopback: correct for the gateway, meaningless to a
      // page served from another origin.
      browserUrl: SELLER_BROWSER_PATH,
    },
  };
  if (ctx) {
    out.chain = {
      chainId: ctx.chain.chainId,
      name: ctx.chain.name,
      caip2: ctx.chain.caip2,
      rpcUrl: ctx.chain.rpcUrl,
      explorerUrl: ctx.chain.explorerUrl,
      musd: ctx.chain.musd,
      treasury: ctx.deployment.address,
      owner: ctx.deployment.owner,
      savingsVault: ctx.chain.savingsVault,
    };
    try {
      const t = await treasury();
      if (!t) {
        out.treasury = { pending: true, note: "no treasury address in deployment.json yet" };
      } else {
        out.treasury = {
          paused: await t.paused(),
          balance: (await t.treasuryBalance()).toString(),
          totalFunded: (await t.totalFunded()).toString(),
          totalRecalled: (await t.totalRecalled()).toString(),
          paymentCount: Number(await t.paymentCount()),
          denialCount: Number(await t.denialCount()),
        };
      }
    } catch (e) {
      out.treasury = { error: e.shortMessage || e.message };
    }
    if (x402) {
      try {
        const t = await treasury();
        const m = await musd();
        // Permit2 readiness is checked explicitly: without this allowance the
        // quote still decodes perfectly and policy still ALLOWS the payment,
        // then settlement fails with HTTP 412 and nothing moves. Surfacing it
        // here lets the dashboard warn before the operator clicks pay.
        const permit2Allowance = await m.allowance(x402.account.address, PERMIT2);
        out.agent = {
          walletBalance: (await m.balanceOf(x402.account.address)).toString(),
          registered: t ? await t.isRegistered(x402.account.address) : false,
          treasuryPending: !t,
          permit2: {
            address: PERMIT2,
            allowance: permit2Allowance.toString(),
            ready: permit2Allowance === ethers.MaxUint256,
          },
        };
        if (t && out.agent.registered) {
          const s = await t.agentStatus(x402.account.address);
          const spend = await spentTodayWei(t, x402.account.address);
          out.agent.policy = {
            active: s.active,
            perCallMax: s.perCallMax.toString(),
            dailyCap: s.dailyCap.toString(),
            spentToday: spend.error ? null : spend.total.toString(),
            leftToday: spend.error ? null : (BigInt(s.dailyCap) > spend.total ? BigInt(s.dailyCap) - spend.total : 0n).toString(),
            spendReadError: spend.error,
            dayFunded: s.dayFunded.toString(),
            fundingHeadroomToday: s.remainingToday.toString(),
            remainingToday: s.remainingToday.toString(),
            lifetimeFunded: s.lifetimeFunded.toString(),
            lifetimeRecalled: s.lifetimeRecalled.toString(),
            recallAllowance: s.recallAllowance.toString(),
            gateway: s.gateway,
          };
        }
      } catch (e) {
        out.agent = { ...(out.agent || {}), error: e.shortMessage || e.message };
      }
    }
  }
  out.receiptCount = state.receipts.length;
  out.denialCount = state.denials.length;
  // Faucet config + source wallet, so the UI can show where claims are funded
  // from and how much budget is left. `faucet` is declared later in this module
  // but that is safe: this handler only runs once the module has finished
  // evaluating, and getSigner() is lazy.
  try {
    out.faucet = await faucet.describe();
  } catch (e) {
    out.faucet = { enabled: false, error: e.shortMessage || e.message };
  }
  // Same reasoning as `faucet` above: declared later in this module, read only
  // once the module has finished evaluating.
  try {
    out.gas = await gasApi.describe();
  } catch (e) {
    out.gas = { enabled: false, error: e.shortMessage || e.message };
  }
  res.json(out);
});

// Quote a URL WITHOUT paying. Lets the UI show "this would cost X, policy says Y".
app.post("/api/quote", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "url is required" });
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "agentfloat-agent/1.0" } });
    if (r.status !== 402) {
      return res.json({ ok: true, requiresPayment: false, status: r.status });
    }
    const dec = decode402(r);
    if (!dec || !dec.offer) {
      return res.status(422).json({ ok: false, error: "402 returned but no parseable PAYMENT-REQUIRED header" });
    }
    const o = dec.offer;
    const policy = await evaluatePolicy({ url, amountWei: o.amount, asset: o.asset, network: o.network, payTo: o.payTo });
    res.json({
      ok: true,
      requiresPayment: true,
      description: dec.raw.resource?.description || null,
      offer: {
        scheme: o.scheme,
        network: o.network,
        asset: o.asset,
        amount: o.amount,
        amountMusd: fmtMusd(o.amount),
        payTo: o.payTo,
        maxTimeoutSeconds: o.maxTimeoutSeconds,
        transferMethod: o.extra?.assetTransferMethod || null,
        eip712Name: o.extra?.name || null,
      },
      policy,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// The one endpoint the agent uses to buy something.
app.post("/api/pay", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "url is required" });
  if (!x402) {
    return res.status(503).json({
      ok: false,
      error: "agent wallet not configured",
      hint: "cd contract && npx hardhat run scripts/setup-agent.js --network mezoTestnet, then restart the gateway",
    });
  }

  const startedAt = Date.now();
  try {
    // Step 1: unpaid probe to learn the price. Nothing is signed yet.
    const probe = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "agentfloat-agent/1.0" },
    });

    if (probe.status === 200) {
      const body = await probe.text();
      return res.json({ ok: true, paid: false, status: 200, body: safeParse(body), ms: Date.now() - startedAt });
    }

    if (probe.status !== 402) {
      const body = await probe.text();
      return res.status(502).json({
        ok: false, paid: false, status: probe.status,
        error: `seller returned ${probe.status}`, body: safeParse(body),
      });
    }

    const dec = decode402(probe);
    if (!dec || !dec.offer) {
      return res.status(422).json({ ok: false, paid: false, error: "unparseable PAYMENT-REQUIRED header" });
    }
    const o = dec.offer;

    // Step 2: policy gate. This is the whole product.
    const policy = await evaluatePolicy({ url, amountWei: o.amount, asset: o.asset, network: o.network, payTo: o.payTo });
    if (!policy.allowed) {
      const reason = policy.reasons[0].code;
      const denial = {
        at: new Date().toISOString(),
        agent: x402.account.address,
        endpoint: url,
        attempted: o.amount,
        attemptedMusd: fmtMusd(o.amount),
        reason,
        reasons: policy.reasons,
        source: "gateway",
      };
      pushDenial(denial);
      const onChain = await recordOnChain("denial", {
        agent: denial.agent, attempted: denial.attempted, endpoint: url, reason,
      });
      if (onChain.recorded) { denial.source = "chain"; denial.txHash = onChain.txHash; }
      // Alerting is fire-and-forget: a Telegram outage must never fail a payment.
      telegram.notify(denial.agent, {
        kind: "denial", reason, attempted: denial.attempted, endpoint: url,
      }).catch(() => {});
      return res.status(403).json({
        ok: false, paid: false, blockedByPolicy: true,
        error: `payment refused by policy: ${reason}`,
        reasons: policy.reasons,
        quote: { amountMusd: fmtMusd(o.amount), asset: o.asset, payTo: o.payTo },
        denial,
      });
    }

    // Step 3: allowed — sign and settle through the wrapped fetch.
    // Capture the chain height BEFORE signing. If the response comes back
    // non-2xx we use this to prove on chain whether MUSD moved anyway — the
    // HTTP status alone has been observed to disagree with the settlement.
    let startBlock = null;
    try {
      startBlock = await readOnlyProvider()?.getBlockNumber();
    } catch { startBlock = null; }

    const paid = await x402.fetchWithPay(url, {
      headers: { Accept: "application/json", "User-Agent": "agentfloat-agent/1.0" },
    });
    const body = await paid.text();
    const settlement = decodePaymentResponse(paid);
    const settlementTx =
      settlement?.transaction || settlement?.txHash ||
      settlement?.settlement?.transaction || null;

    // Did MUSD actually move? HTTP 412 means the seller/facilitator REJECTED the
    // payment. The payment-response header is authoritative when present, because
    // a middleware can return 200 while settlement itself failed.
    const settled = paid.status < 400 && settlement?.success !== false;

    if (!settled) {
      // The response says the payment failed. VERIFY that against the chain
      // before believing it: the facilitator has been observed settling the
      // transfer while the seller still returned HTTP 402. Recording a denial
      // for a charge that actually happened is as false as recording a payment
      // that never did — and the audit log is the whole product.
      const moved = await findSettlementTransfer({
        agent: x402.account.address, amount: o.amount, fromBlock: startBlock,
      });

      if (moved) {
        // MUSD left the wallet, so this IS a payment — but the seller returned no
        // resource, so the agent was charged without delivery. Record the charge
        // honestly and surface the discrepancy loudly instead of hiding it.
        const receipt = {
          at: new Date().toISOString(),
          agent: x402.account.address,
          payee: moved.to,
          endpoint: url,
          amount: o.amount,
          amountMusd: fmtMusd(o.amount),
          asset: o.asset,
          network: o.network,
          httpStatus: paid.status,
          settlementTx: moved.txHash,
          settlement: settlement || null,
          delivered: false,
          warning: "charged_without_delivery",
          ms: Date.now() - startedAt,
          source: "gateway",
        };
        pushReceipt(receipt);
        const movedOnChain = await recordOnChain("payment", {
          agent: receipt.agent, payee: receipt.payee, amount: receipt.amount,
          settlementTx: receipt.settlementTx, endpoint: url,
        });
        if (movedOnChain.recorded) {
          receipt.source = "chain";
          receipt.txHash = movedOnChain.txHash;
          receipt.confirmed = movedOnChain.confirmed;
        }
        return res.status(502).json({
          ok: false,
          paid: true,       // MUSD did leave the agent wallet
          settled: true,    // verified on chain, not inferred from HTTP status
          delivered: false, // but the seller returned no resource
          status: paid.status,
          warning: "charged_without_delivery",
          error: `MUSD settled on chain (${moved.txHash}) but the seller answered HTTP ` +
            `${paid.status} and returned no resource — the agent was charged without ` +
            `delivery. Recorded as a payment, because the charge is real.`,
          receipt,
          policy: { allowed: true, reasons: [] },
          ms: Date.now() - startedAt,
        });
      }

      // Verified on chain: no MUSD moved. Record a DENIAL, never a payment.
      const reason =
        settlement?.error ||
        settlement?.invalidPayment?.error ||
        settlement?.networkError ||
        `x402 settlement rejected (HTTP ${paid.status})`;
      const denial = {
        at: new Date().toISOString(),
        agent: x402.account.address,
        attempted: o.amount,
        attemptedMusd: fmtMusd(o.amount),
        asset: o.asset,
        network: o.network,
        endpoint: url,
        reason,
        code: "settlement_failed",
        httpStatus: paid.status,
        settlement: settlement || null,
        ms: Date.now() - startedAt,
        source: "gateway",
      };
      pushDenial(denial);
      const failedOnChain = await recordOnChain("denial", {
        agent: denial.agent, attempted: denial.attempted, endpoint: url, reason,
      });
      if (failedOnChain.recorded) {
        denial.source = "chain";
        denial.txHash = failedOnChain.txHash;
      }
      return res.status(502).json({
        ok: false,
        paid: false,
        settled: false,
        status: paid.status,
        error: `x402 settlement failed — no MUSD moved: ${reason}`,
        hint: settlementHint(reason, paid.status),
        body: safeParse(body),
        denial,
        // Policy DID allow this; the failure was downstream in settlement.
        policy: { allowed: true, reasons: [] },
        ms: Date.now() - startedAt,
      });
    }

    const receipt = {
      at: new Date().toISOString(),
      agent: x402.account.address,
      payee: o.payTo,
      endpoint: url,
      amount: o.amount,
      amountMusd: fmtMusd(o.amount),
      asset: o.asset,
      network: o.network,
      httpStatus: paid.status,
      settlementTx,
      settlement: settlement || null,
      delivered: true,
      ms: Date.now() - startedAt,
      source: "gateway",
    };
    pushReceipt(receipt);

    const onChain = await recordOnChain("payment", {
      agent: receipt.agent, payee: receipt.payee, amount: receipt.amount,
      settlementTx: receipt.settlementTx, endpoint: url,
    });
    if (onChain.recorded) { receipt.source = "chain"; receipt.txHash = onChain.txHash; }

    telegram.notify(receipt.agent, {
      kind: "payment",
      amount: receipt.amount,
      payee: receipt.payee,
      endpoint: url,
      txHash: receipt.settlementTx,
      explorerTx: ctx?.chain?.explorerUrl ? `${ctx.chain.explorerUrl}/tx/${receipt.settlementTx}` : null,
    }).catch(() => {});

    res.json({
      ok: true,
      paid: true,
      settled: true,
      delivered: true,
      status: paid.status,
      body: safeParse(body),
      receipt,
      policy: { allowed: true, reasons: [] },
      ms: Date.now() - startedAt,
    });
  } catch (e) {
    res.status(502).json({ ok: false, paid: false, error: e.shortMessage || e.message });
  }
});

function safeParse(text) {
  try { return JSON.parse(text); } catch { return text.slice(0, 4000); }
}

// --- operator controls surfaced to the UI ----------------------------------
// These are gateway-local. The authoritative pause lives on-chain and must be
// set by the OWNER wallet from the dashboard (MetaMask), because only the owner
// key can call the treasury. The gateway pause is an extra fast kill switch that
// stops signing immediately, without waiting for a tx to confirm.
app.post("/api/pause", requireAdmin, (req, res) => {
  state.paused = true;
  state.pausedReason = (req.body && req.body.reason) || "paused from the dashboard";
  log(`  ⏸  gateway paused: ${state.pausedReason}`);
  res.json({ ok: true, paused: true, reason: state.pausedReason });
});

app.post("/api/unpause", requireAdmin, (_req, res) => {
  state.paused = false;
  state.pausedReason = null;
  log(`  ▶  gateway resumed`);
  res.json({ ok: true, paused: false });
});

app.get("/api/receipts", (_req, res) => {
  res.json({ ok: true, receipts: state.receipts, denials: state.denials });
});

// On-chain receipts/denials, read straight from the treasury.
app.get("/api/chain-records", async (req, res) => {
  if (!ctx) return res.status(503).json({ ok: false, error: "no deployment" });
  try {
    const t = await treasury();
    if (!t) {
      return res.json({ ok: true, pending: true, payments: [], denials: [] });
    }
    const limit = Math.min(Number(req.query.limit || 25), 100);
    const [payments, denials] = await Promise.all([t.recentPayments(limit), t.recentDenials(limit)]);
    res.json({
      ok: true,
      payments: payments.map((p) => ({
        agent: p.agent, payee: p.payee, amount: p.amount.toString(), amountMusd: fmtMusd(p.amount),
        timestamp: Number(p.timestamp), endpoint: p.endpoint,
        settlementTx: p.settlementTx === ethers.ZeroHash ? null : p.settlementTx,
        source: "chain",
      })),
      denials: denials.map((d) => ({
        agent: d.agent, attempted: d.attempted.toString(), attemptedMusd: fmtMusd(d.attempted),
        timestamp: Number(d.timestamp), endpoint: d.endpoint, reason: d.reason, source: "chain",
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.shortMessage || e.message });
  }
});

app.get("/api/policy", (_req, res) => {
  res.json({
    ok: true,
    paused: state.paused,
    pausedReason: state.pausedReason,
    allowlist: state.allowlist,
    allowlistNote: state.allowlist.length
      ? "only these endpoint prefixes may be paid"
      : "empty — any public https URL may be paid, subject to the on-chain caps",
    onChainReceipts: !!state.treasurySigner,
  });
});

// NOTE: the 404 catch-all is registered LAST, immediately before app.listen().
// Express matches middleware in registration order, so a catch-all placed here
// silently swallowed every route added below it — the faucet returned
// "no route GET /api/faucet/status" while /api/health reported the faucet as
// enabled. Keep it at the bottom.

// --- boot ------------------------------------------------------------------
// Last-resort guard. The x402 SDK initialises route config in a background
// handler, so a bad facilitator/network combination surfaces as an uncaught
// exception rather than a throw we can catch at the mount site. The dashboard
// reads /api/* constantly, so losing the whole process to a seller problem would
// be needlessly fragile: log loudly, keep serving, and let the UI show that the
// seller is unavailable.
process.on("uncaughtException", (err) => {
  const msg = err && err.message ? err.message.split("\n")[0] : String(err);

  // EADDRINUSE must be FATAL. If another process owns the port, this one is not
  // serving anything — the old one is. Limping along here produced a genuinely
  // confusing failure: the banner printed, "gateway API stays up" was logged, and
  // the dashboard kept talking to a stale gateway running older code. Exit
  // non-zero so `npm run dev` reports it instead of hiding it.
  if (err && err.code === "EADDRINUSE") {
    log(`\n  ❌ port ${PORT} is already in use — another gateway is running.`);
    log(`     This process is NOT serving requests; the other one is, so the API you`);
    log(`     reach may be running older code. Stop it and restart:`);
    log(`       fuser -k ${PORT}/tcp        (Linux)`);
    log(`       netstat -ano | findstr ${PORT}   then taskkill /PID <pid> /F   (Windows)`);
    process.exit(1);
  }

  const isRouteConfig = err && (err.name === "RouteConfigurationError" || /Route Configuration/i.test(msg || ""));
  log(`\n  ❌ uncaught ${isRouteConfig ? "x402 route configuration" : ""} error — gateway API stays up:`);
  log(`     ${msg}`);
  if (isRouteConfig) {
    log(`     The built-in seller is unavailable. Deploy on Mezo testnet (eip155:31611)`);
    log(`     and restart, or pay an existing endpoint such as https://demo.vativ.io/.`);
  }
});
process.on("unhandledRejection", (reason) => {
  log(`\n  ⚠️  unhandled rejection: ${reason && reason.message ? reason.message : reason}`);
});

log(`\n== AgentFloat gateway ===================================================`);
if (!ctx) {
  log("  ⚠️  no deployment artifacts in frontend/src/contracts/");
  log("     Run: cd ../contract && npx hardhat run scripts/deploy.js --network mezoTestnet");
} else {
  log(`  chain          ${ctx.chain.name} (${ctx.chain.chainId})`);
  log(`  treasury       ${ctx.deployment.address}`);
  log(`  MUSD           ${ctx.chain.musd.address}${ctx.chain.musd.isMock ? " (MOCK)" : ""}`);
  log(`  savings vault  ${ctx.chain.savingsVault.available ? ctx.chain.savingsVault.address : "not available on testnet"}`);
}
initAgent();

// --- telegram alerts -------------------------------------------------------
// Long-polls Telegram rather than using a webhook, because a webhook needs a
// public HTTPS URL and this gateway runs on a laptop. Binding a chat to an agent
// address is authorized by a signature from that wallet (see the /api/telegram
// routes below), so nobody can subscribe to — or silence — somebody else's alerts.
const telegram = createTelegram({
  token: process.env.TELEGRAM_BOT_TOKEN,
  botUsername: process.env.TELEGRAM_BOT_USERNAME,
  stateFile: stateFile("telegram-state.json"),
  log,
});

/** On-chain counters for one agent. One RPC call; runs every watcher tick. */
async function agentSnapshot(address) {
  const t = await treasury();
  if (!t) return null;
  if (!(await t.isRegistered(address))) return null;
  const s = await t.agentStatus(address);
  const spend = await spentTodayWei(t, address);
  return {
    payments: s.payments.toString(),
    denials: s.denials.toString(),
    dailyCap: s.dailyCap.toString(),
    // What the agent has SPENT today, from receipts — the number a budget is kept
    // against, and the one the Spend page projects from.
    spentToday: spend.error ? null : spend.total.toString(),
    leftToday: spend.error ? null : (BigInt(s.dailyCap) > spend.total ? BigInt(s.dailyCap) - spend.total : 0n).toString(),
    spendReadError: spend.error,
    // What the contract calls remainingToday: funding the treasury may still
    // release today. Exposed under its real name so no UI labels it "left to spend".
    fundingHeadroomToday: s.remainingToday.toString(),
    remainingToday: s.remainingToday.toString(),
    walletBalance: s.walletBalance.toString(),
    lifetimeFunded: s.lifetimeFunded.toString(),
    active: s.active,
  };
}

/** The row behind a counter change. Read ONLY when a counter actually moved. */
async function agentDetail(address) {
  const t = await treasury();
  if (!t) return null;
  const out = { lastPayment: null, lastDenial: null };
  try {
    const pays = await t.paymentsByAgent(address, 1);
    const p = pays && pays[0];
    if (p) {
      const tx = p.settlementTx === ethers.ZeroHash ? null : p.settlementTx;
      out.lastPayment = {
        amount: p.amount.toString(),
        payee: p.payee,
        endpoint: p.endpoint,
        txHash: tx,
        explorerTx: tx && ctx?.chain?.explorerUrl ? `${ctx.chain.explorerUrl}/tx/${tx}` : null,
      };
    }
  } catch { /* paymentsByAgent missing on an older deployment */ }
  try {
    const dens = await t.recentDenials(10);
    const mine = (dens || []).find((d) => d.agent.toLowerCase() === address.toLowerCase());
    if (mine) out.lastDenial = { attempted: mine.attempted.toString(), reason: mine.reason, endpoint: mine.endpoint };
  } catch { /* ignore */ }
  return out;
}

telegram.startWatcher({
  getSnapshot: agentSnapshot,
  getDetail: agentDetail,
  intervalMs: Number(process.env.TELEGRAM_WATCH_SECONDS || 20) * 1000,
});

// --- self-service budget ---------------------------------------------------
// A user sets THEIR OWN agent's caps inside a published ceiling, authorized by a
// signature from that wallet and applied with the owner key. limits.js explains
// why the wallet cannot call setAgentLimits itself (onlyOwner — deliberately: an
// agent that can raise its own ceiling is not budget-controlled).
const limitsApi = createLimitsRouter({
  getStateFile: () => stateFile("limits-state.json"),
  getSigner: () => state.treasurySigner,
  getChain: () => ctx?.chain || null,
  getDeployment: () => ctx?.deployment || null,
  log,
  notify: (address, ev) => telegram.notify(address, ev),
});
app.use("/api/limits", limitsApi.router);

telegram.start();

// --- faucet ----------------------------------------------------------------
// Airdrops MUSD from the operator wallet to a signed-in user's own agent wallet.
// It spends real funds, so the controls live server-side: nonce + signature,
// a persisted per-address cooldown, and global daily/total caps.
const faucet = createFaucetRouter({
  getStateFile: () => stateFile("faucet-state.json"),
  // The operator/gateway signer doubles as the faucet source. That is fine on
  // testnet and keeps the demo to one funded key; in production this should be a
  // separate wallet with a hard budget so a drained faucet cannot touch the
  // treasury owner.
  getSigner: () => state.treasurySigner,
  getChain: () => ctx?.chain || null,
  getDeployment: () => ctx?.deployment || null,
  log,
});
app.use("/api/faucet", faucet.router);

// --- gas drip ---------------------------------------------------------------
// A new user's agent wallet is created by Privy and funded with MUSD by the
// faucet, so it has never held native BTC — and `MUSD.approve(Permit2, …)`, the
// one transaction every x402 payment depends on, needs gas. The policy engine's
// advice for that state used to be a developer command
// (`cd contract && node scripts/grant-permit2.js`), which is not a remedy a user
// can run. This is the same self-service shape as the faucet, for the dust an
// approval costs, with the same controls plus a reserve floor that protects the
// owner key's own gas.
const gasApi = createGasRouter({
  getStateFile: () => stateFile("gas-state.json"),
  getSigner: () => state.treasurySigner,
  getChain: () => ctx?.chain || null,
  getDeployment: () => ctx?.deployment || null,
  log,
  notify: (address, ev) => telegram.notify(address, ev),
});
app.use("/api/gas", gasApi.router);

// --- x402 relay: the user's own wallet, any seller, no CORS -----------------
//
// A browser fetch is subject to CORS, and most x402 sellers (Mezo's hosted demo
// included) send no Access-Control-Allow-Origin. So "pay with your own wallet"
// failed with `Failed to fetch` while the demo agent worked — the one working
// path was the one that needed the operator's key.
//
// The relay splits the two halves of a payment: SIGNING stays in the browser
// (Privy prompt, the key never leaves the TEE), FETCHING moves here (Node has no
// CORS). The gateway sees one opaque header it cannot forge, and decodes it to
// learn the payer and the amount — so policy and the ledger are keyed to what the
// wallet actually authorized, not to what the request body claims.
//
// This endpoint makes the operator's machine fetch a stranger's URL, so every
// request goes through assertRelayable(): https only, no loopback/private/
// link-local literals, no .local/.internal names, and a DNS check of every
// address the host resolves to (a public name pointing at 127.0.0.1 is the
// standard way around a hostname blocklist). Redirects are not followed, because
// a redirect is a second URL that was never checked. The gateway's own demo
// seller is the single exemption — it is this process.

app.post("/api/relay/probe", async (req, res) => {
  const { url, agent: rawAgent } = req.body || {};
  try {
    if (!rawAgent) {
      return res.status(400).json({
        ok: false,
        error: "agent is required — the relay enforces the caps of the wallet that will pay",
      });
    }
    const agent = ethers.getAddress(rawAgent);
    const safe = await assertRelayable(url, { selfOrigins: SELF_ORIGINS, allowlist: state.allowlist });
    const r = await probeSeller(safe);

    if (r.status !== 402) {
      return res.json({
        ok: true, requiresPayment: false, status: r.status, headers: r.headers,
        body: r.body, truncated: r.truncated, redirected: r.redirected, location: r.location, ms: r.ms,
      });
    }

    const dec = decodeOffer(r.headers, r.body);
    if (!dec.offer) {
      return res.status(422).json({ ok: false, error: "seller returned 402 with no parseable payment requirements" });
    }
    const o = dec.offer;
    const policy = await evaluatePolicy({
      url: safe, amountWei: o.amount, asset: o.asset, network: o.network, payTo: o.payTo, agent,
    });

    res.json({
      ok: true, requiresPayment: true, status: r.status, agent,
      headers: r.headers,           // the browser feeds these to its own x402 client
      body: r.body, truncated: r.truncated,
      description: dec.description,
      offer: {
        scheme: o.scheme, network: o.network, asset: o.asset, amount: o.amount,
        amountMusd: fmtMusd(o.amount), payTo: o.payTo,
        maxTimeoutSeconds: o.maxTimeoutSeconds,
        transferMethod: o.extra?.assetTransferMethod || null,
        eip712Name: o.extra?.name || null,
      },
      policy, ms: r.ms,
    });
  } catch (e) {
    if (e instanceof RelayError) return res.status(400).json({ ok: false, code: e.code, error: e.message });
    if (e?.code === "INVALID_ARGUMENT") return res.status(400).json({ ok: false, error: e.shortMessage || e.message });
    res.status(502).json({ ok: false, error: e.shortMessage || e.message });
  }
});

app.post("/api/relay/execute", async (req, res) => {
  // `paymentHeaders` is the map the browser's x402 client returned from
  // encodePaymentSignatureHeader() — the header NAME is part of the protocol
  // (v1 sends X-PAYMENT, v2 sends PAYMENT-SIGNATURE), so the client has to tell
  // us which it produced. `payment` (a bare value) is still accepted.
  const { url, agent: rawAgent, payment, paymentHeaders } = req.body || {};
  const startedAt = Date.now();
  try {
    if (!rawAgent || !(payment || paymentHeaders)) {
      return res.status(400).json({ ok: false, error: "agent and payment are required" });
    }
    const agent = ethers.getAddress(rawAgent);
    const safe = await assertRelayable(url, { selfOrigins: SELF_ORIGINS, allowlist: state.allowlist });

    const t = await treasury();
    if (!t) return res.status(503).json({ ok: false, error: "no deployment" });
    if (!(await t.isRegistered(agent))) {
      return res.status(409).json({
        ok: false, error: `${agent} is not a registered agent`,
        hint: "Claim from the faucet first — it registers the wallet and sets its caps.",
      });
    }

    // Payer and amount come out of the SIGNATURE, not out of the request body.
    const decoded = inspectPaymentHeader(paymentHeaders || payment);
    if (!decoded.ok) return res.status(422).json({ ok: false, error: decoded.error });

    // FAIL CLOSED. A header this gateway cannot attribute is a header it must not
    // forward: the payer check below is the whole reason the relay is not an open
    // proxy for spending, and "could not read the payer" is not "payer matches".
    if (!decoded.payerFound) {
      return res.status(422).json({
        ok: false, code: "payer_unverifiable",
        error: "that payment header carries no payer this gateway can read",
        hint: "Expected an EVM exact payload (permit2Authorization.from or authorization.from). " +
              "Re-sign with the current x402 client.",
        version: decoded.version, scheme: decoded.scheme,
      });
    }
    if (decoded.payer.toLowerCase() !== agent.toLowerCase()) {
      return res.status(403).json({
        ok: false, code: "payer_mismatch",
        error: `that payment header was signed by ${decoded.payer}, not by ${agent}`,
        hint: "The relay only forwards a payment signed by the wallet it is attributed to.",
      });
    }
    // Same reasoning for the amount: pricing a payment at 0 and running the caps
    // against 0 is not a policy check, it is a rubber stamp — and the receipt it
    // writes into an append-only ledger would say 0 MUSD.
    if (!decoded.amount) {
      return res.status(422).json({
        ok: false, code: "amount_unverifiable",
        error: "that payment header carries no amount this gateway can check against your caps",
        hint: "Expected accepted.amount (v2) or permit2Authorization.permitted.amount / " +
              "authorization.value (v1). Re-sign with the current x402 client.",
        version: decoded.version, scheme: decoded.scheme, transferMethod: decoded.transferMethod,
      });
    }
    const amountWei = String(decoded.amount);

    const policy = await evaluatePolicy({
      url: safe, amountWei, asset: decoded.asset, network: decoded.network, payTo: decoded.payTo, agent,
    });
    if (!policy.allowed) {
      const reason = policy.reasons[0].code;
      const denial = {
        at: new Date().toISOString(), agent, endpoint: safe, attempted: amountWei,
        attemptedMusd: fmtMusd(amountWei), reason, reasons: policy.reasons, source: "gateway", via: "relay",
      };
      pushDenial(denial);
      const onChain = await recordOnChain("denial", { agent, attempted: amountWei, endpoint: safe, reason });
      if (onChain.recorded) { denial.source = "chain"; denial.txHash = onChain.txHash; }
      telegram.notify(agent, { kind: "denial", reason, attempted: amountWei, endpoint: safe }).catch(() => {});
      return res.status(403).json({
        ok: false, paid: false, blockedByPolicy: true, via: "relay",
        error: `payment refused by policy: ${reason}`, reasons: policy.reasons, denial,
      });
    }

    // Chain height BEFORE the fetch: if the response looks like a failure we use
    // it to prove whether MUSD moved anyway. The HTTP status has been observed to
    // disagree with the settlement in both directions.
    let startBlock = null;
    try { startBlock = await readOnlyProvider()?.getBlockNumber(); } catch { startBlock = null; }

    const r = await executeWithPayment(safe, paymentHeaders || payment);
    const settlementRaw = r.headers["payment-response"] || r.headers["x-payment-response"] || null;
    let settlement = null;
    if (settlementRaw) {
      try { settlement = JSON.parse(Buffer.from(settlementRaw, "base64").toString("utf8")); } catch { settlement = null; }
    }
    const settlementTx = settlement?.transaction || settlement?.txHash || settlement?.settlement?.transaction || null;
    const settled = r.status < 400 && settlement?.success !== false;

    if (settled) {
      const receipt = {
        at: new Date().toISOString(), agent, payee: decoded.payTo, endpoint: safe,
        amount: amountWei, amountMusd: fmtMusd(amountWei), asset: decoded.asset,
        network: decoded.network, httpStatus: r.status, settlementTx, settlement,
        delivered: true, ms: Date.now() - startedAt, source: "relay", via: "relay",
      };
      pushReceipt(receipt);
      const onChain = await recordOnChain("payment", {
        agent, payee: receipt.payee, amount: amountWei, settlementTx, endpoint: safe,
      });
      if (onChain.recorded) { receipt.source = "chain"; receipt.txHash = onChain.txHash; }
      telegram.notify(agent, {
        kind: "payment", amount: amountWei, payee: receipt.payee, endpoint: safe,
        txHash: settlementTx,
        explorerTx: settlementTx && ctx?.chain?.explorerUrl ? `${ctx.chain.explorerUrl}/tx/${settlementTx}` : null,
      }).catch(() => {});
      return res.json({
        ok: true, paid: true, settled: true, delivered: true, via: "relay",
        status: r.status, headers: r.headers, body: safeParse(r.body), truncated: r.truncated,
        receipt, policy: { allowed: true, reasons: [] }, ms: receipt.ms,
      });
    }

    // The response says it failed. VERIFY against the chain before believing it:
    // recording a denial for a charge that actually happened is as false as
    // recording a payment that never did.
    const moved = await findSettlementTransfer({ agent, amount: amountWei, fromBlock: startBlock });
    if (moved) {
      const receipt = {
        at: new Date().toISOString(), agent, payee: moved.to, endpoint: safe,
        amount: amountWei, amountMusd: fmtMusd(amountWei), asset: decoded.asset,
        network: decoded.network, httpStatus: r.status, settlementTx: moved.txHash || settlementTx,
        delivered: false, ms: Date.now() - startedAt, source: "relay", via: "relay",
        warning: "charged_without_delivery",
      };
      pushReceipt(receipt);
      const onChain = await recordOnChain("payment", {
        agent, payee: moved.to, amount: amountWei, settlementTx: receipt.settlementTx, endpoint: safe,
      });
      if (onChain.recorded) { receipt.source = "chain"; receipt.txHash = onChain.txHash; }
      telegram.notify(agent, {
        kind: "payment", amount: amountWei, payee: moved.to, endpoint: safe,
        txHash: receipt.settlementTx,
        explorerTx: receipt.settlementTx && ctx?.chain?.explorerUrl ? `${ctx.chain.explorerUrl}/tx/${receipt.settlementTx}` : null,
      }).catch(() => {});
      return res.status(502).json({
        ok: false, paid: true, settled: true, delivered: false, via: "relay",
        warning: "charged_without_delivery", status: r.status,
        error: "MUSD settled on chain but the seller returned no resource — the agent was charged without delivery",
        receipt, body: safeParse(r.body), ms: receipt.ms,
      });
    }

    const reason = settlement?.errorReason || settlement?.error || `seller returned ${r.status}`;
    const denial = {
      at: new Date().toISOString(), agent, endpoint: safe, attempted: amountWei,
      attemptedMusd: fmtMusd(amountWei), reason: `settlement_failed: ${String(reason).slice(0, 80)}`,
      source: "gateway", via: "relay",
    };
    pushDenial(denial);
    const onChain = await recordOnChain("denial", {
      agent, attempted: amountWei, endpoint: safe, reason: denial.reason,
    });
    if (onChain.recorded) { denial.source = "chain"; denial.txHash = onChain.txHash; }
    telegram.notify(agent, { kind: "denial", reason: denial.reason, attempted: amountWei, endpoint: safe }).catch(() => {});
    return res.status(502).json({
      ok: false, paid: false, settled: false, via: "relay", status: r.status,
      error: `x402 settlement failed — no MUSD moved: ${reason}`,
      hint: settlementHint(String(reason), r.status),
      denial, policy: { allowed: true, reasons: [] }, ms: Date.now() - startedAt,
    });
  } catch (e) {
    if (e instanceof RelayError) return res.status(400).json({ ok: false, code: e.code, error: e.message });
    res.status(502).json({ ok: false, paid: false, error: e.shortMessage || e.message });
  }
});

// --- telegram subscription --------------------------------------------------
// Same auth shape as the faucet and the budget change: the server writes the
// message, the wallet signs it, the server recovers the signer and refuses on
// mismatch. Without it, anyone who knows an address could redirect or silence
// that agent's alerts.
const tgNonces = new Map();
const TG_NONCE_TTL = 5 * 60_000;

function tgPrune() {
  const now = Date.now();
  for (const [k, v] of tgNonces) if (now - v.createdAt > TG_NONCE_TTL) tgNonces.delete(k);
}

function tgMessage({ address, action, nonce }) {
  const verb = action === "unsubscribe" ? "disconnect" : action === "test" ? "send a test" : "connect";
  return [
    `AgentFloat: ${verb} Telegram alerts`,
    `agent: ${address}`,
    `action: ${action}`,
    `nonce: ${nonce}`,
    "Signing authorizes AgentFloat to send alerts about THIS wallet to the Telegram chat " +
      "that redeems the one-time code it returns. It never exposes your key, and you can " +
      "disconnect at any time with /stop.",
  ].join("\n");
}

app.get("/api/telegram/config", (_req, res) => res.json(telegram.config()));

app.get("/api/telegram/challenge", (req, res) => {
  try {
    const address = ethers.getAddress(String(req.query.address || ""));
    const action = ["subscribe", "unsubscribe", "test"].includes(req.query.action) ? req.query.action : "subscribe";
    if (!telegram.enabled) {
      return res.status(503).json({
        ok: false,
        error: "Telegram alerts are not configured on this gateway",
        hint: "Create a bot with @BotFather, set TELEGRAM_BOT_TOKEN (and TELEGRAM_BOT_USERNAME) in server/.env, then restart the gateway.",
      });
    }
    tgPrune();
    const nonce = crypto.randomUUID();
    const message = tgMessage({ address, action, nonce });
    tgNonces.set(nonce, { address, action, message, createdAt: Date.now() });
    res.json({ ok: true, address, action, nonce, message, expiresAt: new Date(Date.now() + TG_NONCE_TTL).toISOString() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.shortMessage || e.message });
  }
});

/** Verify { nonce, signature } and consume the nonce. One implementation, three routes. */
function verifyTgRequest(body, expectedAction) {
  const { nonce, signature } = body || {};
  if (!nonce || !signature) return { ok: false, status: 400, error: "nonce and signature are required" };
  tgPrune();
  const record = tgNonces.get(nonce);
  if (!record) return { ok: false, status: 410, error: "that challenge is expired or already used — request a fresh one" };
  if (record.action !== expectedAction) return { ok: false, status: 400, error: `that challenge was issued for "${record.action}", not "${expectedAction}"` };
  let signer;
  try {
    signer = ethers.verifyMessage(record.message, signature);
  } catch (e) {
    tgNonces.delete(nonce);
    return { ok: false, status: 400, error: `signature could not be verified: ${e.shortMessage || e.message}` };
  }
  if (signer.toLowerCase() !== record.address.toLowerCase()) {
    tgNonces.delete(nonce); // burned, not retryable
    return { ok: false, status: 403, error: `signature is from ${signer}, not from ${record.address}` };
  }
  tgNonces.delete(nonce); // single use
  return { ok: true, address: record.address };
}

app.post("/api/telegram/subscribe", (req, res) => {
  const v = verifyTgRequest(req.body, "subscribe");
  if (!v.ok) return res.status(v.status).json({ ok: false, error: v.error });
  const out = telegram.createCode(v.address);
  if (!out.ok) return res.status(503).json(out);
  log(`  🔔 subscribe code issued for ${v.address.slice(0, 10)}…`);
  res.json(out);
});

app.post("/api/telegram/unsubscribe", (req, res) => {
  const v = verifyTgRequest(req.body, "unsubscribe");
  if (!v.ok) return res.status(v.status).json({ ok: false, error: v.error });
  res.json(telegram.unsubscribe(v.address));
});

app.post("/api/telegram/test", async (req, res) => {
  const v = verifyTgRequest(req.body, "test");
  if (!v.ok) return res.status(v.status).json({ ok: false, error: v.error });
  const r = await telegram.notify(v.address, { kind: "test", address: v.address });
  res.json({ ok: Boolean(r.sent), ...r });
});

app.get("/api/telegram/status", (req, res) => {
  try {
    const address = ethers.getAddress(String(req.query.address || ""));
    res.json(telegram.status(address));
  } catch (e) {
    res.status(400).json({ ok: false, error: e.shortMessage || e.message });
  }
});

// --- per-agent status for any wallet ---------------------------------------
// Lets the UI read a signed-in user's OWN agent straight from the treasury,
// rather than only the gateway's demo agent.
app.get("/api/agent/:address", async (req, res) => {
  try {
    const address = ethers.getAddress(req.params.address);
    const t = await treasury();
    if (!t) return res.status(503).json({ ok: false, error: "no deployment" });
    const registered = await t.isRegistered(address);
    if (!registered) return res.json({ ok: true, address, registered: false });
    const s = await t.agentStatus(address);
    const spend = await spentTodayWei(t, address);
    res.json({
      ok: true, address, registered: true,
      active: s.active, gateway: s.gateway,
      perCallMax: s.perCallMax.toString(), dailyCap: s.dailyCap.toString(),
      dayFunded: s.dayFunded.toString(), remainingToday: s.remainingToday.toString(),
      // Spent today, summed from the treasury's own payment receipts — the number a
      // spending budget is kept against. `remainingToday` above is the contract's
      // FUNDING counter, and every UI that shows it says so.
      spentToday: spend.error ? null : spend.total.toString(),
      leftToday: spend.error ? null : (BigInt(s.dailyCap) > spend.total ? BigInt(s.dailyCap) - spend.total : 0n).toString(),
      fundingHeadroomToday: s.remainingToday.toString(),
      spendReadError: spend.error,
      walletBalance: s.walletBalance.toString(),
      lifetimeFunded: s.lifetimeFunded.toString(), lifetimeRecalled: s.lifetimeRecalled.toString(),
      recallAllowance: s.recallAllowance.toString(),
      payments: s.payments.toString(), denials: s.denials.toString(),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.shortMessage || e.message });
  }
});

// --- record a payment the BROWSER settled ----------------------------------
// A Privy user signs in their own wallet, so the gateway never sees the payment
// happen. It must NOT take the client's word for it either: a browser could
// claim any settlement and inflate the ledger. So we read the transaction
// receipt, confirm a MUSD transfer actually left that agent in that tx, and only
// then record it — with the amount and payee taken FROM THE CHAIN, not from the
// request body.
app.post("/api/record-settlement", async (req, res) => {
  const { agent: rawAgent, settlementTx, endpoint } = req.body || {};
  try {
    if (!rawAgent || !settlementTx) {
      return res.status(400).json({ ok: false, error: "agent and settlementTx are required" });
    }
    const agent = ethers.getAddress(rawAgent);
    const t = await treasury();
    if (!t) return res.status(503).json({ ok: false, error: "no deployment" });
    const p = readOnlyProvider();
    if (!p) return res.status(503).json({ ok: false, error: "no provider" });

    const registered = await t.isRegistered(agent);
    if (!registered) {
      return res.status(409).json({ ok: false, error: `${agent} is not a registered agent` });
    }

    // Read the receipt and find the MUSD transfer this tx actually performed.
    const token = new ethers.Contract(ctx.chain.musd.address, [
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    ], p);
    const rc = await p.getTransactionReceipt(settlementTx).catch(() => null);
    if (!rc) {
      return res.status(404).json({ ok: false, verified: false, error: "settlement tx not found on chain" });
    }
    const iface = token.interface;
    let found = null;
    for (const l of rc.logs) {
      if (l.address.toLowerCase() !== ctx.chain.musd.address.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog(l);
        if (parsed?.name === "Transfer" && parsed.args.from.toLowerCase() === agent.toLowerCase()) {
          found = { to: parsed.args.to, value: parsed.args.value };
          break;
        }
      } catch { /* not our event */ }
    }

    if (!found) {
      // The client claims a settlement that the chain does not corroborate.
      return res.status(422).json({
        ok: false, verified: false,
        error: `tx ${settlementTx} contains no MUSD transfer from ${agent} — nothing recorded`,
      });
    }

    const onChain = await recordOnChain("payment", {
      agent,
      payee: found.to,                    // from the chain, not the request
      amount: found.value.toString(),     // from the chain, not the request
      settlementTx,
      endpoint: endpoint || "(browser-settled)",
    });

    res.json({
      ok: Boolean(onChain.recorded),
      verified: true,
      recorded: Boolean(onChain.recorded),
      agent,
      payee: found.to,
      amount: found.value.toString(),
      amountMusd: fmtMusd(found.value),
      settlementTx,
      txHash: onChain.txHash || null,
      confirmed: onChain.confirmed ?? null,
      note: onChain.recorded ? null : (onChain.reason || "could not write the receipt"),
    });
  } catch (e) {
    res.status(400).json({ ok: false, verified: false, error: e.shortMessage || e.message });
  }
});

// 404 handler — MUST be the last middleware registered. See the note above.
app.use((req, res) => res.status(404).json({ ok: false, error: `no route ${req.method} ${req.path}` }));

app.listen(PORT, HOST, () => {
  log(`\n  listening on http://${HOST}:${PORT}`);
  if (IS_PUBLIC) {
    log(`  PUBLIC bind — this process holds a key, so check the three locks:`);
    log(`    cors     ${ALLOWED_ORIGINS.length
      ? ALLOWED_ORIGINS.join(", ")
      : "⚠️  no GATEWAY_ALLOWED_ORIGINS — every cross-origin browser request is refused"}`);
    log(`    admin    ${ADMIN_TOKEN
      ? "GATEWAY_ADMIN_TOKEN set — /api/pause and /api/unpause need it"
      : "⚠️  no GATEWAY_ADMIN_TOKEN — anyone who finds this URL can pause the gateway"}`);
    log(`    state    ${STATE_DIR !== __dirname
      ? STATE_DIR
      : "⚠️  beside the code — an ephemeral PaaS filesystem wipes it on every deploy"}`);
  } else {
    log(`  the React app proxies /api here — it never sees the agent key.`);
  }
  log();
});
