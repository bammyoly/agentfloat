// ---------------------------------------------------------------------------
// Session authentication: EIP-191 challenge/response + session tokens.
// See earlier header comment for the flow.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { Router } from "express";
import { ethers } from "ethers";
import { Session, AgentWallet, isDBConnected } from "./db.js";
import { getOrCreateAgentWallet, registerAgentInTreasury } from "./wallet-factory.js";
import { getDailySpend } from "./spend-tracker.js";

const NONCE_TTL_MS = 5 * 60_000;
const nonces = new Map();

function pruneNonces() {
  const now = Date.now();
  for (const [k, v] of nonces) {
    if (now - v.createdAt > NONCE_TTL_MS) nonces.delete(k);
  }
}

function buildChallengeMessage(address, nonce) {
  return [
    "AgentFloat: sign in to your agent wallet",
    "",
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    "",
    "This signature proves you control this wallet. It authorizes no transfer.",
    "AgentFloat will create or retrieve your server-side agent wallet.",
  ].join("\n");
}

export const sessionRouter = Router();

// --- challenge -------------------------------------------------------------
sessionRouter.get("/challenge", (req, res) => {
  try {
    const address = ethers.getAddress(String(req.query.address || ""));
    if (!isDBConnected()) {
      return res.status(503).json({
        ok: false,
        error: "MongoDB not connected — set MONGODB_URI in server/.env",
      });
    }
    pruneNonces();
    const nonce = crypto.randomUUID();
    const message = buildChallengeMessage(address, nonce);
    nonces.set(nonce, {
      address: address.toLowerCase(),
      message,
      createdAt: Date.now(),
    });
    res.json({
      ok: true,
      address,
      nonce,
      message,
      expiresAt: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.shortMessage || e.message });
  }
});

// --- login -----------------------------------------------------------------
sessionRouter.post("/login", async (req, res) => {
  const { address: rawAddress, signature, message } = req.body || {};
  try {
    if (!rawAddress || !signature || !message) {
      return res.status(400).json({
        ok: false,
        error: "address, signature, and message are required",
      });
    }
    if (!isDBConnected()) {
      return res.status(503).json({ ok: false, error: "MongoDB not connected" });
    }

    const address = ethers.getAddress(rawAddress);
    const primary = address.toLowerCase();

    let recovered;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch (e) {
      return res.status(400).json({
        ok: false,
        error: `signature verification failed: ${e.shortMessage || e.message}`,
      });
    }
    if (recovered.toLowerCase() !== primary) {
      return res.status(403).json({
        ok: false,
        error: `signature is from ${recovered}, not ${address}`,
      });
    }

    pruneNonces();
    let matchedNonce = null;
    for (const [nonce, v] of nonces) {
      if (message.includes(nonce) && v.address === primary) {
        matchedNonce = nonce;
        break;
      }
    }
    if (!matchedNonce) {
      return res.status(410).json({
        ok: false,
        error: "challenge expired or already used — request a fresh one",
      });
    }
    nonces.delete(matchedNonce);

    const { agentAddress, isNew } = await getOrCreateAgentWallet(address);

    if (isNew && req.app.locals.treasurySigner && req.app.locals.deploymentAddress) {
      registerAgentInTreasury(
        agentAddress,
        req.app.locals.treasurySigner,
        req.app.locals.deploymentAddress,
        req.app.locals.rpcUrl,
        req.app.locals.log || console.log
      ).catch(() => {});
    }

    const token = crypto.randomUUID();
    const ttlHours = Number(process.env.SESSION_TTL_HOURS || 24);
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

    await Session.create({
      token,
      primaryAddress: primary,
      agentAddress: agentAddress.toLowerCase(),
      expiresAt,
    });

    res.json({
      ok: true,
      primaryAddress: address,
      agentAddress,
      isNewAgent: isNew,
      sessionToken: token,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.shortMessage || e.message });
  }
});

// --- me (session info + daily spend) --------------------------------------
sessionRouter.get("/me", requireSession, async (req, res) => {
  try {
    const agentWallet = await AgentWallet.findOne({
      agentAddress: req.session.agentAddress,
    });
    const spend = await getDailySpend(req.session.agentAddress);
    const dailyCap = parseFloat(process.env.DAILY_SPEND_CAP_MUSD || "10");

    res.json({
      ok: true,
      primaryAddress: req.session.primaryAddress,
      agentAddress: req.session.agentAddress,
      registered: agentWallet?.registeredInTreasury ?? false,
      dailySpend: spend.totalSpent,
      dailyCap,
      dailyRemaining: +(dailyCap - spend.totalSpent).toFixed(6),
      txCountToday: spend.txCount,
      expiresAt: req.session.expiresAt,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.shortMessage || e.message });
  }
});

// --- logout ----------------------------------------------------------------
sessionRouter.post("/logout", async (req, res) => {
  const token = extractToken(req);
  if (token) {
    await Session.deleteOne({ token }).catch(() => {});
  }
  res.json({ ok: true });
});

// --- middleware -------------------------------------------------------------

function extractToken(req) {
  return (
    req.headers["x-session-token"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "") ||
    null
  );
}

export async function requireSession(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "authentication required",
      hint: "Sign in with your wallet to get a session token, then include it as X-Session-Token header.",
    });
  }
  try {
    const session = await Session.findOne({
      token,
      expiresAt: { $gt: new Date() },
    });
    if (!session) {
      return res.status(401).json({
        ok: false,
        error: "session expired or invalid — sign in again",
      });
    }
    req.session = {
      primaryAddress: session.primaryAddress,
      agentAddress: session.agentAddress,
      expiresAt: session.expiresAt,
    };
    next();
  } catch (e) {
    res.status(500).json({ ok: false, error: "session check failed" });
  }
}


