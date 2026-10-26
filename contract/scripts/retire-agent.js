// ---------------------------------------------------------------------------
// AgentFloat — retire an agent
//
//   AGENT_ADDRESS=0x... ./node_modules/.bin/hardhat run scripts/retire-agent.js --network mezoTestnet
//
// Marks an agent inactive on chain and drops it from frontend/src/contracts/
// agents.json. Use it to clean up wallets that were registered by accident —
// e.g. an older build of setup-agent.js generated a fresh key on every run.
//
// Inactive agents cannot be funded or spend, but the treasury can still recall
// any float they hold. This is a reversible control: setAgentActive(agent,true)
// brings the wallet back.
//
// Add SWEEP=1 to also recall the agent's remaining MUSD back to the treasury
// (requires the agent's recall allowance, granted by setup-agent.js).
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const OUT_DIR = path.resolve(__dirname, "..", "..", "frontend", "src", "contracts");
const AGENTS_JSON = path.join(OUT_DIR, "agents.json");
const log = (...a) => console.log(...a);
const fmt = (wei, dp = 4) => Number(ethers.formatUnits(wei, 18)).toFixed(dp);

/**
 * Poll the chain for an expected state change instead of awaiting tx.wait().
 *
 * On the Mezo testnet RPC tx.wait() routinely hangs for minutes AFTER the
 * transaction has confirmed — this script was killed by a 240s timeout while the
 * deactivation it was waiting for had already landed. The chain is the source of
 * truth, so read it.
 */
async function pollUntil(label, check, ms = 180_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await check()) return true; } catch { /* transient RPC error */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${label} did not change on chain within ${ms / 1000}s — the tx may still land; re-run to check`);
}

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

async function main() {
  const target = process.env.AGENT_ADDRESS;
  if (!target) throw new Error("Set AGENT_ADDRESS=0x... to the agent you want to retire.");
  const agent = ethers.getAddress(target);

  const deployment = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "deployment.json"), "utf8"));
  const chain = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "chain.json"), "utf8"));

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== deployment.chainId) {
    throw new Error(`Connected to chainId ${chainId}, deployment is on ${deployment.chainId}.`);
  }

  const [owner] = await ethers.getSigners();
  const treasury = await ethers.getContractAt("AgentFloatTreasury", deployment.address);
  const musd = await ethers.getContractAt(ERC20, chain.musd.address);

  log(`\n== Retire agent =========================================================`);
  log(`  agent     ${agent}`);
  log(`  treasury  ${deployment.address}`);
  log(`  owner     ${owner.address}`);

  if (owner.address.toLowerCase() !== deployment.owner.toLowerCase()) {
    throw new Error(`Signer ${owner.address} is not the treasury owner ${deployment.owner}.`);
  }

  // agentStatus() calls _requireAgent() internally, so reaching this point at
  // all proves the wallet is registered — there is no `registered` field.
  const status = await treasury.agentStatus(agent);
  log(`  registered true`);
  log(`  active     ${status.active}  (before)`);
  log(`  float held ${fmt(status.walletBalance)} MUSD`);

  // --- 1. Deactivate on chain ---------------------------------------------
  if (status.active) {
    const tx = await treasury.connect(owner).setAgentActive(agent, false);
    log(`\n  setAgentActive(false) sent — tx ${tx.hash}`);
    await pollUntil("deactivation", async () => (await treasury.agentStatus(agent)).active === false);
    log(`  ✅ deactivated on chain (verified by reading agentStatus)`);
    if (chain.explorerUrl) log(`     ${chain.explorerUrl}/tx/${tx.hash}`);
  } else {
    log(`\n  already inactive on chain — nothing to do`);
  }

  // --- 2. Optionally sweep the remaining float back -----------------------
  if (process.env.SWEEP) {
    const bal = await musd.balanceOf(agent);
    const allowed = await musd.allowance(agent, deployment.address);
    if (bal === 0n) {
      log(`  SWEEP: no float to recall`);
    } else if (allowed < bal) {
      log(`  SWEEP: skipped — recall allowance ${fmt(allowed)} < balance ${fmt(bal)}`);
      log(`         run setup-agent.js for this wallet to grant it first`);
    } else {
      const sx = await treasury.connect(owner).recallFromAgent(agent, bal);
      log(`  recallFromAgent sent — tx ${sx.hash}`);
      await pollUntil("recall", async () => (await musd.balanceOf(agent)) === 0n);
      log(`  ✅ recalled ${fmt(bal)} MUSD back to the treasury (verified by reading the balance)`);
    }
  }

  // --- 3. Drop it from the frontend artifact ------------------------------
  if (fs.existsSync(AGENTS_JSON)) {
    const file = JSON.parse(fs.readFileSync(AGENTS_JSON, "utf8"));
    const list = Array.isArray(file) ? file : file.agents || [];
    const before = list.length;
    const kept = list.filter((a) => a.address.toLowerCase() !== agent.toLowerCase());
    if (kept.length !== before) {
      if (Array.isArray(file)) fs.writeFileSync(AGENTS_JSON, JSON.stringify(kept, null, 2) + "\n");
      else fs.writeFileSync(AGENTS_JSON, JSON.stringify({ ...file, agents: kept }, null, 2) + "\n");
      log(`\n  ✅ removed from agents.json (${before} -> ${kept.length} agent(s))`);
    } else {
      log(`\n  not present in agents.json — left as is`);
    }
  }

  const after = await treasury.agentStatus(agent);
  log(`\n  active     ${after.active}  (after)`);
  log(`  treasury balance now ${fmt(await treasury.treasuryBalance())} MUSD`);
  log(``);
}

main().catch((err) => {
  console.error(`\n❌ retire-agent failed:`, err.message || err);
  process.exitCode = 1;
});
