// ---------------------------------------------------------------------------
// Self-service budget — a user sets THEIR OWN agent's caps, within a ceiling.
//
// THE CONFUSION THIS FIXES
//   The Operate page was owner-only, so a user who had just created an agent
//   wallet with their email found every control disabled and reasonably
//   concluded the product was not for them. It was: they are exactly the person
//   who should decide how much their own agent may spend per call and per day.
//
// WHY THE WALLET CANNOT JUST CALL THE CONTRACT
//   `setAgentLimits` is `onlyOwner`, and that is deliberate rather than an
//   oversight. An agent that can raise its own ceiling is not budget-controlled:
//   a prompt-injected or buggy agent would simply lift its own limit and the
//   "hard cap" would be a suggestion. So the authority stays with the funder.
//
// WHAT THIS MODULE DOES INSTEAD — the model a real product uses
//   The user AUTHORIZES a change by signing with the agent wallet itself; the
//   protocol APPLIES it with the owner key, only inside a published ceiling, and
//   only after proving the requester controls that wallet. Same shape as a bank
//   letting you set your own card limits up to a product maximum: you choose the
//   number, the institution enforces the envelope, and neither can forge the
//   other.
//
// AUTH: nonce + signature, identical to the faucet's
//   The server issues a short-lived nonce AND the exact message to sign, with the
//   requested values already baked into both. The client signs that string
//   verbatim and posts back only { address, nonce, signature }. So:
//     - the values applied are the ones the signature covers (nothing in the
//       second request is trusted),
//     - there is no message-format drift between client and server, because the
//       server wrote the message,
//     - a captured signature cannot be replayed, because the nonce is consumed.
//   Works with a Privy embedded wallet: personal_sign is all it needs.
//
// RATE LIMITED because every change is an owner transaction on the operator's
//   key, paid in real gas. A ceiling on the number is not enough; a user could
//   otherwise spend the operator's funds by changing caps in a loop.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import { ethers } from "ethers";

const TREASURY_ABI = [
  "function isRegistered(address) view returns (bool)",
  "function setAgentLimits(address agent, uint128 perCallMax, uint128 dailyCap)",
  "function setAgentActive(address agent, bool active)",
  "function agentStatus(address) view returns (tuple(bool active,address gateway,uint128 perCallMax,uint128 dailyCap,uint128 dayFunded,uint256 remainingToday,uint256 walletBalance,uint256 lifetimeFunded,uint256 lifetimeRecalled,uint256 recallAllowance,uint256 payments,uint256 denials))",
];

const DEFAULTS = {
  // The envelope a user may move inside. Matches what the faucet grants, so a
  // new user can re-shape their budget but cannot exceed the protocol's idea of
  // a testnet agent. Both are env-overridable for a demo that needs bigger numbers.
  perCallMaxMusd: "5",
  dailyCapMusd: "50",
  minPerCallMusd: "0.001", // the cheapest real seller price; below this nothing is buyable
  nonceTtlMs: 5 * 60_000,
  perAddressPerHour: 12,
  globalPerHour: 240,
};

export function ceilingsFrom(env = process.env) {
  return {
    perCallMaxMusd: env.USER_PER_CALL_MAX_MUSD || DEFAULTS.perCallMaxMusd,
    dailyCapMusd: env.USER_DAILY_CAP_MUSD || DEFAULTS.dailyCapMusd,
    minPerCallMusd: env.USER_MIN_PER_CALL_MUSD || DEFAULTS.minPerCallMusd,
  };
}

/** The exact string a wallet signs. Server-authored, client-signs-verbatim. */
export function buildMessage({ address, action, nonce, perCallMaxMusd, dailyCapMusd, ceilings }) {
  const head =
    action === "freeze"
      ? "AgentFloat: freeze my agent wallet (disable it on-chain)"
      : action === "unfreeze"
        ? "AgentFloat: unfreeze my agent wallet (re-enable it on-chain)"
        : "AgentFloat: change my agent wallet's spending limits";
  const lines = [head, `agent: ${address}`];
  if (action === "limits") {
    lines.push(`per-call max: ${perCallMaxMusd} MUSD`);
    lines.push(`daily cap: ${dailyCapMusd} MUSD`);
  }
  lines.push(`nonce: ${nonce}`);
  lines.push(
    `Protocol ceiling: per-call <= ${ceilings.perCallMaxMusd} MUSD, daily <= ${ceilings.dailyCapMusd} MUSD. ` +
      `Signing authorizes AgentFloat to apply exactly this change on Mezo testnet. It never exposes your key.`
  );
  return lines.join("\n");
}

