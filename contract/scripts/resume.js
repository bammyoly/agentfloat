// ---------------------------------------------------------------------------
// AgentFloat — resume a treasury that was emergency-stopped
//
//   node scripts/resume.js                      # unpause + restore 2 MUSD float
//   REFUND_MUSD=5 node scripts/resume.js        # unpause + restore 5 MUSD
//   SKIP_FUND=1   node scripts/resume.js        # unpause only
//   AGENT_ADDRESS=0x… node scripts/resume.js    # target a specific agent
//
// WHY THIS EXISTS
//   The Operate page's EMERGENCY STOP button calls treasury.emergencyStop(agent),
//   which does TWO things at once: sets `paused = true` on chain and sweeps the
//   agent's whole MUSD float back to the treasury. Both are needed before any
//   payment can settle again, and while `paused` is true `fundAgent` reverts
//   (it is `whenNotPaused`) — so the order matters: UNPAUSE FIRST, THEN FUND.
//
//   The dashboard can undo this too, but only through an injected wallet
//   (MetaMask) holding the operator key. This script is the CLI path: it needs
//   only DEPLOYER_PRIVATE_KEY in contract/.env, no browser.
//
//   It deliberately POLLS the chain instead of awaiting tx.wait(): on the Mezo
//   testnet RPC tx.wait() can hang for minutes after the transaction has already
//   confirmed, which made earlier scripts look frozen.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://rpc.test.mezo.org";
const OUT_DIR = path.resolve(__dirname, "..", "..", "frontend", "src", "contracts");
const CONTRACT_ENV = path.resolve(__dirname, "..", ".env");
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const log = (...a) => console.log(...a);

const TREASURY_ABI = [
  "function paused() view returns (bool)",
  "function pause()",
  "function unpause()",
  "function fundAgent(address agent, uint256 amount)",
  "function isRegistered(address) view returns (bool)",
  "function agentStatus(address agent) view returns (tuple(bool active, address gateway, uint128 perCallMax, uint128 dailyCap, uint128 dayFunded, uint256 remainingToday, uint256 walletBalance, uint256 lifetimeFunded, uint256 lifetimeRecalled, uint256 recallAllowance, uint256 payments, uint256 denials))",
];

// `allowance(address,address)` is mandatory here — it has bitten this repo
// repeatedly when omitted (see README "Traps").
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
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

function pickAgent() {
  if (process.env.AGENT_ADDRESS) return ethers.getAddress(process.env.AGENT_ADDRESS);
  try {
    const { agents } = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "agents.json"), "utf8"));
    const active = (agents || []).find((a) => a.active !== false);
    if (active) return ethers.getAddress(active.address);
  } catch { /* fall through */ }
  throw new Error(
    "No AGENT_ADDRESS given and no agent found in frontend/src/contracts/agents.json.\n" +
    "  Set AGENT_ADDRESS=0x… explicitly."
  );
}

