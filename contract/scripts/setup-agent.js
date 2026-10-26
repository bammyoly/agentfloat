// ---------------------------------------------------------------------------
// AgentFloat — create and register an agent wallet
//
//   ./node_modules/.bin/hardhat run scripts/setup-agent.js --network mezoTestnet
//
// Generates a fresh EOA for the agent (the LLM never sees the operator's key),
// registers it in the treasury with a spending policy, optionally funds it, and
// appends it to frontend/src/contracts/agents.json.
//
// WHY THE AGENT IS AN EOA AND NOT A CONTRACT
//   x402 payments on Mezo are authorised by an EIP-712 permit2 signature. A
//   contract cannot produce one. So the paying wallet must be an EOA, and the
//   treasury enforces the cap on how much that EOA is ever given.
//
// THE ONE GAS COST
//   x402 payments are gasless for the buyer (the facilitator sponsors them).
//   But `recallFromAgent` / `emergencyStop` need an ERC-20 allowance FROM the
//   agent TO the treasury, and granting one is a normal tx that needs gas.
//   So this script sends a tiny amount of BTC dust to the agent wallet and uses
//   it for that single approval. Skip with --no-approve if you want the agent
//   wallet to hold literally zero BTC (you then lose the on-chain kill switch
//   and are left with pause + the off-chain gateway refusing to sign).
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const OUT_DIR = path.resolve(__dirname, "..", "..", "frontend", "src", "contracts");
const TREASURY_JSON = path.join(OUT_DIR, "deployment.json");
const AGENTS_JSON = path.join(OUT_DIR, "agents.json");
const GATEWAY_ENV = path.resolve(__dirname, "..", "..", "server", ".env");

