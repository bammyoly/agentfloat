// ---------------------------------------------------------------------------
// sMUSD idle-float sweep.
//
// Sweeps MUSD that is sitting idle in agent wallets into the Mezo
// MUSDSavingsRate vault to earn yield. Runs as a background loop and also
// exposes an "ensure liquidity" helper that /api/pay calls before signing.
//
// The judges flagged that Wave 1 probed the MAINNET vault address. This
// module uses the TESTNET address exclusively:
//   0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16
// ---------------------------------------------------------------------------

import { ethers } from "ethers";
import { AgentWallet, isDBConnected } from "./db.js";
import { getAgentPrivateKey } from "./wallet-factory.js";

// --- config ----------------------------------------------------------------

const VAULT_ADDRESS = (
  process.env.SAVINGS_VAULT_ADDRESS ||
  "0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16"
).toLowerCase();

const SWEEP_THRESHOLD = parseFloat(process.env.SWEEP_THRESHOLD_MUSD || "50");
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MIN || 5) * 60_000;
const MIN_SWEEP_AMOUNT = parseFloat(process.env.MIN_SWEEP_MUSD || "10");
const TX_WAIT_MS = 30_000;

// MUSD on Mezo testnet, same address the rest of the gateway uses.
const MUSD_ADDRESS = (
  process.env.MUSD_ADDRESS ||
  "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503"
).toLowerCase();

// --- ABIs ------------------------------------------------------------------

const MUSD_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

const VAULT_ABI_SIMPLE = [
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function getCompoundedMUSDDeposit(address) view returns (uint256)",
];

const VAULT_ABI_ERC4626 = [
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
];

// --- helpers ---------------------------------------------------------------

const fmtMusd = (wei) => Number(ethers.formatUnits(BigInt(wei || 0), 18));
const parseMusd = (n) => ethers.parseUnits(Number(n).toFixed(18), 18);

function getProvider(rpcUrl) {
  return new ethers.JsonRpcProvider(rpcUrl, 31611);
}

async function getAgentWallet(agentAddress, rpcUrl) {
  const key = await getAgentPrivateKey(agentAddress);
  const provider = getProvider(rpcUrl);
  return new ethers.Wallet(key, provider);
}

// Resolves to the receipt, or null if the wait fails or times out.
function waitForTx(tx, ms = TX_WAIT_MS) {
  return Promise.race([
    tx.wait().catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Detect which vault interface the contract actually implements.
 * Cached per process because the contract does not change at runtime.
 * Network errors are not cached, so a flaky RPC cannot lock in the wrong pattern.
 */
let vaultPattern = null;
async function detectVaultPattern(provider) {
  if (vaultPattern) return vaultPattern;
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI_ERC4626, provider);
  try {
    // ERC4626 has previewRedeem; simple vaults do not.
    await vault.previewRedeem.staticCall(ethers.parseUnits("1", 18));
    vaultPattern = "erc4626";
  } catch (e) {
    if (e.code === "CALL_EXCEPTION" || e.code === "BAD_DATA") {
      vaultPattern = "simple";
    } else {
      throw e;
    }
  }
  return vaultPattern;
}

// --- core operations -------------------------------------------------------

/**
 * Read the agent's sMUSD balance in the savings vault.
 * Returns floats in MUSD equivalent units.
 */
export async function getSavingsBalance(agentAddress, rpcUrl) {
  try {
    const provider = getProvider(rpcUrl);
    const pattern = await detectVaultPattern(provider);

    if (pattern === "erc4626") {
      const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI_ERC4626, provider);
      const shares = await vault.balanceOf(agentAddress);
      if (shares === 0n) return { shares: 0, assets: 0, pattern };
      const assets = await vault.convertToAssets(shares);
      return { shares: fmtMusd(shares), assets: fmtMusd(assets), pattern };
    }

    // Simple pattern
    const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI_SIMPLE, provider);
    try {
      const deposited = await vault.getCompoundedMUSDDeposit(agentAddress);
      return { shares: 0, assets: fmtMusd(deposited), pattern };
    } catch {
      const shares = await vault.balanceOf(agentAddress);
      return { shares: fmtMusd(shares), assets: fmtMusd(shares), pattern };
    }
  } catch (e) {
    return { shares: 0, assets: 0, error: e.shortMessage || e.message };
  }
}