async function main() {
  const chain = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "chain.json"), "utf8"));
  const deployment = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "deployment.json"), "utf8"));
  const agent = pickAgent();

  const ownerKey = process.env.DEPLOYER_PRIVATE_KEY || readEnvKey(CONTRACT_ENV, "DEPLOYER_PRIVATE_KEY");
  if (!ownerKey) throw new Error("No DEPLOYER_PRIVATE_KEY in env or contract/.env");

  const provider = new ethers.JsonRpcProvider(RPC);
  const owner = new ethers.Wallet(ownerKey, provider);
  const treasury = new ethers.Contract(deployment.address, TREASURY_ABI, owner);
  const musd = new ethers.Contract(chain.musd.address, ERC20_ABI, provider);

  const f = (w) => ethers.formatUnits(w, 18);
  const want = process.env.REFUND_MUSD ? ethers.parseUnits(process.env.REFUND_MUSD, 18) : ethers.parseUnits("2", 18);
  const skipFund = String(process.env.SKIP_FUND || "").toLowerCase() === "1" ||
                   String(process.env.SKIP_FUND || "").toLowerCase() === "true";

  log(`\n== Resume treasury ====================================================`);
  log(`  chain     ${chain.name} (${chain.chainId})`);
  log(`  treasury  ${deployment.address}`);
  log(`  agent     ${agent}`);
  log(`  owner     ${owner.address}`);
  log(`  MUSD      ${chain.musd.address}${chain.musd.isMock ? "  ⚠️ MOCK" : ""}`);

  const gas = await provider.getBalance(owner.address);
  log(`  owner gas ${f(gas)} ${chain.nativeCurrency.symbol}`);
  if (gas === 0n) throw new Error("Owner has no gas — nothing can be sent.");

  const registered = await treasury.isRegistered(agent);
  if (!registered) throw new Error(`Agent ${agent} is not registered on this treasury. Run setup-agent.js first.`);

  const before = await treasury.agentStatus(agent);
  const wasPaused = await treasury.paused();
  const treasuryBal = await musd.balanceOf(deployment.address);

  log(`\n  before    paused=${wasPaused}`);
  log(`            treasury holds ${f(treasuryBal)} MUSD`);
  log(`            agent holds    ${f(before.walletBalance)} MUSD`);
  log(`            limits         perCallMax=${f(before.perCallMax)} dailyCap=${f(before.dailyCap)}`);
  log(`            swept to date  ${f(before.lifetimeRecalled)} MUSD`);

  // --- 1. UNPAUSE (must come first: fundAgent is whenNotPaused) -----------
  if (wasPaused) {
    log(`\n  unpause()…`);
    const tx = await treasury.unpause();
    log(`  tx        ${tx.hash}`);
    await pollUntil("unpause", async () => (await treasury.paused()) === false);
    log(`  ✅ treasury unpaused on chain`);
  } else {
    log(`\n  treasury already unpaused — skipping unpause()`);
  }

  // --- 2. RESTORE THE FLOAT -----------------------------------------------
  if (skipFund) {
    log(`\n  SKIP_FUND set — not releasing any float`);
  } else {
    const held = await musd.balanceOf(agent);
    if (held >= want) {
      log(`\n  agent already holds ${f(held)} MUSD (>= ${f(want)}) — skipping fundAgent`);
    } else {
      const amount = want - held;
      const bal = await musd.balanceOf(deployment.address);
      if (bal < amount) {
        throw new Error(
          `Treasury holds ${f(bal)} MUSD but ${f(amount)} is needed to reach ${f(want)}.\n` +
          `  Top it up first: SEED_TREASURY_MUSD=${f(amount - bal)} npm --prefix contract run treasury:fund`
        );
      }
      log(`\n  fundAgent(${agent}, ${f(amount)})…`);
      const tx = await treasury.fundAgent(agent, amount);
      log(`  tx        ${tx.hash}`);
      await pollUntil("agent float", async () => (await musd.balanceOf(agent)) >= want);
      log(`  ✅ agent float restored on chain`);
    }
  }

  // --- 3. REPORT + the two allowances that silently break payments --------
  const after = await treasury.agentStatus(agent);
  const nowPaused = await treasury.paused();
  const permit2Allowance = await musd.allowance(agent, PERMIT2);
  const recallAllowance = await musd.allowance(agent, deployment.address);
  const MAX = 2n ** 256n - 1n;

  log(`\n  after     paused=${nowPaused}  active=${after.active}`);
  log(`            treasury holds ${f(await musd.balanceOf(deployment.address))} MUSD`);
  log(`            agent holds    ${f(after.walletBalance)} MUSD`);
  log(`            remainingToday ${f(after.remainingToday)} MUSD`);
  log(`            payments=${after.payments.toString()} denials=${after.denials.toString()}`);

  const ok = (v) => (v >= MAX / 2n ? "max ✅" : v > 0n ? `${f(v)} ⚠️ (finite)` : "ZERO ❌");
  log(`\n  permit2 allowance (agent → ${PERMIT2})  ${ok(permit2Allowance)}`);
  log(`  recall  allowance (agent → treasury)   ${ok(recallAllowance)}`);
  if (permit2Allowance === 0n) {
    log(`\n  ⚠️ Permit2 allowance is ZERO. Every payment will fail HTTP 412 with no MUSD`);
    log(`     moving, while /api/quote still says allowed:true. Fix with:`);
    log(`     AGENT_ADDRESS=${agent} npm --prefix contract run permit2:grant`);
  }
  log(``);
}

main().catch((err) => {
  console.error(`\n❌ resume failed:`, err.shortMessage || err.message || err);
  process.exitCode = 1;
});
