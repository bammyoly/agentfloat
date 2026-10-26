// ---------------------------------------------------------------------------
// AgentFloat — change an agent's spending limits on chain
//
//   AGENT_ADDRESS=0x… PER_CALL_MAX=0.0005 node scripts/set-limits.js
//   AGENT_ADDRESS=0x… ACTIVE=false        node scripts/set-limits.js
//
// The treasury — not the gateway — is the authority on per-call and daily caps.
// This script exists so those limits can be changed without re-running the whole
// agent setup (which also touches allowances and funding).
//
// It deliberately POLLS the chain instead of awaiting tx.wait(): on the Mezo
// testnet RPC tx.wait() can hang for minutes after the transaction has already
// confirmed, which made earlier scripts look frozen.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://rpc.test.mezo.org";
const OUT_DIR = path.resolve(__dirname, "..", "..", "frontend", "src", "contracts");
const CHAIN_JSON = path.join(OUT_DIR, "chain.json");
const CONTRACT_ENV = path.resolve(__dirname, "..", ".env");
const log = (...a) => console.log(...a);

const ABI = [
  "function setAgentLimits(address agent, uint128 perCallMax, uint128 dailyCap)",
  "function setAgentActive(address agent, bool active)",
  "function agentStatus(address agent) view returns (tuple(bool active, address gateway, uint128 perCallMax, uint128 dailyCap, uint128 dayFunded, uint256 remainingToday, uint256 walletBalance, uint256 lifetimeFunded, uint256 lifetimeRecalled, uint256 recallAllowance, uint256 payments, uint256 denials))",
  "function isRegistered(address) view returns (bool)",
];

function readEnvKey(file, key) {
  try {
    const m = fs.readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

/** Poll `check()` until it returns true, or throw after `ms`. */
async function pollUntil(label, check, ms = 180_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${label} did not change on chain within ${ms / 1000}s`);
}

async function main() {
  const chain = JSON.parse(fs.readFileSync(CHAIN_JSON, "utf8"));
  const deployment = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "deployment.json"), "utf8"));

  const ownerKey = process.env.DEPLOYER_PRIVATE_KEY || readEnvKey(CONTRACT_ENV, "DEPLOYER_PRIVATE_KEY");
  if (!ownerKey) throw new Error("No DEPLOYER_PRIVATE_KEY in env or contract/.env");

  const target = process.env.AGENT_ADDRESS;
  if (!target) throw new Error("Set AGENT_ADDRESS=0x… for the agent to update.");
  const agent = ethers.getAddress(target);

  const provider = new ethers.JsonRpcProvider(RPC);
  const owner = new ethers.Wallet(ownerKey, provider);
  const treasury = new ethers.Contract(deployment.address, ABI, owner);

  const f = (w) => ethers.formatUnits(w, 18);
  const before = await treasury.agentStatus(agent);

  log(`\n== Update agent limits ==================================================`);
  log(`  agent     ${agent}`);
  log(`  treasury  ${deployment.address}`);
  log(`  owner     ${owner.address}`);
  log(`  before    active=${before.active} perCallMax=${f(before.perCallMax)} dailyCap=${f(before.dailyCap)}`);

  const wantActive = process.env.ACTIVE === undefined ? null : String(process.env.ACTIVE).toLowerCase() !== "false";
  const perCallMax = process.env.PER_CALL_MAX ? ethers.parseUnits(process.env.PER_CALL_MAX, 18) : before.perCallMax;
  const dailyCap = process.env.DAILY_CAP ? ethers.parseUnits(process.env.DAILY_CAP, 18) : before.dailyCap;

  if (perCallMax > dailyCap) {
    throw new Error(`perCallMax ${f(perCallMax)} cannot exceed dailyCap ${f(dailyCap)}`);
  }

  const gas = await provider.getBalance(owner.address);
  log(`  owner gas ${f(gas)} ${chain.nativeCurrency.symbol}`);
  if (gas === 0n) throw new Error("Owner has no gas.");

  // --- limits -------------------------------------------------------------
  if (perCallMax !== before.perCallMax || dailyCap !== before.dailyCap) {
    log(`\n  setAgentLimits(${f(perCallMax)}, ${f(dailyCap)})…`);
    const tx = await treasury.setAgentLimits(agent, perCallMax, dailyCap);
    log(`  tx        ${tx.hash}`);
    await pollUntil("limits", async () => {
      const s = await treasury.agentStatus(agent);
      return s.perCallMax === perCallMax && s.dailyCap === dailyCap;
    });
    log(`  ✅ limits confirmed on chain`);
  } else {
    log(`\n  limits unchanged — skipping setAgentLimits`);
  }

  // --- active flag --------------------------------------------------------
  if (wantActive !== null && wantActive !== before.active) {
    log(`\n  setAgentActive(${wantActive})…`);
    const tx = await treasury.setAgentActive(agent, wantActive);
    log(`  tx        ${tx.hash}`);
    await pollUntil("active flag", async () => (await treasury.agentStatus(agent)).active === wantActive);
    log(`  ✅ active=${wantActive} confirmed on chain`);
  } else if (wantActive !== null) {
    log(`  active already ${wantActive} — skipping`);
  }

  const after = await treasury.agentStatus(agent);
  log(`\n  after     active=${after.active} perCallMax=${f(after.perCallMax)} dailyCap=${f(after.dailyCap)}`);
  log(`            remainingToday=${f(after.remainingToday)} wallet=${f(after.walletBalance)} MUSD`);
  log(`            payments=${after.payments.toString()} denials=${after.denials.toString()}`);
  log(``);
}

main().catch((err) => {
  console.error(`\n❌ set-limits failed:`, err.shortMessage || err.message || err);
  process.exitCode = 1;
});
