// ---------------------------------------------------------------------------
// Faucet — airdrop MUSD to a signed-in user's own agent wallet.
//
// This endpoint spends REAL operator funds, so it is built as something an
// attacker will try to drain, not as a demo convenience. Controls, in the order
// they are applied:
//
//   1. NONCE + SIGNATURE. The server issues a short-lived nonce, the wallet signs
//      a message containing its own address and that nonce, and the server
//      recovers the signer with ethers.verifyMessage and refuses on mismatch.
//      You cannot claim for an address you do not control, and a captured
//      signature cannot be replayed because the nonce is consumed.
//   2. COOLDOWN. 48h per address, persisted to disk so a restart does not reset
//      it. Stored by address, which is the only identity we can trust — a user
//      can make unlimited Privy accounts, but each needs its own funded wallet
//      and each is capped independently.
//   3. GLOBAL CAPS. Total and per-day outflow limits, so the worst case is
//      bounded rather than open-ended. The operator wallet is not drained.
//   4. BALANCE CHECK. Never promise MUSD the operator does not hold.
//
// Registration: on first claim the wallet is registered as an agent in the
// treasury with default caps. That is what makes this more than a giveaway —
// the wallet then appears in the ledger, and the owner can pause or recall it.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { ethers } from "ethers";

const DEFAULTS = {
  amountMusd: "10",
  cooldownHours: 48,
  dailyCapMusd: "200",
  totalCapMusd: "1000",
  agentPerCallMaxMusd: "5",
  agentDailyCapMusd: "50",
  nonceTtlMs: 5 * 60_000,
};

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
];

const TREASURY = [
  "function isRegistered(address) view returns (bool)",
  "function registerAgent(address agent, address gateway, uint128 perCallMax, uint128 dailyCap)",
  "function agentStatus(address) view returns (tuple(bool active,address gateway,uint128 perCallMax,uint128 dailyCap,uint128 dayFunded,uint256 remainingToday,uint256 walletBalance,uint256 lifetimeFunded,uint256 lifetimeRecalled,uint256 recallAllowance,uint256 payments,uint256 denials))",
];

