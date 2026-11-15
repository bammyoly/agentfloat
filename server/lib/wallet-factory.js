// ---------------------------------------------------------------------------
// Agent wallet factory — creates, stores, and retrieves per-user agent EOAs.
//
// FLOW
//   1. User connects their primary wallet (Reown / MetaMask)
//   2. session-auth.js calls getOrCreateAgentWallet(primaryAddress)
//   3. If new: viem generates a random EOA, crypto.js encrypts the key,
//      db.js stores it, and this module registers it in the treasury
//   4. On every /api/pay: getAgentPrivateKey(agentAddress) decrypts the key
//      in memory for the duration of one x402 signing operation
//
// The agent wallet is a PLAIN EOA — not a smart contract wallet, not ERC-4337,
// not EIP-7702. x402 on Mezo settles with permit2 (EIP-712 signature), which
// only an EOA can produce.
// ---------------------------------------------------------------------------

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ethers } from "ethers";
import { AgentWallet, isDBConnected } from "./db.js";
import { encryptPrivateKey, decryptPrivateKey } from "./crypto.js";

// --- Wave 2 registration caps ----------------------------------------------
// In Wave 1 the treasury funded agents, so tight caps made sense. In Wave 2
// users self-fund via the Earn page (deposit BTC → borrow MUSD → transfer to
// agent). The on-chain caps are now a CEILING OF LAST RESORT — the real
// budget is in MongoDB (DAILY_SPEND_CAP_MUSD, default 10 MUSD).
const PER_CALL_MAX = ethers.parseUnits(
  process.env.ONCHAIN_PER_CALL_MAX || "100", 18
);
const DAILY_CAP = ethers.parseUnits(
  process.env.ONCHAIN_DAILY_CAP || "10000", 18
);

// --- Hard timeout for DB operations ----------------------------------------
// Prevents login from hanging indefinitely if MongoDB is slow, degraded, or
// the connection dropped mid-query. Matches the client-side retry strategy:
// the client retries every 2–16s, so a 10s server timeout means the first
// retry will likely hit a recovered connection.
const DB_TIMEOUT_MS = 10_000;

function withTimeout(promise, label = "DB operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${DB_TIMEOUT_MS}ms`)),
        DB_TIMEOUT_MS
      )
    ),
  ]);
}

// --- Public API ------------------------------------------------------------

/**
 * Get or create an agent wallet for a primary (connected) wallet address.
 *
 * Thread-safe: handles duplicate-key races from React StrictMode double-mounts
 * or concurrent login requests by catching E11000 and re-reading the existing
 * document.
 *
 * @param {string} primaryAddress — the user's connected wallet (checksummed or not)
 * @returns {Promise<{ agentAddress: string, isNew: boolean }>}
 */
export async function getOrCreateAgentWallet(primaryAddress) {
  if (!isDBConnected()) {
    throw new Error("MongoDB not connected — cannot create agent wallet");
  }

  const primary = primaryAddress.toLowerCase();

  return withTimeout(_getOrCreateImpl(primary), "getOrCreateAgentWallet");
}

async function _getOrCreateImpl(primary) {
  // Fast path: already exists
  const existing = await AgentWallet.findOne({ primaryAddress: primary });
  if (existing) {
    return { agentAddress: existing.agentAddress, isNew: false };
  }

  // Generate a new EOA
  const privateKey = generatePrivateKey(); // 0x-prefixed, 66 chars
  const account = privateKeyToAccount(privateKey);
  const agentAddress = account.address.toLowerCase();

  // Encrypt and store
  const encrypted = encryptPrivateKey(privateKey);

  try {
    await AgentWallet.create({
      primaryAddress: primary,
      agentAddress,
      encryptedPrivateKey: encrypted,
      registeredInTreasury: false,
    });
    return { agentAddress, isNew: true };
  } catch (err) {
    // Duplicate key race (E11000): another request created the wallet between
    // our findOne and create. Re-read and return the existing one.
    if (err.code === 11000) {
      const doc = await AgentWallet.findOne({ primaryAddress: primary });
      if (doc) return { agentAddress: doc.agentAddress, isNew: false };
    }
    throw err;
  }
}

