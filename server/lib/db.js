import mongoose from "mongoose";

let connected = false;
let connecting = false;

export function isDBConnected() {
  return connected && mongoose.connection.readyState === 1;
}

// ── Schemas ────────────────────────────────────────────────────────────────
// Field names MUST match what wallet-factory.js writes:
//   - encryptedPrivateKey  (NOT encryptedKey)
//   - registeredInTreasury (boolean, set after on-chain registration)
const agentWalletSchema = new mongoose.Schema({
  primaryAddress:       { type: String, required: true, unique: true, lowercase: true },
  agentAddress:         { type: String, required: true, unique: true, lowercase: true },
  encryptedPrivateKey:  { type: String, required: true },
  registeredInTreasury: { type: Boolean, default: false },
  createdAt:            { type: Date, default: Date.now },
});

const sessionSchema = new mongoose.Schema({
  token:          { type: String, required: true, unique: true, index: true },
  primaryAddress: { type: String, required: true, lowercase: true },
  agentAddress:   { type: String, required: true, lowercase: true },
  expiresAt:      { type: Date, required: true, index: { expires: 0 } },
  createdAt:      { type: Date, default: Date.now },
});

const dailySpendSchema = new mongoose.Schema({
  agentAddress: { type: String, required: true, lowercase: true },
  date:         { type: String, required: true }, // "YYYY-MM-DD" UTC
  totalMusd:    { type: Number, default: 0 },
  updatedAt:    { type: Date, default: Date.now },
});
dailySpendSchema.index({ agentAddress: 1, date: 1 }, { unique: true });

const usedNonceSchema = new mongoose.Schema({
  nonce:     { type: String, required: true, unique: true },
  agent:     { type: String, lowercase: true },
  usedAt:    { type: Date, default: Date.now, index: { expires: 3600 } }, // 1h TTL
});

export const AgentWallet = mongoose.model("AgentWallet", agentWalletSchema);
export const Session     = mongoose.model("Session", sessionSchema);
export const DailySpend  = mongoose.model("DailySpend", dailySpendSchema);
export const UsedNonce   = mongoose.model("UsedNonce", usedNonceSchema);

// ── Listeners ──────────────────────────────────────────────────────────────
function _attachListeners(log) {
  mongoose.connection.on("disconnected", () => {
    connected = false;
    log("  ⚠️  MongoDB disconnected — Mongoose will auto-reconnect");
  });
  mongoose.connection.on("reconnected", () => {
    connected = true;
    log("  ✅ MongoDB reconnected");
  });
  mongoose.connection.on("error", (err) => {
    log(`  ⚠️  MongoDB error: ${err.message}`);
  });
}

// ── Background retry loop ──────────────────────────────────────────────────
async function _retryLoop(uri, log) {
  const MAX_DELAY_MS = 60_000;
  let attempt = 1;
  let delay = 3_000;

  while (!connected) {
    attempt++;
    await new Promise((r) => setTimeout(r, delay));
    if (connected) break;

    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10_000,
        heartbeatFrequencyMS: 30_000,
      });
      connected = true;
      connecting = false;
      log(`  ✅ MongoDB connected (retry #${attempt}) — db: ${mongoose.connection.db.databaseName}`);
      _attachListeners(log);
      return;
    } catch (e) {
      const msg = e.message?.split("\n")[0] || String(e);
      const nextDelay = Math.min(Math.round(delay * 1.5), MAX_DELAY_MS);
      log(`  ⚠️  MongoDB retry #${attempt} failed: ${msg}`);
      log(`     Next attempt in ${nextDelay / 1000}s`);
      delay = nextDelay;
    }
  }
}

// ── Public entry point ─────────────────────────────────────────────────────
export async function connectDB(log = console.log) {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    log("  ⚠️  MONGODB_URI not set — session auth disabled");
    return;
  }
  if (connecting || connected) return;
  connecting = true;

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10_000,
      heartbeatFrequencyMS: 30_000,
    });
    connected = true;
    connecting = false;
    log(`  ✅ MongoDB connected — db: ${mongoose.connection.db.databaseName}`);
    _attachListeners(log);
    return;
  } catch (e) {
    const msg = e.message?.split("\n")[0] || String(e);
    log(`  ⚠️  MongoDB initial connection failed: ${msg}`);
    log(`     Gateway starts without DB. Background retries running…`);
  }

  _retryLoop(uri, log);
}