/** UTC day key, used for the daily cap. Matches the contract's own day rollover. */
function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function createFaucetRouter({ getStateFile, getSigner, getChain, getDeployment, log = () => {} }) {
  const router = Router();

  const cfg = {
    amount: ethers.parseUnits(process.env.FAUCET_AMOUNT_MUSD || DEFAULTS.amountMusd, 18),
    cooldownMs: Number(process.env.FAUCET_COOLDOWN_HOURS || DEFAULTS.cooldownHours) * 3_600_000,
    cooldownHours: Number(process.env.FAUCET_COOLDOWN_HOURS || DEFAULTS.cooldownHours),
    dailyCap: ethers.parseUnits(process.env.FAUCET_DAILY_CAP_MUSD || DEFAULTS.dailyCapMusd, 18),
    totalCap: ethers.parseUnits(process.env.FAUCET_TOTAL_CAP_MUSD || DEFAULTS.totalCapMusd, 18),
    perCallMax: ethers.parseUnits(process.env.FAUCET_AGENT_PER_CALL_MAX || DEFAULTS.agentPerCallMaxMusd, 18),
    dailyCapAgent: ethers.parseUnits(process.env.FAUCET_AGENT_DAILY_CAP || DEFAULTS.agentDailyCapMusd, 18),
    nonceTtl: DEFAULTS.nonceTtlMs,
  };

  const stateFile = getStateFile();
  // Nonces live in memory only: they are short-lived and a restart invalidating
  // an in-flight claim is harmless, whereas persisting them would let an old
  // nonce survive into a new process.
  const nonces = new Map(); // nonce -> { address, expiresAt }

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
      log(`  ⚠️  could not persist faucet state: ${e.message}`);
    }
  }

  function pruneNonces() {
    const now = Date.now();
    for (const [n, v] of nonces) if (v.expiresAt < now) nonces.delete(n);
  }

  /** Is this address allowed to claim right now? Returns {eligible, reason, ...}. */
  function evaluate(address, state) {
    const key = address.toLowerCase();
    const claim = state.claims[key];
    const now = Date.now();

    if (claim && now - claim.lastClaimAt < cfg.cooldownMs) {
      return {
        eligible: false,
        reason: "cooldown",
        nextClaimAt: new Date(claim.lastClaimAt + cfg.cooldownMs).toISOString(),
      };
    }

    const total = BigInt(state.totalDistributed || "0");
    if (total + cfg.amount > cfg.totalCap) {
      return { eligible: false, reason: "total_cap", budgetExhausted: true };
    }

    const today = dayKey();
    const distributedToday =
      state.daily && state.daily.date === today ? BigInt(state.daily.amount || "0") : 0n;
    if (distributedToday + cfg.amount > cfg.dailyCap) {
      return { eligible: false, reason: "daily_cap", budgetExhausted: true };
    }

    // Do NOT return distributedToday here: it is a BigInt, and JSON.stringify
    // throws on BigInt ("Do not know how to serialize a BigInt"). The client
    // already gets it as a Number via publicState().caps.distributedTodayMusd.
    return { eligible: true, reason: null };
  }

  async function operatorBalance() {
    const signer = getSigner();
    const chain = getChain();
    if (!signer || !chain) return null;
    const musd = new ethers.Contract(chain.musd.address, ERC20, signer);
    return musd.balanceOf(await signer.getAddress());
  }

  function publicState(extra = {}) {
    const state = loadState();
    const today = dayKey();
    const distributedToday =
      state.daily && state.daily.date === today ? BigInt(state.daily.amount || "0") : 0n;
    return {
      amountMusd: Number(ethers.formatUnits(cfg.amount, 18)),
      cooldownHours: cfg.cooldownHours,
      totalClaims: Object.keys(state.claims).length,
      totalDistributed: state.totalDistributed || "0",
      caps: {
        dailyMusd: Number(ethers.formatUnits(cfg.dailyCap, 18)),
        totalMusd: Number(ethers.formatUnits(cfg.totalCap, 18)),
        distributedTodayMusd: Number(ethers.formatUnits(distributedToday, 18)),
      },
      ...extra,
    };
  }

  // --- status --------------------------------------------------------------
  router.get("/status", async (req, res) => {
    try {
      const address = req.query.address ? ethers.getAddress(req.query.address) : null;
      const bal = await operatorBalance();
      const base = publicState({
        ok: true,
        operatorBalance: bal === null ? undefined : bal.toString(),
      });
      if (!address) return res.json({ ...base, eligible: null });

      const v = evaluate(address, loadState());
      res.json({ ...base, ...v });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.shortMessage || e.message });
    }
  });

  // --- challenge -----------------------------------------------------------
  // The message the wallet must sign. Contains the address so a signature cannot
  // be reused for a different one, and a nonce so it cannot be replayed.
  router.get("/challenge", (req, res) => {
    try {
      const address = ethers.getAddress(req.query.address || "");
      pruneNonces();
      const nonce = ethers.hexlify(ethers.randomBytes(16));
      nonces.set(nonce, { address: address.toLowerCase(), expiresAt: Date.now() + cfg.nonceTtl });
      const message = [
        "AgentFloat faucet claim",
        "",
        `Address: ${address}`,
        `Amount: ${Number(ethers.formatUnits(cfg.amount, 18))} MUSD`,
        `Nonce: ${nonce}`,
        "",
        "Signing this authorizes no transfer. It proves you control this address.",
      ].join("\n");
      res.json({ ok: true, address, nonce, message, expiresInMs: cfg.nonceTtl });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.shortMessage || e.message });
    }
  });

  // --- request -------------------------------------------------------------
  router.post("/request", async (req, res) => {
    const { address: rawAddress, signature, message } = req.body || {};
    try {
      if (!rawAddress || !signature || !message) {
        return res.status(400).json({ ok: false, error: "address, signature and message are required" });
      }
      const address = ethers.getAddress(rawAddress);
      const signer = getSigner();
      const chain = getChain();
      const deployment = getDeployment();
      if (!signer) return res.status(503).json({ ok: false, error: "faucet has no funded operator key" });
      if (!chain || !deployment?.address) {
        return res.status(503).json({ ok: false, error: "no deployment loaded" });
      }

      // 1. Recover the signer and confirm it matches the claimed address.
      const recovered = ethers.verifyMessage(message, signature);
      if (recovered.toLowerCase() !== address.toLowerCase()) {
        return res.status(403).json({
          ok: false,
          error: `signature recovers to ${recovered}, not ${address}`,
        });
      }

      // 2. Confirm the nonce was issued by us, is unexpired, and is for THIS
      //    address — then consume it so the signature cannot be replayed.
      pruneNonces();
      let matched = null;
      for (const [nonce, v] of nonces) {
        if (message.includes(nonce) && v.address === address.toLowerCase()) { matched = nonce; break; }
      }
      if (!matched) {
        return res.status(403).json({ ok: false, error: "unknown or expired nonce — request a fresh challenge" });
      }
      nonces.delete(matched);

      // 3. Cooldown and caps.
      const state = loadState();
      const v = evaluate(address, state);
      if (!v.eligible) {
        return res.status(429).json({
          ok: false,
          error: v.reason === "cooldown"
            ? `cooldown — next claim at ${v.nextClaimAt}`
            : `faucet budget exhausted (${v.reason})`,
          ...publicState(v),
        });
      }

      // 4. Balance check — never promise funds the operator does not have.
      const musd = new ethers.Contract(chain.musd.address, ERC20, signer);
      const bal = await musd.balanceOf(await signer.getAddress());
      if (bal < cfg.amount) {
        return res.status(503).json({
          ok: false,
          error: `operator holds ${ethers.formatUnits(bal, 18)} MUSD, less than the ${ethers.formatUnits(cfg.amount, 18)} MUSD claim`,
        });
      }

      // 5. Register as an agent on first claim, so the wallet is governed like
      //    any other: it appears in the ledger and can be paused or recalled.
      let registered = false;
      const treasury = new ethers.Contract(deployment.address, TREASURY, signer);
      try {
        const already = await treasury.isRegistered(address);
        if (!already) {
          const ownerAddr = await signer.getAddress();
          const tx = await treasury.registerAgent(address, ownerAddr, cfg.perCallMax, cfg.dailyCapAgent);
          // Bounded wait: tx.wait() can hang for minutes on this RPC after the
          // tx has confirmed, which would stall the user's claim.
          await Promise.race([tx.wait().catch(() => null), new Promise((r) => setTimeout(r, 20_000))]);
          registered = true;
          log(`  faucet: registered agent ${address}`);
        }
      } catch (e) {
        // Registration failing must not block the airdrop, but say so.
        log(`  ⚠️  faucet: could not register ${address}: ${e.shortMessage || e.message}`);
      }

      // 6. Send the MUSD.
      const tx = await musd.transfer(address, cfg.amount);
      const rc = await Promise.race([tx.wait().catch(() => null), new Promise((r) => setTimeout(r, 25_000))]);

      // 7. Persist the claim only after the transfer was broadcast, so a failed
      //    send does not burn the user's cooldown.
      const now = Date.now();
      const today = dayKey();
      const s2 = loadState();
      s2.claims[address.toLowerCase()] = {
        lastClaimAt: now,
        claims: (s2.claims[address.toLowerCase()]?.claims || 0) + 1,
      };
      s2.totalDistributed = (BigInt(s2.totalDistributed || "0") + cfg.amount).toString();
      s2.daily = s2.daily && s2.daily.date === today
        ? { date: today, amount: (BigInt(s2.daily.amount || "0") + cfg.amount).toString() }
        : { date: today, amount: cfg.amount.toString() };
      saveState(s2);

      res.json({
        ok: true,
        address,
        amountMusd: Number(ethers.formatUnits(cfg.amount, 18)),
        txHash: tx.hash,
        confirmed: Boolean(rc && rc.status === 1),
        registered,
        nextClaimAt: new Date(now + cfg.cooldownMs).toISOString(),
        explorer: chain.explorerUrl ? `${chain.explorerUrl}/tx/${tx.hash}` : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.shortMessage || e.message });
    }
  });

  /** For /api/health: what the faucet is configured to do and from where. */
  async function describe() {
    const signer = getSigner();
    let operatorAddress = null;
    let operatorBalance = null;
    if (signer) {
      try {
        operatorAddress = await signer.getAddress();
        const chain = getChain();
        if (chain) {
          const musd = new ethers.Contract(chain.musd.address, ERC20, signer);
          operatorBalance = (await musd.balanceOf(operatorAddress)).toString();
        }
      } catch { /* leave null */ }
    }
    return { ...publicState(), enabled: Boolean(signer), operatorAddress, operatorBalance };
  }

  return { router, describe, config: cfg };
}