/** Read one KEY out of a dotenv file, or null. Never throws when absent. */
function readEnvKey(file, key) {
  try {
    const m = fs.readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}
const CHAIN_JSON = path.join(OUT_DIR, "chain.json");

const log = (...a) => console.log(...a);
const fmt = (wei, dp = 4) => Number(ethers.formatUnits(wei, 18)).toFixed(dp);

// Defaults — override via env.
const PER_CALL_MAX = process.env.AGENT_PER_CALL_MAX || "2";   // MUSD
const DAILY_CAP = process.env.AGENT_DAILY_CAP || "20";        // MUSD
const INITIAL_FLOAT = process.env.AGENT_INITIAL_FLOAT || "5"; // MUSD
const DUST_BTC = process.env.AGENT_DUST_BTC || "0.00001";     // for the one approval tx

async function main() {
  if (!fs.existsSync(TREASURY_JSON)) {
    throw new Error(`No deployment found at ${TREASURY_JSON}. Run scripts/deploy.js first.`);
  }
  const deployment = JSON.parse(fs.readFileSync(TREASURY_JSON, "utf8"));
  const chain = JSON.parse(fs.readFileSync(CHAIN_JSON, "utf8"));

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== deployment.chainId) {
    throw new Error(`Connected to chainId ${chainId} but the deployment is on ${deployment.chainId}.`);
  }

  const [deployer] = await ethers.getSigners();
  const treasury = await ethers.getContractAt("AgentFloatTreasury", deployment.address);
  const musd = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)",
     "function allowance(address,address) view returns (uint256)", "function decimals() view returns (uint8)"],
    chain.musd.address
  );

  // --- Generate (or reuse) the agent wallet --------------------------------
  // Reuse matters. This script writes the agent key into the gateway .env, so
  // re-running it after a fresh `createRandom()` silently ORPHANS the funded
  // agent and registers a second one under the same label. Prefer, in order:
  // an explicit env key, then the key already in the gateway .env, then a new
  // wallet only if neither exists.
  let agent;
  const envKey = process.env.AGENT_PRIVATE_KEY || readEnvKey(GATEWAY_ENV, "AGENT_PRIVATE_KEY");
  if (envKey) {
    agent = new ethers.Wallet(envKey, ethers.provider);
    log(`\n== Agent wallet (reused) ==============================================`);
    log(`  source    ${process.env.AGENT_PRIVATE_KEY ? "AGENT_PRIVATE_KEY (env)" : "frontend/server/.env"}`);
  } else {
    agent = ethers.Wallet.createRandom().connect(ethers.provider);
    log(`\n== Agent wallet (newly generated) =====================================`);
  }
  log(`  address   ${agent.address}`);

  const perCallMax = ethers.parseUnits(PER_CALL_MAX, 18);
  const dailyCap = ethers.parseUnits(DAILY_CAP, 18);
  const initialFloat = ethers.parseUnits(INITIAL_FLOAT, 18);

  // --- Register in the treasury -------------------------------------------
  log(`\n== Register =============================================================`);
  const already = await treasury.isRegistered(agent.address);
  if (already) {
    // Only send setAgentLimits if something actually differs. Besides saving a
    // tx, this avoids blocking on tx.wait() — which on the Mezo testnet RPC can
    // hang for minutes after the transaction has already confirmed, making the
    // script look frozen (it did, and the rest of the setup never ran).
    const cur = await treasury.agentStatus(agent.address);
    if (cur.perCallMax === perCallMax && cur.dailyCap === dailyCap) {
      log(`  already registered — limits already ${PER_CALL_MAX}/${DAILY_CAP} MUSD, no tx needed`);
    } else {
      log(`  already registered — updating limits ${ethers.formatUnits(cur.perCallMax, 18)}/${ethers.formatUnits(cur.dailyCap, 18)} -> ${PER_CALL_MAX}/${DAILY_CAP}`);
      const tx = await treasury.connect(deployer).setAgentLimits(agent.address, perCallMax, dailyCap);
      log(`  tx        ${tx.hash}`);
      await tx.wait();
    }
  } else {
    // The gateway address is authorised to write payment receipts on chain.
    // For the demo the deployer doubles as gateway; in production set
    // AGENT_GATEWAY to the gateway service's own key address.
    const gateway = process.env.AGENT_GATEWAY
      ? ethers.getAddress(process.env.AGENT_GATEWAY)
      : deployer.address;
    const tx = await treasury.connect(deployer).registerAgent(agent.address, gateway, perCallMax, dailyCap);
    await tx.wait();
    log(`  ✅ registered`);
    log(`  gateway   ${gateway}`);
    log(`  tx        ${tx.hash}`);
  }
  log(`  perCallMax ${PER_CALL_MAX} MUSD`);
  log(`  dailyCap   ${DAILY_CAP} MUSD`);

  // --- Optional: grant the treasury an allowance so the kill switch works ---
  // Hardhat parses and REJECTS unknown CLI flags before the script ever sees
  // them (error HH305), so `--no-approve` in argv can never work under Hardhat.
  // Kept for direct `node` runs; the supported switch is NO_APPROVE=1.
  const wantApprove = !process.argv.includes("--no-approve") && !process.env.NO_APPROVE;
  // --- Approvals the agent wallet must grant -------------------------------
  // TWO distinct allowances, easily confused, and BOTH are required:
  //   1. Permit2  <- MUSD   lets the x402 facilitator PULL each payment. Without
  //                         it the facilitator rejects with HTTP 412 and no MUSD
  //                         moves at all.
  //   2. Treasury <- MUSD   lets the owner RECALL unspent float (the kill switch).
  // The agent signs these, so it needs gas dust — but only for these two. Every
  // x402 payment stays gasless because the facilitator sponsors it in BTC.
  const PERMIT2 = ethers.getAddress(
    process.env.PERMIT2_ADDRESS || "0x000000000022D473030F116dDEE9F6B43aC78BA3"
  );
  const grants = [
    { key: "permit2", label: "Permit2 (x402 spend)", spender: PERMIT2 },
    { key: "recall", label: "treasury (recall)", spender: deployment.address },
  ];

  let approved = 0n;
  let permit2Approved = 0n;
  const setApproved = (g, v) => { if (g.key === "permit2") permit2Approved = v; else approved = v; };

  if (!wantApprove) {
    log(`\n== Agent approvals: SKIPPED (NO_APPROVE=1) ==============================`);
    log(`  x402 payments will FAIL with HTTP 412 — no Permit2 allowance.`);
    log(`  emergencyStop will pause but cannot sweep this agent's wallet.`);
  } else {
    log(`\n== Agent approvals ======================================================`);
    const missing = [];
    for (const g of grants) {
      const have = await musd.allowance(agent.address, g.spender);
      if (have === ethers.MaxUint256) {
        setApproved(g, have);
        log(`  ok   ${g.label.padEnd(24)} already max — skipping`);
      } else {
        log(`  todo ${g.label.padEnd(24)} needs granting`);
        missing.push(g);
      }
    }

    if (missing.length) {
      // Size the dust from LIVE fee data instead of hardcoding it. A fixed
      // 0.00001 is too small on chains with a higher base fee (Hardhat local
      // needs ~0.000084 for one ERC-20 approve), and Mezo prices gas in BTC.
      const gasBal = await ethers.provider.getBalance(agent.address);
      const feeData = await ethers.provider.getFeeData();
      const gasPrice = feeData.gasPrice
        || ((feeData.maxFeePerGas || 0n) + (feeData.maxPriorityFeePerGas || 0n));
      if (!gasPrice || gasPrice === 0n) {
        throw new Error("Could not read gas price from the RPC; cannot size the dust transfer.");
      }

      let gasLimit;
      try {
        gasLimit = await musd.connect(agent).approve.estimateGas(missing[0].spender, ethers.MaxUint256);
      } catch {
        gasLimit = 100_000n; // generous fallback for a standard ERC-20 approve
      }

      const perTx = gasLimit * gasPrice;
      const floor = ethers.parseEther(DUST_BTC);
      const need = perTx * BigInt(missing.length) * 2n; // 2x headroom, every missing tx
      const dust = need > floor ? need : floor;

      log(`  gas estimate  ${gasLimit} units/tx @ ${ethers.formatUnits(gasPrice, "gwei")} gwei, ${missing.length} tx(s)`);
      log(`  dust to send  ${fmt(dust, 10)} ${chain.nativeCurrency.symbol} (2x headroom, floor ${DUST_BTC})`);

      if (gasBal < dust) {
        log(`  sending dust to the agent wallet for its approval tx(s)`);
        const s = await deployer.sendTransaction({ to: agent.address, value: dust });
        await s.wait();
      } else {
        log(`  agent already holds enough gas (${fmt(gasBal, 10)})`);
      }

      for (const g of missing) {
        const ap = await musd.connect(agent).approve(g.spender, ethers.MaxUint256);
        await ap.wait();
        setApproved(g, await musd.allowance(agent.address, g.spender));
        log(`  ok   ${g.label.padEnd(24)} granted  (tx ${ap.hash})`);
      }
      log(`  note  these are the ONLY txs the agent wallet pays gas for. All x402`);
      log(`        payments remain gasless — the facilitator sponsors them.`);
    }
  }

  // --- Optionally release the initial float --------------------------------
  let funded = 0n;
  const treasuryBal = await musd.balanceOf(deployment.address);
  log(`\n== Initial float ========================================================`);
  log(`  treasury holds ${fmt(treasuryBal)} MUSD`);
  if (initialFloat > 0n && treasuryBal >= initialFloat && initialFloat <= perCallMax) {
    const f = await treasury.connect(deployer).fundAgent(agent.address, initialFloat);
    await f.wait();
    funded = initialFloat;
    log(`  ✅ released ${fmt(funded)} MUSD to the agent wallet`);
    log(`  tx        ${f.hash}`);
  } else if (initialFloat > 0n) {
    log(`  SKIP — could not release ${INITIAL_FLOAT} MUSD:`);
    if (initialFloat > perCallMax) {
      log(`        AGENT_INITIAL_FLOAT (${fmt(initialFloat)}) is above the per-call max (${fmt(perCallMax)}).`);
      log(`        The contract enforces that cap on every release, so raise the cap or lower the float:`);
      log(`          AGENT_PER_CALL_MAX=${INITIAL_FLOAT} AGENT_INITIAL_FLOAT=${INITIAL_FLOAT} ./node_modules/.bin/hardhat run scripts/setup-agent.js --network ${network.name}`);
    }
    if (treasuryBal < initialFloat) {
      log(`        Treasury holds only ${fmt(treasuryBal)} MUSD.`);
      log(`        Seed it: SEED_TREASURY_MUSD=${INITIAL_FLOAT} ./node_modules/.bin/hardhat run scripts/fund-treasury.js --network ${network.name}`);
    }
    log(`        The agent is registered and can be funded later from the dashboard.`);
  }

  const agentBal = await musd.balanceOf(agent.address);
  log(`\n  agent MUSD balance   ${fmt(agentBal)}`);
  log(`  agent gas balance    ${fmt(await ethers.provider.getBalance(agent.address), 8)} ${chain.nativeCurrency.symbol}`);

  // --- Persist for the frontend + gateway ----------------------------------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const agentsFile = fs.existsSync(AGENTS_JSON) ? JSON.parse(fs.readFileSync(AGENTS_JSON, "utf8")) : { agents: [] };
  const record = {
    address: agent.address,
    label: process.env.AGENT_LABEL || `agent-${agentsFile.agents.length + 1}`,
    // Strings, not BigInts: JSON.stringify cannot serialise BigInt.
    perCallMax: perCallMax.toString(),
    dailyCap: dailyCap.toString(),
    registeredAt: new Date().toISOString(),
    chainId,
    // Report what is ACTUALLY on chain, not what was requested — these two
    // flags drive the dashboard's "can this agent pay / be recalled" warnings.
    permit2Address: PERMIT2,
    permit2AllowanceGranted: permit2Approved === ethers.MaxUint256,
    permit2Allowance: permit2Approved.toString(),
    recallAllowanceGranted: approved === ethers.MaxUint256,
    recallAllowance: approved.toString(),
  };
  const idx = agentsFile.agents.findIndex((a) => a.address.toLowerCase() === agent.address.toLowerCase());
  if (idx >= 0) agentsFile.agents[idx] = { ...agentsFile.agents[idx], ...record };
  else agentsFile.agents.push(record);
  fs.writeFileSync(AGENTS_JSON, JSON.stringify(agentsFile, null, 2) + "\n");
  log(`\n  wrote frontend/src/contracts/agents.json (${agentsFile.agents.length} agent(s))`);

  // --- The private key goes to the GATEWAY env, never to the frontend ------
  fs.mkdirSync(path.dirname(GATEWAY_ENV), { recursive: true });
  const managed = {
    AGENT_PRIVATE_KEY: agent.privateKey,
    AGENT_WALLET_ADDRESS: agent.address,
    TREASURY_ADDRESS: deployment.address,
    GATEWAY_SIGNER_ADDRESS: deployer.address,
  };
  // MERGE, don't clobber. This file also carries keys this script does not own
  // (notably GATEWAY_SIGNER_PRIVATE_KEY, which enables on-chain receipts); a
  // plain overwrite silently disabled them on every re-run.
  const preserved = [];
  try {
    for (const raw of fs.readFileSync(GATEWAY_ENV, "utf8").split(/\r?\n/)) {
      const m = raw.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (!m) continue;
      if (m[1] in managed) continue; // refreshed below
      preserved.push([m[1], m[2]]);
    }
  } catch {
    /* first run — nothing to preserve */
  }
  const body = Object.entries(managed).map(([k, v]) => `${k}=${v}`).join("\n");
  const extra = preserved.map(([k, v]) => `${k}=${v}`).join("\n");
  fs.writeFileSync(GATEWAY_ENV, body + "\n" + (extra ? "\n" + extra + "\n" : ""));
  log(`  wrote frontend/server/.env  (agent key — NEVER ship this to the browser)`);
  if (preserved.length) {
    log(`  preserved ${preserved.length} key(s) this script does not own: ${preserved.map(([k]) => k).join(", ")}`);
  }

  log(`\n== IMPORTANT ============================================================`);
  log(`  The agent private key is printed below ONCE so you can copy it elsewhere.`);
  log(`  It is stored in frontend/server/.env for the gateway only. The React app`);
  log(`  never receives it — the browser talks to the gateway, the gateway signs.`);
  log(``);
  log(`  AGENT_PRIVATE_KEY=${agent.privateKey}`);
  log(`  AGENT_WALLET_ADDRESS=${agent.address}`);
  log(``);
  log(`  Start the gateway with:  cd ../frontend && npm run gateway`);
  log(``);
}

main().catch((err) => {
  console.error("\n❌ setup-agent failed:", err.message || err);
  process.exitCode = 1;
});
