// server/lib/spend-tracker.js
import mongoose from 'mongoose';

/* ── Daily spend ledger ────────────────────────────────── */
const dailySpendSchema = new mongoose.Schema(
  {
    agentAddress: { type: String, required: true, lowercase: true },
    date:         { type: String, required: true },          // "YYYY-MM-DD"
    totalSpent:   { type: Number, default: 0 },              // MUSD, 6-dec float
    txCount:      { type: Number, default: 0 },
  },
  { timestamps: true },
);
dailySpendSchema.index({ agentAddress: 1, date: 1 }, { unique: true });

const DailySpend =
  mongoose.models.DailySpend || mongoose.model('DailySpend', dailySpendSchema);

/* ── Nonce replay guard (auto-expires after 1 h) ──────── */
const usedNonceSchema = new mongoose.Schema(
  {
    nonce:        { type: String, required: true, unique: true },
    agentAddress: { type: String, required: true, lowercase: true },
    usedAt:       { type: Date, default: Date.now },
  },
  { timestamps: false },
);
usedNonceSchema.index({ usedAt: 1 }, { expireAfterSeconds: 3600 });

const UsedNonce =
  mongoose.models.UsedNonce || mongoose.model('UsedNonce', usedNonceSchema);

/* ── Public helpers ────────────────────────────────────── */

/**
 * Atomically check the daily cap and record the spend.
 * Throws if the cap would be exceeded.
 */
export async function checkAndRecordSpend(agentAddress, amount, dailyCap) {
  const date = new Date().toISOString().slice(0, 10);
  const addr = agentAddress.toLowerCase();

  const doc = await DailySpend.findOne({ agentAddress: addr, date });
  const current = doc ? doc.totalSpent : 0;

  if (current + amount > dailyCap) {
    const err = new Error(
      `Daily cap exceeded: ${current} + ${amount} > ${dailyCap} MUSD`,
    );
    err.status = 429;
    throw err;
  }

  await DailySpend.findOneAndUpdate(
    { agentAddress: addr, date },
    { $inc: { totalSpent: amount, txCount: 1 } },
    { upsert: true, new: true },
  );

  return {
    totalSpent: current + amount,
    remaining:  +(dailyCap - current - amount).toFixed(6),
  };
}

export async function isNonceUsed(nonce) {
  return !!(await UsedNonce.findOne({ nonce }));
}

export async function markNonceUsed(nonce, agentAddress) {
  try {
    await UsedNonce.create({ nonce, agentAddress: agentAddress.toLowerCase() });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;   // duplicate → already used
    throw err;
  }
}

export async function getDailySpend(agentAddress) {
  const date = new Date().toISOString().slice(0, 10);
  const doc = await DailySpend.findOne({
    agentAddress: agentAddress.toLowerCase(),
    date,
  });
  return doc
    ? { totalSpent: doc.totalSpent, txCount: doc.txCount }
    : { totalSpent: 0, txCount: 0 };
}