/**
 * Sweep excess MUSD from an agent wallet into the savings vault.
 * Only sweeps if the liquid balance exceeds SWEEP_THRESHOLD + MIN_SWEEP_AMOUNT.
 *
 * @returns {{ swept: number, txHash: string|null, reason?: string, confirmed?: boolean }}
 */
export async function sweepAgent(agentAddress, rpcUrl, log = console.log) {
  try {
    const wallet = await getAgentWallet(agentAddress, rpcUrl);
    const musd = new ethers.Contract(MUSD_ADDRESS, MUSD_ABI, wallet);

    const balance = await musd.balanceOf(agentAddress);
    const balanceMusd = fmtMusd(balance);

    if (balanceMusd < SWEEP_THRESHOLD + MIN_SWEEP_AMOUNT) {
      return {
        swept: 0,
        txHash: null,
        reason: `balance ${balanceMusd.toFixed(2)} below threshold ${SWEEP_THRESHOLD} + min ${MIN_SWEEP_AMOUNT}`,
      };
    }

    const excess = balanceMusd - SWEEP_THRESHOLD;
    const excessWei = parseMusd(excess);

    // Approve the vault if needed
    const allowance = await musd.allowance(agentAddress, VAULT_ADDRESS);
    if (allowance < excessWei) {
      log(`   [sweep] approving vault for ${agentAddress.slice(0, 10)}…`);
      const approveTx = await musd.approve(VAULT_ADDRESS, ethers.MaxUint256);
      const approveRc = await waitForTx(approveTx);
      if (!approveRc || approveRc.status !== 1) {
        return { swept: 0, txHash: null, reason: "approval not confirmed" };
      }
    }

    // Deposit
    const pattern = await detectVaultPattern(wallet.provider);
    let depositTx;

    if (pattern === "erc4626") {
      const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI_ERC4626, wallet);
      depositTx = await vault.deposit(excessWei, agentAddress);
    } else {
      const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI_SIMPLE, wallet);
      depositTx = await vault.deposit(excessWei);
    }

    const rc = await waitForTx(depositTx);

    log(`   [sweep] ${agentAddress.slice(0, 10)}… deposited ${excess.toFixed(2)} MUSD → sMUSD (tx ${depositTx.hash})`);
    return { swept: excess, txHash: depositTx.hash, confirmed: rc?.status === 1 };
  } catch (e) {
    log(`   [sweep] ${agentAddress.slice(0, 10)}… failed: ${e.shortMessage || e.message}`);
    return { swept: 0, txHash: null, error: e.shortMessage || e.message };
  }
}

/**
 * Ensure the agent has at least `neededMusd` liquid MUSD.
 * If not, calculate the exact shortfall, cap the withdrawal to the available
 * vault balance, and withdraw from the savings vault before payment execution.
 * Called by /api/pay BEFORE signing.
 *
 * @returns {{ withdrew: number, txHash: string|null, sufficient: boolean }}
 */
