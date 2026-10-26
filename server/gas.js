// ---------------------------------------------------------------------------
// Gas drip — send a registered agent wallet enough native BTC to send ONE
// approval, when it has none.
//
// WHY THIS EXISTS
//   x402 on Mezo settles with permit2, so before a wallet can pay anything it
//   must send `MUSD.approve(Permit2, amount)` itself. That is a transaction, and
//   a transaction needs native gas. A brand-new user's agent wallet is created by
//   Privy and funded with MUSD by the faucet — it has never held any BTC. So the
//   honest state of a new user is:
//
//     MUSD 10.0 · MUSD→Permit2 allowance 0 · BTC 0.0
//
//   and the policy engine's advice for that was `fix with: cd contract && node
//   scripts/grant-permit2.js` — a developer command, run with a private key, by
//   someone who is not the developer and has no key. The refusal was correct and
//   the remedy was unusable. This router is the usable remedy: the same
//   self-service shape as the MUSD faucet, for the dust an approval costs.
//
// CONTROLS, in the order they are applied
//   1. NONCE + SIGNATURE — identical to the faucet. You can only request for an
//      address you control, and a captured signature cannot be replayed.
//   2. REGISTERED ONLY — the address must already be an agent in the treasury
//      (the faucet registers on first claim), so this is not an open BTC faucet
//      for arbitrary addresses.
//   3. NEED — refused if the wallet already holds at least the threshold. Asking
//      twice for gas you do not need is how a drip becomes a drain.
//   4. COOLDOWN — 24h per address, persisted to disk so a restart does not reset
//      it.
//   5. CAPS — per-day and total outflow, plus an operator reserve floor: the
//      owner key must keep enough BTC to run the protocol itself (record
//      receipts, register agents, recall float), so the drip stops before it can
//      spend that.
//
// Gas on Mezo testnet is close to free (observed gasPrice ≈ 146 wei, so an
// approval costs ~1e-11 BTC), which is why the amounts here look absurdly small
// and why the caps are about *abuse*, not about cost.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { ethers } from "ethers";

const DEFAULTS = {
  amountBtc: "0.00005",            // ~5,000 sats: enough for tens of thousands of approvals
  // "Has enough gas" must be judged against what an approval COSTS, not against a
  // number someone thought sounded small. Gas on Mezo testnet is ~146 wei, so an
  // approval costs ~8.8e-12 BTC: a fixed 0.0001 BTC threshold declared a wallet
  // that had just received 0.00005 BTC — five million approvals' worth — to still
  // need gas, and the popup kept showing its red box after the drip landed.
  gasSafetyFactor: 50,             // × the live estimate, so a gas spike does not strand the user
  minUsableBtc: "0.00000001",      // absolute floor, so a gasPrice of 0 cannot declare everyone ready
  cooldownHours: 24,
  dailyCapBtc: "0.005",
  totalCapBtc: "0.02",
  operatorReserveBtc: "0.01",      // never let the drip eat the owner key's own gas
  nonceTtlMs: 5 * 60_000,
  approveGasUnits: 60_000n,        // a token approve is ~46k; this is the estimate with headroom
};

const ERC20 = ["function allowance(address,address) view returns (uint256)"];
const TREASURY = ["function isRegistered(address) view returns (bool)"];
// Canonical Permit2 — the same address on every EVM chain it is deployed to.
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** UTC day key — matches the contract's own day rollover and the faucet's. */
function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function parseBtc(value, fallback) {
  try {
    const v = ethers.parseEther(String(value ?? "").trim());
    return v > 0n ? v : ethers.parseEther(fallback);
  } catch {
    return ethers.parseEther(fallback);
  }
}

/**
 * The balance below which a wallet genuinely cannot send the approval.
 *
 * Derived from the LIVE gas price, because a hardcoded threshold is a guess about
 * a number the chain sets: too high and every wallet "needs gas" forever, too low
 * and a user is told they are fine and then their transaction fails.
 *
 * @returns {bigint} wei
 */
export function gasThreshold({ gasPriceWei, config }) {
  const cost = BigInt(gasPriceWei ?? 0n) * config.approveGasUnits;
  const withMargin = cost * BigInt(config.gasSafetyFactor);
  return withMargin > config.minUsable ? withMargin : config.minUsable;
}

/**
 * Everything tunable, parsed once. Exported because the caps are the security
 * boundary and are tested without a chain.
 */