/** Parse "1.5" MUSD → wei bigint, refusing anything malformed rather than NaN. */
export function parseMusd(value) {
  const s = String(value ?? "").trim();
  if (!/^\d{1,9}(\.\d{1,18})?$/.test(s)) return null;
  try {
    return ethers.parseUnits(s, 18);
  } catch {
    return null;
  }
}

export function createLimitsRouter({ getStateFile, getSigner, getChain, getDeployment, log = () => {}, notify = async () => {} }) {
  const router = Router();
  const cfg = ceilingsFrom();

  function loadState() {
    try {
      return JSON.parse(fs.readFileSync(getStateFile(), "utf8"));
    } catch {
      return { nonces: {}, changes: [] };
    }
  }
  function saveState(s) {
    try {
      fs.writeFileSync(getStateFile(), JSON.stringify(s, null, 2));
    } catch (e) {
      log(`  ⚠️  limits state not persisted: ${e.message}`);
    }
  }
  function prune(s) {
    const now = Date.now();
    for (const [k, v] of Object.entries(s.nonces)) {
      if (!v || now - v.createdAt > DEFAULTS.nonceTtlMs) delete s.nonces[k];
    }
    s.changes = (s.changes || []).slice(0, 300);
    return s;
  }

  const hourKey = (d = new Date()) => d.toISOString().slice(0, 13);
  function countThisHour(s, address) {
    const hk = hourKey();
    const global = s.changes.filter((c) => c.hour === hk).length;
    const mine = s.changes.filter((c) => c.hour === hk && c.address?.toLowerCase() === address.toLowerCase()).length;
    return { global, mine };
  }

  function treasuryWithSigner() {
    const signer = getSigner();
    const deployment = getDeployment();
    if (!signer || !deployment?.address) return null;
    return new ethers.Contract(deployment.address, TREASURY_ABI, signer);
  }

  // --- public ceiling, so the UI can show the envelope before asking ---------
  router.get("/config", (_req, res) => {
    res.json({
      ok: true,
      available: Boolean(getSigner() && getDeployment()?.address),
      ceilings: cfg,
      limits: {
        perAddressPerHour: DEFAULTS.perAddressPerHour,
        globalPerHour: DEFAULTS.globalPerHour,
        nonceTtlMinutes: Math.round(DEFAULTS.nonceTtlMs / 60000),
      },
      note:
        "Caps are setAgentLimits() on the treasury, which is onlyOwner. You authorize the change " +
        "with a signature from your own agent wallet; the gateway applies it with the owner key, " +
        "inside the ceiling above. An agent can never raise its own limit on chain — that is what " +
        "makes the cap a cap.",
    });
  });

  // --- challenge: bind the requested values to a single-use nonce ------------
  router.get("/challenge", async (req, res) => {
    const action = ["limits", "freeze", "unfreeze"].includes(req.query.action) ? req.query.action : "limits";
    try {
      const address = ethers.getAddress(String(req.query.address || ""));
      const t = treasuryWithSigner();
      if (!t) {
        return res.status(503).json({
          ok: false,
          error: "gateway has no owner key",
          hint: "Set GATEWAY_SIGNER_PRIVATE_KEY in server/.env — it must be the treasury owner.",
        });
      }

      const registered = await t.isRegistered(address);
      if (!registered) {
        return res.status(409).json({
          ok: false,
          error: `${address} is not a registered agent yet`,
          hint: "Claim from the faucet first — it registers the wallet and sets the initial caps.",
        });
      }

      let perCallMaxMusd = null;
      let dailyCapMusd = null;
      if (action === "limits") {
        perCallMaxMusd = String(req.query.perCallMax ?? "").trim();
        dailyCapMusd = String(req.query.dailyCap ?? "").trim();
        const perCall = parseMusd(perCallMaxMusd);
        const daily = parseMusd(dailyCapMusd);
        const minPerCall = parseMusd(cfg.minPerCallMusd);
        const maxPerCall = parseMusd(cfg.perCallMaxMusd);
        const maxDaily = parseMusd(cfg.dailyCapMusd);

        if (perCall === null || daily === null) {
          return res.status(400).json({ ok: false, error: "perCallMax and dailyCap must be decimal MUSD amounts" });
        }
        if (perCall < minPerCall) {
          return res.status(400).json({
            ok: false,
            error: `per-call max must be at least ${cfg.minPerCallMusd} MUSD — below that no seller is affordable`,
          });
        }
        if (perCall > maxPerCall) {
          return res.status(400).json({ ok: false, error: `per-call max cannot exceed the ${cfg.perCallMaxMusd} MUSD ceiling` });
        }
        if (daily > maxDaily) {
          return res.status(400).json({ ok: false, error: `daily cap cannot exceed the ${cfg.dailyCapMusd} MUSD ceiling` });
        }
        if (daily < perCall) {
          // The contract reverts with ExceedsDailyCap; say it here instead.
          return res.status(400).json({ ok: false, error: "daily cap must be >= per-call max" });
        }
      }

      const nonce = crypto.randomUUID();
      const message = buildMessage({ address, action, nonce, perCallMaxMusd, dailyCapMusd, ceilings: cfg });
      const s = prune(loadState());
      s.nonces[nonce] = { address, action, perCallMaxMusd, dailyCapMusd, message, createdAt: Date.now() };
      saveState(s);

      res.json({
        ok: true,
        address,
        action,
        nonce,
        message,
        perCallMaxMusd,
        dailyCapMusd,
        ceilings: cfg,
        expiresAt: new Date(Date.now() + DEFAULTS.nonceTtlMs).toISOString(),
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.shortMessage || e.message });
    }
  });

  // --- apply: verify the signature, then write with the owner key ------------
  router.post("/apply", async (req, res) => {
    const { nonce, signature } = req.body || {};
    try {
      if (!nonce || !signature) return res.status(400).json({ ok: false, error: "nonce and signature are required" });
      const t = treasuryWithSigner();
      if (!t) return res.status(503).json({ ok: false, error: "gateway has no owner key" });

      const s = prune(loadState());
      const record = s.nonces[nonce];
      if (!record) {
        return res.status(410).json({
          ok: false,
          error: "that challenge is expired or already used",
          hint: "Request a fresh challenge — nonces are single-use.",
        });
      }

      // THE ONLY TRUST DECISION: does this signature come from the agent wallet?
      const signer = ethers.verifyMessage(record.message, signature);
      if (signer.toLowerCase() !== record.address.toLowerCase()) {
        delete s.nonces[nonce]; // burned: a mismatched signature is not retried
        saveState(s);
        return res.status(403).json({
          ok: false,
          error: `signature is from ${signer}, not from ${record.address}`,
          hint: "Sign with the agent wallet this change is for.",
        });
      }
      delete s.nonces[nonce]; // consumed before the tx, so a retry cannot double-apply

      const { global, mine } = countThisHour(s, record.address);
      if (mine >= DEFAULTS.perAddressPerHour || global >= DEFAULTS.globalPerHour) {
        saveState(s);
        return res.status(429).json({
          ok: false,
          error: "rate limit reached",
          hint: `Each change is an owner transaction paid in real gas: ${DEFAULTS.perAddressPerHour} per address per hour, ${DEFAULTS.globalPerHour} globally. Try again next hour.`,
          used: { mine, global },
        });
      }

      const before = await t.agentStatus(record.address).catch(() => null);
      let tx;
      if (record.action === "limits") {
        tx = await t.setAgentLimits(
          record.address,
          ethers.parseUnits(record.perCallMaxMusd, 18),
          ethers.parseUnits(record.dailyCapMusd, 18)
        );
      } else {
        tx = await t.setAgentActive(record.address, record.action === "unfreeze");
      }

      // Bounded wait: the Mezo RPC has been observed hanging on receipt polling
      // long after the tx confirmed, which would leave the UI spinning on a
      // change that already happened. The hash is the identity; return it.
      const rc = await Promise.race([
        tx.wait().catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 25_000)),
      ]);

      const change = {
        at: new Date().toISOString(),
        hour: hourKey(),
        address: record.address,
        action: record.action,
        perCallMaxMusd: record.perCallMaxMusd,
        dailyCapMusd: record.dailyCapMusd,
        previous: before
          ? { perCallMaxMusd: ethers.formatUnits(before.perCallMax, 18), dailyCapMusd: ethers.formatUnits(before.dailyCap, 18), active: before.active }
          : null,
        txHash: tx.hash,
        confirmed: Boolean(rc && rc.status === 1),
        source: "self-service",
      };
      s.changes.unshift(change);
      saveState(s);
      log(`  🔧 ${record.address.slice(0, 10)}… ${record.action} → ${tx.hash}`);

      // Fire and forget: an alerting outage must never fail a budget change.
      notify(record.address, {
        kind: record.action === "limits" ? "limits_changed" : record.action === "freeze" ? "agent_frozen" : "agent_unfrozen",
        change,
      }).catch(() => {});

      res.json({ ok: true, ...change });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.shortMessage || e.message });
    }
  });

  // --- audit trail for one address ------------------------------------------
  router.get("/history", (req, res) => {
    try {
      const address = ethers.getAddress(String(req.query.address || ""));
      const s = loadState();
      res.json({
        ok: true,
        address,
        changes: s.changes.filter((c) => c.address?.toLowerCase() === address.toLowerCase()).slice(0, 25),
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.shortMessage || e.message });
    }
  });

  return { router, config: () => ({ ok: true, ceilings: cfg }) };
}