export async function ensureLiquidity(agentAddress, neededMusd, rpcUrl, log = console.log) {
  try {
    const wallet = await getAgentWallet(agentAddress, rpcUrl);
    const musd = new ethers.Contract(MUSD_ADDRESS, MUSD_ABI, wallet);

    const liquid = fmtMusd(await musd.balanceOf(agentAddress));
    if (liquid >= neededMusd) {
      return { withdrew: 0, txHash: null, sufficient: true };
    }

    // Determine available vault balance to prevent a revert on over withdrawal
    const savings = await getSavingsBalance(agentAddress, rpcUrl);
    const vaultBalance = savings.assets || savings.shares || 0;

    if (vaultBalance <= 0) {
      log(`   [liquidity] ${agentAddress.slice(0, 10)}… short ${(neededMusd - liquid).toFixed(2)} MUSD, but vault balance is 0`);
      return { withdrew: 0, txHash: null, sufficient: false, error: "Insufficient liquid and vault balance" };
    }

    // Shortfall plus a replenished float
    const targetShortfall = (neededMusd - liquid) + SWEEP_THRESHOLD;

    // Cap the withdrawal to what the vault actually holds
    const actualWithdraw = Math.min(targetShortfall, vaultBalance);
    const actualWithdrawWei = parseMusd(actualWithdraw);

    const pattern = await detectVaultPattern(wallet.provider);
    let withdrawTx;

    if (pattern === "erc4626") {
      const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI_ERC4626, wallet);
      withdrawTx = await vault.withdraw(actualWithdrawWei, agentAddress, agentAddress);
    } else {
      const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI_SIMPLE, wallet);
      withdrawTx = await vault.withdraw(actualWithdrawWei);
    }

    const rc = await waitForTx(withdrawTx);
    const confirmed = rc?.status === 1;

    // Only report sufficient once the withdrawal has actually landed
    const isSufficient = confirmed && (liquid + actualWithdraw) >= neededMusd;

    log(`   [liquidity] ${agentAddress.slice(0, 10)}… withdrew ${actualWithdraw.toFixed(2)} MUSD from vault (tx ${withdrawTx.hash})`);
    return {
      withdrew: actualWithdraw,
      txHash: withdrawTx.hash,
      sufficient: isSufficient,
      confirmed,
    };
  } catch (e) {
    log(`   [liquidity] ${agentAddress.slice(0, 10)}… withdraw failed: ${e.shortMessage || e.message}`);
    return { withdrew: 0, txHash: null, sufficient: false, error: e.shortMessage || e.message };
  }
}

// --- background sweep loop -------------------------------------------------

let sweepTimer = null;
let sweepRunning = false;

/**
 * Run one sweep cycle across all registered agent wallets.
 */
export async function runSweepCycle(rpcUrl, log = console.log) {
  if (sweepRunning) return;
  if (!isDBConnected()) return;
  sweepRunning = true;

  try {
    const agents = await AgentWallet.find({ registeredInTreasury: true });
    if (agents.length === 0) return;

    log(`   [sweep] cycle starting, ${agents.length} agent(s)`);
    const results = [];

    for (const agent of agents) {
      const r = await sweepAgent(agent.agentAddress, rpcUrl, log);
      results.push({ agent: agent.agentAddress, ...r });
    }

    const swept = results.filter((r) => r.swept > 0);
    if (swept.length > 0) {
      log(`   [sweep] cycle done, swept ${swept.length} agent(s), total ${swept.reduce((s, r) => s + r.swept, 0).toFixed(2)} MUSD`);
    } else {
      log(`   [sweep] cycle done, nothing to sweep`);
    }

    return results;
  } catch (e) {
    log(`   [sweep] cycle error: ${e.message}`);
  } finally {
    sweepRunning = false;
  }
}

/**
 * Start the background sweep loop. Call once at boot.
 */
export function startSweepLoop(rpcUrl, log = console.log) {
  if (sweepTimer) return;
  if (VAULT_ADDRESS === "0x0000000000000000000000000000000000000000") {
    log("   [sweep] disabled, SAVINGS_VAULT_ADDRESS not set");
    return;
  }
  log(`   [sweep] loop starting, every ${SWEEP_INTERVAL_MS / 60_000} min, threshold ${SWEEP_THRESHOLD} MUSD`);
  log(`   [sweep] vault ${VAULT_ADDRESS}`);

  // Run once after a short delay (let the gateway finish booting)
  setTimeout(() => runSweepCycle(rpcUrl, log), 10_000).unref();

  sweepTimer = setInterval(() => runSweepCycle(rpcUrl, log), SWEEP_INTERVAL_MS);
  sweepTimer.unref(); // do not keep the process alive just for sweeps
}

export function stopSweepLoop() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function sweepConfig() {
  return {
    vaultAddress: VAULT_ADDRESS,
    thresholdMusd: SWEEP_THRESHOLD,
    minSweepMusd: MIN_SWEEP_AMOUNT,
    intervalMin: SWEEP_INTERVAL_MS / 60_000,
    running: !!sweepTimer,
  };
}