export function gasConfigFrom(env = process.env) {
  const amount = parseBtc(env.GAS_DRIP_BTC, DEFAULTS.amountBtc);
  const minUsable = parseBtc(env.GAS_DRIP_MIN_USABLE_BTC, DEFAULTS.minUsableBtc);
  const safety = Number(env.GAS_DRIP_SAFETY_FACTOR || DEFAULTS.gasSafetyFactor);
  return {
    amount,
    amountBtc: Number(ethers.formatEther(amount)),
    // Floor on "can already pay", before the live-cost margin is applied.
    minUsable,
    minUsableBtc: Number(ethers.formatEther(minUsable)),
    gasSafetyFactor: Number.isFinite(safety) && safety > 0 ? safety : DEFAULTS.gasSafetyFactor,
    cooldownMs: Number(env.GAS_DRIP_COOLDOWN_HOURS || DEFAULTS.cooldownHours) * 3_600_000,
    cooldownHours: Number(env.GAS_DRIP_COOLDOWN_HOURS || DEFAULTS.cooldownHours),
    dailyCap: parseBtc(env.GAS_DRIP_DAILY_CAP_BTC, DEFAULTS.dailyCapBtc),
    totalCap: parseBtc(env.GAS_DRIP_TOTAL_CAP_BTC, DEFAULTS.totalCapBtc),
    operatorReserve: parseBtc(env.GAS_DRIP_OPERATOR_RESERVE_BTC, DEFAULTS.operatorReserveBtc),
    nonceTtlMs: DEFAULTS.nonceTtlMs,
    // The drip is meaningless if it cannot cover the approval it is for, so the
    // amount is floored at a live estimate rather than trusted blindly.
    approveGasUnits: DEFAULTS.approveGasUnits,
  };
}

/**
 * The message the wallet signs. Same discipline as the faucet and the limits
 * router: the server authors it, it names the address and the amount, it carries
 * a single-use nonce, and it says plainly that signing moves nothing.
 */
export function buildGasMessage({ address, amountBtc, nonce }) {
  return [
    "AgentFloat gas drip (Mezo testnet)",
    "",
    `Address: ${address}`,
    `Amount: ${amountBtc} BTC`,
    `Nonce: ${nonce}`,
    "",
    "Signing this authorizes no transfer and exposes no key.",
    "It proves you control this address so AgentFloat may send it gas.",
  ].join("\n");
}

/**
 * Pure eligibility decision. Every input is a value the caller read from the
 * chain or from disk, so this can be tested without either.
 *
 * @returns {{eligible:boolean, reason:string|null, nextClaimAt?:string}}
 */
export function evaluateGasClaim({ address, state, config, balanceWei, needsThresholdWei, registered, operatorBalanceWei, now = Date.now() }) {
  const key = String(address).toLowerCase();

  if (!registered) {
    return {
      eligible: false,
      reason: "not_registered",
      hint: "Claim MUSD first — the faucet registers your wallet as an agent, and gas is only dripped to registered agents.",
    };
  }

  // Need before cooldown: a wallet that already has gas is refused whatever its
  // history, and one that does not is told when it may ask again.
  if (BigInt(balanceWei ?? 0n) >= BigInt(needsThresholdWei ?? 0n)) {
    return {
      eligible: false,
      reason: "not_needed",
      hint: "That wallet already holds enough BTC to send the approval itself.",
    };
  }

  const claim = state.claims?.[key];
  if (claim && now - claim.lastClaimAt < config.cooldownMs) {
    return {
      eligible: false,
      reason: "cooldown",
      nextClaimAt: new Date(claim.lastClaimAt + config.cooldownMs).toISOString(),
      hint: `Gas was already sent to this wallet recently — next request at ${new Date(claim.lastClaimAt + config.cooldownMs).toISOString()}.`,
    };
  }

  const total = BigInt(state.totalDistributed || "0");
  if (total + config.amount > config.totalCap) {
    return { eligible: false, reason: "total_cap", budgetExhausted: true, hint: "The operator's total gas budget is spent." };
  }

  const today = dayKey(new Date(now));
  const distributedToday = state.daily && state.daily.date === today ? BigInt(state.daily.amount || "0") : 0n;
  if (distributedToday + config.amount > config.dailyCap) {
    return { eligible: false, reason: "daily_cap", budgetExhausted: true, hint: "Today's gas budget is spent — it resets at 00:00 UTC." };
  }

  // The reserve is checked LAST so a user sees the reason that applies to them,
  // but it is a hard floor: the owner key must keep enough gas to record
  // receipts, register agents and recall float.
  if (operatorBalanceWei !== undefined && operatorBalanceWei !== null &&
      BigInt(operatorBalanceWei) - config.amount < config.operatorReserve) {
    return {
      eligible: false,
      reason: "operator_reserve",
      budgetExhausted: true,
      hint: "The operator wallet is near its own gas reserve, so it is not sending any more.",
    };
  }

  return { eligible: true, reason: null, distributedToday };
}