/**
 * Decrypt and return the private key for an agent wallet.
 * The key lives in memory only for the duration of the caller's operation.
 *
 * @param {string} agentAddress — the agent EOA address
 * @returns {Promise<string>} 0x-prefixed private key
 */
export async function getAgentPrivateKey(agentAddress) {
  if (!isDBConnected()) {
    throw new Error("MongoDB not connected — cannot retrieve agent key");
  }

  return withTimeout(_getKeyImpl(agentAddress), "getAgentPrivateKey");
}

async function _getKeyImpl(agentAddress) {
  const doc = await AgentWallet.findOne({
    agentAddress: agentAddress.toLowerCase(),
  });
  if (!doc) {
    throw new Error(`No agent wallet found for ${agentAddress}`);
  }
  return decryptPrivateKey(doc.encryptedPrivateKey);
}

/**
 * Register a new agent in the on-chain treasury contract.
 * Called best-effort from session-auth.js after wallet creation.
 * Non-blocking: if it fails, the agent still works for self-funded payments
 * (the gateway's evaluatePolicy will flag "not_registered" but the MongoDB
 * budget still applies).
 *
 * @param {string} agentAddress — the new agent EOA
 * @param {ethers.Wallet} treasurySigner — the owner wallet that can call registerAgent()
 * @param {string} deploymentAddress — the treasury contract address
 * @param {string} rpcUrl — Mezo testnet RPC
 * @param {Function} log — logging function
 */
export async function registerAgentInTreasury(
  agentAddress,
  treasurySigner,
  deploymentAddress,
  rpcUrl,
  log = console.log,
) {
  try {
    const TREASURY_ABI = [
      "function registerAgent(address agent, address gateway, uint128 perCallMax, uint128 dailyCap)",
      "function isRegistered(address) view returns (bool)",
    ];

    const provider = new ethers.JsonRpcProvider(rpcUrl, 31611);
    const signer = treasurySigner.connect(provider);
    const treasury = new ethers.Contract(deploymentAddress, TREASURY_ABI, signer);

    // Check if already registered (idempotent)
    const already = await treasury.isRegistered(agentAddress);
    if (already) {
      log(`  [wallet] ${agentAddress.slice(0, 10)}… already registered in treasury`);
      await AgentWallet.findOneAndUpdate(
        { agentAddress: agentAddress.toLowerCase() },
        { registeredInTreasury: true },
      );
      return;
    }

    // The gateway address is the signer's address (the operator wallet).
    // This is what recordPayment() checks: msg.sender == agent.gateway.
    const gatewayAddress = await signer.getAddress();

    const tx = await treasury.registerAgent(
      agentAddress,
      gatewayAddress,
      PER_CALL_MAX,
      DAILY_CAP,
    );

    // Bounded wait — Mezo RPC hangs on tx.wait()
    await Promise.race([
      tx.wait().catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 30_000)),
    ]);

    log(`  [wallet] registered ${agentAddress.slice(0, 10)}… in treasury (tx ${tx.hash})`);
    log(`           caps: perCall=${ethers.formatUnits(PER_CALL_MAX, 18)} daily=${ethers.formatUnits(DAILY_CAP, 18)} MUSD`);

    await AgentWallet.findOneAndUpdate(
      { agentAddress: agentAddress.toLowerCase() },
      { registeredInTreasury: true },
    );
  } catch (e) {
    log(`  [wallet] treasury registration failed for ${agentAddress.slice(0, 10)}…: ${e.shortMessage || e.message}`);
    log(`           The agent can still self-fund; on-chain receipts will be skipped.`);
  }
}