export function createGasRouter({ getStateFile, getSigner, getChain, getDeployment, log = () => {}, notify = async () => {} }) {
  const router = Router();
  const config = gasConfigFrom();
  const stateFile = getStateFile();
  // Nonces stay in memory: short-lived, and a restart invalidating an in-flight
  // request is harmless. Persisting them would let an old nonce outlive a process.
  const nonces = new Map();

  function loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return { claims: raw.claims || {}, totalDistributed: raw.totalDistributed || "0", daily: raw.daily || null };
    } catch {
      return { claims: {}, totalDistributed: "0", daily: null };
    }
  }

  function saveState(s) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(s, null, 2) + "\n");
    } catch (e) {
      log(`  ⚠️  could not persist gas state: ${e.message}`);
    }
  }

  function pruneNonces() {
    const now = Date.now();
    for (const [n, v] of nonces) if (v.expiresAt < now) nonces.delete(n);
  }

  function used(state) {
    const today = dayKey();
    return {
      totalBtc: Number(ethers.formatEther(BigInt(state.totalDistributed || "0"))),
      todayBtc: Number(ethers.formatEther(state.daily && state.daily.date === today ? BigInt(state.daily.amount || "0") : 0n)),
      wallets: Object.keys(state.claims || {}).length,
    };
  }

  /**
   * The serializable half of a wallet read. `res.json()` THROWS on a BigInt ("Do
   * not know how to serialize a BigInt"), which is how /api/health learned the same
   * lesson — so the BigInts stay inside this module for the cap maths and the
   * client gets numbers and strings only.
   */
  function publicWallet(w) {
    return {
      balanceBtc: w.balanceBtc,
      needsAtLeastBtc: w.estimate?.needsAtLeastBtc ?? null,
      needsGas: w.needsGas,
      estimate: w.estimate,
      allowanceMusd: w.allowanceMusd,
      permit2Ready: w.permit2Ready,
      registered: w.registered,
    };
  }

  /** Read the two facts the popup needs: can this wallet send a tx, and has it approved Permit2? */
  async function readWallet(provider, address, musdAddress) {
    const balanceWei = await provider.getBalance(address);
    const gasPrice = (await provider.getFeeData()).gasPrice ?? 1000n;
    const costWei = gasPrice * config.approveGasUnits;
    const thresholdWei = gasThreshold({ gasPriceWei: gasPrice, config });
    let allowance = null;
    try {
      allowance = await new ethers.Contract(musdAddress, ERC20, provider).allowance(address, PERMIT2_ADDRESS);
    } catch (e) {
      log(`  ⚠️  gas: could not read the MUSD allowance for ${address}: ${e.shortMessage || e.message}`);
    }
    let registered = null;
    try {
      const deployment = getDeployment();
      if (deployment?.address) {
        registered = await new ethers.Contract(deployment.address, TREASURY, provider).isRegistered(address);
      }
    } catch {
      registered = false; // agentStatus/isRegistered revert for a wallet that was never registered
    }
    return {
      balanceWei,
      thresholdWei,
      // Never hand a BigInt to res.json — JSON.stringify throws on it.
      balanceBtc: Number(ethers.formatEther(balanceWei)),
      needsGas: balanceWei < thresholdWei,
      estimate: {
        gasPriceWei: Number(gasPrice),
        gasUnits: Number(config.approveGasUnits),
        costBtc: Number(ethers.formatEther(costWei)),
        // What the wallet must hold to be considered able to send the approval:
        // the live cost with margin, floored at an absolute minimum.
        needsAtLeastBtc: Number(ethers.formatEther(thresholdWei)),
        // How many approvals the drip buys at the current gas price. Stated
        // because "0.00005 BTC" means nothing on its own and the honest answer is
        // "far more than you will ever send".
        approvalsPerDrip: costWei > 0n ? Number(config.amount / costWei) : null,
      },
      allowanceMusd: allowance === null ? null : Number(ethers.formatUnits(allowance, 18)),
      permit2Ready: allowance === null ? null : allowance > 0n,
      registered: Boolean(registered),
    };
  }

  // --- config ----------------------------------------------------------------
  router.get("/config", (_req, res) => {
    const state = loadState();
    res.json({
      ok: true,
      available: Boolean(getSigner()),
      amountBtc: config.amountBtc,
      minUsableBtc: config.minUsableBtc,
      gasSafetyFactor: config.gasSafetyFactor,
      cooldownHours: config.cooldownHours,
      caps: { dailyBtc: Number(ethers.formatEther(config.dailyCap)), totalBtc: Number(ethers.formatEther(config.totalCap)), operatorReserveBtc: Number(ethers.formatEther(config.operatorReserve)) },
      permit2: PERMIT2_ADDRESS,
      used: used(state),
      note: "Native BTC for gas, sent by the operator wallet, so a new user can send the Permit2 approval themselves. Testnet only.",
    });
  });

  // --- status: what the popup renders ----------------------------------------
  router.get("/status", async (req, res) => {
    try {
      const address = ethers.getAddress(req.query.address || "");
      const signer = getSigner();
      const chain = getChain();
      if (!signer) return res.status(503).json({ ok: false, error: "gas drip has no funded operator key" });
      const provider = signer.provider;
      const wallet = await readWallet(provider, address, chain?.musd?.address);
      const state = loadState();
      let operatorBalanceWei = null;
      try { operatorBalanceWei = await provider.getBalance(await signer.getAddress()); } catch { operatorBalanceWei = null; }

      const decision = evaluateGasClaim({
        address, state, config,
        balanceWei: wallet.balanceWei,
        needsThresholdWei: wallet.thresholdWei,
        registered: wallet.registered,
        operatorBalanceWei,
      });

      res.json({
        ok: true,
        address,
        ...publicWallet(wallet),
        amountBtc: config.amountBtc,
        operatorBalanceBtc: operatorBalanceWei === null ? null : Number(ethers.formatEther(operatorBalanceWei)),
        claim: {
          eligible: decision.eligible,
          reason: decision.reason,
          hint: decision.hint || null,
          nextClaimAt: decision.nextClaimAt || null,
        },
        used: used(state),
        lastClaimAt: state.claims?.[address.toLowerCase()]?.lastClaimAt
          ? new Date(state.claims[address.toLowerCase()].lastClaimAt).toISOString()
          : null,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.shortMessage || e.message });
    }
  });

  // --- challenge -------------------------------------------------------------
  router.get("/challenge", (req, res) => {
    try {
      const address = ethers.getAddress(req.query.address || "");
      if (!getSigner()) return res.status(503).json({ ok: false, error: "gas drip has no funded operator key" });
      pruneNonces();
      const nonce = ethers.hexlify(ethers.randomBytes(16));
      nonces.set(nonce, { address: address.toLowerCase(), expiresAt: Date.now() + config.nonceTtlMs });
      const message = buildGasMessage({ address, amountBtc: config.amountBtc, nonce });
      res.json({ ok: true, address, nonce, message, amountBtc: config.amountBtc, expiresInMs: config.nonceTtlMs });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.shortMessage || e.message });
    }
  });

  // --- request ---------------------------------------------------------------
  router.post("/request", async (req, res) => {
    const { address: rawAddress, signature, message } = req.body || {};
    try {
      if (!rawAddress || !signature || !message) {
        return res.status(400).json({ ok: false, error: "address, signature and message are required" });
      }
      const address = ethers.getAddress(rawAddress);
      const signer = getSigner();
      const chain = getChain();
      if (!signer) return res.status(503).json({ ok: false, error: "gas drip has no funded operator key" });
      if (!chain?.musd?.address) return res.status(503).json({ ok: false, error: "no deployment loaded" });
      const provider = signer.provider;

      // 1. The signature must recover to the address being funded.
      const recovered = ethers.verifyMessage(message, signature);
      if (recovered.toLowerCase() !== address.toLowerCase()) {
        return res.status(403).json({ ok: false, error: `signature recovers to ${recovered}, not ${address}` });
      }

      // 2. The nonce must be ours, unexpired, for this address — then it is
      //    consumed BEFORE the transfer, so a retry cannot double-send.
      pruneNonces();
      let matched = null;
      for (const [nonce, v] of nonces) {
        if (message.includes(nonce) && v.address === address.toLowerCase()) { matched = nonce; break; }
      }
      if (!matched) {
        return res.status(403).json({ ok: false, error: "unknown or expired nonce — request a fresh challenge", hint: "Nonces are single-use." });
      }
      nonces.delete(matched);

      // 3. Live facts, not cached ones: balance, allowance, registration.
      const wallet = await readWallet(provider, address, chain.musd.address);
      let operatorBalanceWei = null;
      try { operatorBalanceWei = await provider.getBalance(await signer.getAddress()); } catch { operatorBalanceWei = null; }

      const decision = evaluateGasClaim({
        address, state: loadState(), config,
        balanceWei: wallet.balanceWei,
        needsThresholdWei: wallet.thresholdWei,
        registered: wallet.registered,
        operatorBalanceWei,
      });
      if (!decision.eligible) {
        return res.status(decision.reason === "cooldown" ? 429 : 409).json({
          ok: false,
          code: decision.reason,
          error: decision.hint || `gas drip refused (${decision.reason})`,
          nextClaimAt: decision.nextClaimAt || null,
          ...publicWallet(wallet),
        });
      }

      // 4. Send it. Bounded wait: on this RPC tx.wait() can hang for minutes
      //    after the tx has confirmed, which would stall the user's popup.
      //
      //    If the configured amount is somehow below what the wallet needs, send
      //    enough instead: a drip that does not clear the threshold is a drip that
      //    burns the user's cooldown and leaves them exactly where they started.
      let value = config.amount;
      if (value < wallet.thresholdWei * 2n) {
        value = wallet.thresholdWei * 2n;
        log(`  gas: raising the drip to ${ethers.formatEther(value)} BTC — the configured amount would not cover the approval at the current gas price`);
      }
      const tx = await signer.sendTransaction({ to: address, value });
      const rc = await Promise.race([tx.wait().catch(() => null), new Promise((r) => setTimeout(r, 25_000))]);

      // 5. Persist only after the transfer was broadcast, so a failed send does
      //    not burn the user's cooldown.
      const now = Date.now();
      const today = dayKey(new Date(now));
      const s = loadState();
      const key = address.toLowerCase();
      s.claims[key] = { lastClaimAt: now, claims: (s.claims[key]?.claims || 0) + 1 };
      s.totalDistributed = (BigInt(s.totalDistributed || "0") + value).toString();
      s.daily = s.daily && s.daily.date === today
        ? { date: today, amount: (BigInt(s.daily.amount || "0") + value).toString() }
        : { date: today, amount: value.toString() };
      saveState(s);

      log(`  gas: sent ${ethers.formatEther(value)} BTC to ${address} (${tx.hash})`);
      // Fire and forget: an alerting outage must never fail the drip.
      Promise.resolve(
        notify(address, { kind: "gas_drip", address, amountBtc: Number(ethers.formatEther(value)), txHash: tx.hash })
      ).catch(() => {});

      res.json({
        ok: true,
        address,
        amountBtc: Number(ethers.formatEther(value)),
        txHash: tx.hash,
        confirmed: Boolean(rc?.status === 1),
        balanceBtcAfter: Number(ethers.formatEther((wallet.balanceWei || 0n) + value)),
        permit2Ready: wallet.permit2Ready,
        nextClaimAt: new Date(now + config.cooldownMs).toISOString(),
        explorer: `${chain.explorerUrl || "https://explorer.test.mezo.org"}/tx/${tx.hash}`,
        note: wallet.permit2Ready
          ? "Gas sent. Your Permit2 approval is already in place, so you can pay."
          : "Gas sent. Now send the Permit2 approval — the popup will do it for you.",
      });
    } catch (e) {
      log(`  ⚠️  gas drip failed: ${e.shortMessage || e.message}`);
      res.status(502).json({ ok: false, error: e.shortMessage || e.message });
    }
  });

  /** One line for /api/health, so the UI can say whether the drip exists at all. */
  async function describe() {
    const signer = getSigner();
    let operatorAddress = null;
    let operatorBalanceBtc = null;
    if (signer) {
      try {
        operatorAddress = await signer.getAddress();
        operatorBalanceBtc = Number(ethers.formatEther(await signer.provider.getBalance(operatorAddress)));
      } catch { /* leave null */ }
    }
    const state = loadState();
    return {
      enabled: Boolean(signer),
      amountBtc: config.amountBtc,
      minUsableBtc: config.minUsableBtc,
      gasSafetyFactor: config.gasSafetyFactor,
      cooldownHours: config.cooldownHours,
      caps: {
        dailyBtc: Number(ethers.formatEther(config.dailyCap)),
        totalBtc: Number(ethers.formatEther(config.totalCap)),
        operatorReserveBtc: Number(ethers.formatEther(config.operatorReserve)),
      },
      permit2: PERMIT2_ADDRESS,
      used: used(state),
      operatorAddress,
      operatorBalanceBtc,
      note: "Native BTC for gas so a new user can send the Permit2 approval themselves. Testnet only.",
    };
  }

  return { router, describe, config };
}
