// ---------------------------------------------------------------------------
// AgentFloat — deploy script
//
//   ./node_modules/.bin/hardhat run scripts/deploy.js --network mezoTestnet
//   ./node_modules/.bin/hardhat run scripts/deploy.js                    # local dry run
//
// Deploys AgentFloatTreasury and writes everything the React app needs into
// ../frontend/src/contracts/ so the frontend imports chain config directly from
// the deployment rather than from hand-copied constants.
//
// PRE-FLIGHT: this script verifies the MUSD token on-chain before deploying.
// Mezo testnet has TWO tokens that both answer name()="Mezo USD",
// symbol()="MUSD", decimals()=18. Only one is in the x402 facilitator registry.
// Deploying a treasury bound to the wrong one produces a contract that looks
// functional and can never be paid through x402. See DEPLOYMENT-BRIEF.md §3.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers, network } = hre;

// --- Canonical Mezo values (verified live 2026-10-21) ----------------------
const MUSD = {
  31611: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503", // testnet — x402 settles in this
  31612: "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186", // mainnet
  31337: null,                                          // local: deploy MockMUSD
};

// The impostor. Hard-blocked so a bad env var cannot silently ship.
const MUSD_IMPOSTOR_TESTNET = "0xf9BBcCC0F1b68EA07c86de6F88C76b3d8E2dD0af";

const NETWORKS = {
  31611: {
    name: "Mezo Testnet",
    caip2: "eip155:31611",
    rpc: "https://rpc.test.mezo.org",
    explorer: "https://explorer.test.mezo.org",
    gasSymbol: "BTC",
    faucet: "https://faucet.test.mezo.org",
  },
  31612: {
    name: "Mezo Mainnet",
    caip2: "eip155:31612",
    rpc: "https://mezo-mainnet.boar.network",
    explorer: "https://explorer.mezo.org",
    gasSymbol: "BTC",
    faucet: null,
  },
  31337: {
    name: "Hardhat Local",
    caip2: "eip155:31337",
    rpc: "http://127.0.0.1:8545",
    explorer: null,
    gasSymbol: "ETH",
    faucet: null,
  },
};

// x402 plumbing the frontend needs even though it is not something we deploy.
const X402 = {
  facilitatorUrl: "https://facilitator.vativ.io",
  settlementProxy: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
  scheme: "exact",
  eip712Domain: { name: "Mezo USD", version: "1" },
  gasSponsoring: "eip2612GasSponsoring", // buyer signs a permit; facilitator pays gas
};

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
];

const OUT_DIR = path.resolve(__dirname, "..", "..", "frontend", "src", "contracts");

const log = (...a) => console.log(...a);
const fmt = (wei, dp = 4) => Number(ethers.formatUnits(wei, 18)).toFixed(dp);

async function verifyMusd(address) {
  const token = new ethers.Contract(address, ERC20_ABI, ethers.provider);
  const [name, symbol, decimals, supply] = await Promise.all([
    token.name(),
    token.symbol(),
    token.decimals(),
    token.totalSupply(),
  ]);
  log(`  address   ${address}`);
  log(`  name      "${name}"`);
  log(`  symbol    "${symbol}"`);
  log(`  decimals  ${decimals}`);
  log(`  supply    ${fmt(supply, 2)} ${symbol}`);

  if (name !== "Mezo USD" || symbol !== "MUSD" || Number(decimals) !== 18) {
    throw new Error(
      `MUSD metadata mismatch at ${address}: got name="${name}" symbol="${symbol}" decimals=${decimals}. ` +
      `Expected "Mezo USD"/"MUSD"/18. Refusing to deploy.`
    );
  }
  if (address.toLowerCase() === MUSD_IMPOSTOR_TESTNET.toLowerCase()) {
    throw new Error(
      `MUSD_MUSDT address ${address} is the SECOND testnet token also named MUSD. ` +
      `x402 does not settle in it. Use ${MUSD[31611]} instead.`
    );
  }
  return { name, symbol, decimals: Number(decimals), totalSupply: supply.toString() };
}

async function preflight(chainId, deployer) {
  const net = NETWORKS[chainId];
  log(`\n== Pre-flight =========================================================`);
  log(`  network   ${net.name} (chainId ${chainId}, ${net.caip2})`);
  log(`  deployer  ${deployer.address}`);

  const gasBal = await ethers.provider.getBalance(deployer.address);
  log(`  gas       ${fmt(gasBal, 8)} ${net.gasSymbol}`);

  if (chainId !== 31337) {
    if (gasBal === 0n) {
      throw new Error(
        `Deployer ${deployer.address} holds no ${net.gasSymbol} for gas. ` +
        (net.faucet
          ? `Drip testnet BTC from ${net.faucet} (or #testnet in Mezo Discord), then retry.`
          : `Fund the deployer before retrying.`)
      );
    }
    // Rough headroom: deploy + approve + deposit + a few policy txs.
    const needed = ethers.parseUnits("0.00002", 18);
    if (gasBal < needed) {
      log(`  WARN      gas balance is low; a deploy plus setup may run out.`);
    }
    const latest = await ethers.provider.getBlockNumber();
    log(`  block     ${latest}`);
  }

  if (chainId === 31612) {
    log(`\n  !! MAINNET DEPLOYMENT. Real MUSD. There is no undo.`);
    if (process.env.CONFIRM_MAINNET !== "yes") {
      throw new Error("Refusing to deploy to mainnet without CONFIRM_MAINNET=yes.");
    }
  }
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const net = NETWORKS[chainId];
  if (!net) throw new Error(`Unsupported chainId ${chainId}. Expected 31337, 31611 or 31612.`);

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer available. Set DEPLOYER_PRIVATE_KEY in contract/.env.");

  await preflight(chainId, deployer);

  // --- Resolve MUSD --------------------------------------------------------
  let musdAddress = process.env.MUSD_ADDRESS ? ethers.getAddress(process.env.MUSD_ADDRESS) : MUSD[chainId];
  let musdMeta;

  log(`\n== MUSD ===============================================================`);
  if (!musdAddress) {
    // Local run: deploy the mock so the frontend has something to read.
    log("  chainId 31337 — deploying MockMUSD (test-only token)");
    const Mock = await ethers.getContractFactory("MockMUSD");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();
    musdAddress = await mock.getAddress();
    await mock.faucet(deployer.address, 10_000n * ethers.parseUnits("1", 18));
    musdMeta = { name: "Mezo USD", symbol: "MUSD", decimals: 18, totalSupply: "0", mock: true };
    log(`  address   ${musdAddress} (MOCK — local only)`);
  } else {
    musdMeta = await verifyMusd(musdAddress);
  }

  const musd = new ethers.Contract(musdAddress, ERC20_ABI, deployer);
  const musdBal = await musd.balanceOf(deployer.address);
  log(`  deployer balance  ${fmt(musdBal)} ${musdMeta.symbol}`);

  // --- Deploy the treasury -------------------------------------------------
  log(`\n== Deploy =============================================================`);
  const owner = process.env.TREASURY_OWNER ? ethers.getAddress(process.env.TREASURY_OWNER) : deployer.address;
  log(`  contract  AgentFloatTreasury`);
  log(`  owner     ${owner}${owner === deployer.address ? " (deployer)" : ""}`);
  log(`  musd      ${musdAddress}`);

  const Treasury = await ethers.getContractFactory("AgentFloatTreasury");
  const treasury = await Treasury.deploy(musdAddress, owner);
  const deployTx = treasury.deploymentTransaction();
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();

  log(`\n  ✅ AgentFloatTreasury -> ${treasuryAddress}`);
  log(`     tx ${deployTx ? deployTx.hash : "(local)"}`);
  if (net.explorer) {
    log(`     ${net.explorer}/address/${treasuryAddress}`);
  }

  // Confirm what landed.
  const [onChainMusd, onChainOwner, paused, version] = await Promise.all([
    treasury.musd(),
    treasury.owner(),
    treasury.paused(),
    treasury.VERSION(),
  ]);
  if (onChainMusd.toLowerCase() !== musdAddress.toLowerCase()) throw new Error("musd mismatch post-deploy");
  if (onChainOwner.toLowerCase() !== owner.toLowerCase()) throw new Error("owner mismatch post-deploy");
  log(`     version ${version} | owner ${onChainOwner} | paused ${paused}`);

  const blockNumber = deployTx ? (await deployTx.wait()).blockNumber : await ethers.provider.getBlockNumber();

  // --- Seed the treasury if the deployer holds MUSD ------------------------
  const seedAmount = process.env.SEED_TREASURY_MUSD
    ? ethers.parseUnits(process.env.SEED_TREASURY_MUSD, 18)
    : 0n;

  let seeded = 0n;
  if (seedAmount > 0n) {
    if (musdBal < seedAmount) {
      log(`\n  SKIP seed: deployer holds ${fmt(musdBal)} but SEED_TREASURY_MUSD=${process.env.SEED_TREASURY_MUSD}`);
    } else if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
      log(`\n  SKIP seed: TREASURY_OWNER differs from deployer; let the owner deposit instead.`);
    } else {
      log(`\n== Seed treasury ======================================================`);
      const allowance = await musd.allowance(deployer.address, treasuryAddress);
      if (allowance < seedAmount) {
        const ap = await musd.approve(treasuryAddress, seedAmount);
        await ap.wait();
        log(`  approved  ${fmt(seedAmount)} MUSD`);
      }
      const dp = await treasury.deposit(seedAmount);
      await dp.wait();
      seeded = seedAmount;
      log(`  ✅ deposited ${fmt(seeded)} MUSD into the treasury`);
    }
  }

  // --- Export artifacts to the frontend ------------------------------------
  log(`\n== Export frontend artifacts ==========================================`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const artifact = await hre.artifacts.readArtifact("AgentFloatTreasury");

  const deployment = {
    contractName: "AgentFloatTreasury",
    address: treasuryAddress,
    deployTx: deployTx ? deployTx.hash : null,
    blockNumber,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    owner,
    version,
    chainId,
    network: net.name,
    seededMusd: seeded.toString(),
    solidity: {
      version: "0.8.28",
      evmVersion: "london",
      optimizer: { enabled: true, runs: 200 },
    },
  };

  const chainConfig = {
    chainId,
    chainIdHex: "0x" + chainId.toString(16),
    name: net.name,
    caip2: net.caip2,
    rpcUrl: net.rpc,
    explorerUrl: net.explorer,
    nativeCurrency: {
      name: net.gasSymbol,
      symbol: net.gasSymbol,
      decimals: 18,
    },
    faucetUrl: net.faucet,
    isTestnet: chainId !== 31612,
    musd: {
      address: musdAddress,
      name: musdMeta.name,
      symbol: musdMeta.symbol,
      decimals: musdMeta.decimals,
      isMock: !!musdMeta.mock,
    },
    x402: X402,
    // The vault is MAINNET ONLY — there is no sMUSD savings vault on testnet.
    // Kept here so the UI can render the yield panel as unavailable rather than
    // pretending. See DEPLOYMENT-BRIEF.md §2.
    savingsVault: {
      address: chainId === 31612 ? "0xb4D498029af77680cD1eF828b967f010d06C51CC" : null,
      receiptSymbol: "sMUSD",
      available: chainId === 31612,
      // NOTE: Mezo's vault is NOT ERC-4626. asset()/totalAssets()/pricePerShare()
      // all revert. The real interface is deposit(uint256)/withdraw(uint256)/token().
      isErc4626: false,
      note: chainId === 31612
        ? "Mainnet-only. Not ERC-4626 — integrate deposit(uint256)/withdraw(uint256)/token()."
        : "Not deployed on Mezo testnet. The sMUSD savings vault is mainnet-only.",
    },
  };

  const files = {
    "deployment.json": JSON.stringify(deployment, null, 2) + "\n",
    "chain.json": JSON.stringify(chainConfig, null, 2) + "\n",
    "AgentFloatTreasury.json": JSON.stringify(
      { contractName: artifact.contractName, abi: artifact.abi, address: treasuryAddress },
      null, 2
    ) + "\n",
    "MUSD.json": JSON.stringify(
      { contractName: musdMeta.mock ? "MockMUSD" : "MUSD", abi: ERC20_ABI, address: musdAddress },
      null, 2
    ) + "\n",
    // Written empty here; scripts/setup-agent.js appends registered agents.
    "agents.json": fs.existsSync(path.join(OUT_DIR, "agents.json"))
      ? fs.readFileSync(path.join(OUT_DIR, "agents.json"), "utf8")
      : JSON.stringify({ agents: [] }, null, 2) + "\n",
  };

  // Barrel module: one import gives the React app everything.
  files["index.js"] = `// ---------------------------------------------------------------------------
// AUTO-GENERATED by contract/scripts/deploy.js — do not edit by hand.
// Re-run the deploy script to refresh. Generated ${deployment.deployedAt}
// ---------------------------------------------------------------------------
import deployment from "./deployment.json";
import chain from "./chain.json";
import treasuryArtifact from "./AgentFloatTreasury.json";
import musdArtifact from "./MUSD.json";
import agentsFile from "./agents.json";

export const DEPLOYMENT = deployment;
export const CHAIN = chain;
export const X402 = chain.x402;
export const MUSD = chain.musd;
export const SAVINGS_VAULT = chain.savingsVault;

export const TREASURY_ADDRESS = deployment.address;
export const TREASURY_ABI = treasuryArtifact.abi;
export const TREASURY_OWNER = deployment.owner;

export const MUSD_ADDRESS = chain.musd.address;
export const ERC20_ABI = musdArtifact.abi;

export const AGENTS = agentsFile.agents;
export const PRIMARY_AGENT = agentsFile.agents[0] || null;

export const CHAIN_ID = chain.chainId;
export const RPC_URL = chain.rpcUrl;
export const EXPLORER_URL = chain.explorerUrl;

/** True once scripts/deploy.js has written a real address. */
export const IS_DEPLOYED = Boolean(deployment.address && !deployment._placeholder);

/** EIP-3085 params so the UI can offer "Add Mezo Testnet" in one click. */
export const ADD_CHAIN_PARAMS = {
  chainId: chain.chainIdHex,
  chainName: chain.name,
  nativeCurrency: chain.nativeCurrency,
  rpcUrls: [chain.rpcUrl],
  blockExplorerUrls: chain.explorerUrl ? [chain.explorerUrl] : undefined,
};

export function explorerTx(hash) {
  return chain.explorerUrl ? \`\${chain.explorerUrl}/tx/\${hash}\` : null;
}
export function explorerAddress(addr) {
  return chain.explorerUrl ? \`\${chain.explorerUrl}/address/\${addr}\` : null;
}
export function explorerToken(addr) {
  return chain.explorerUrl ? \`\${chain.explorerUrl}/token/\${addr}\` : null;
}

export default {
  DEPLOYMENT, CHAIN, X402, MUSD, SAVINGS_VAULT,
  TREASURY_ADDRESS, TREASURY_ABI, TREASURY_OWNER,
  MUSD_ADDRESS, ERC20_ABI, AGENTS, PRIMARY_AGENT,
  CHAIN_ID, RPC_URL, EXPLORER_URL, ADD_CHAIN_PARAMS, IS_DEPLOYED,
  explorerTx, explorerAddress, explorerToken,
};
`;

  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT_DIR, name), contents);
    log(`  wrote frontend/src/contracts/${name}  (${contents.length} bytes)`);
  }

  log(`\n== Summary ============================================================`);
  log(`  Treasury  ${treasuryAddress}`);
  log(`  MUSD      ${musdAddress} (${musdMeta.symbol}, ${musdMeta.decimals} decimals${musdMeta.mock ? ", MOCK" : ""})`);
  log(`  Owner     ${owner}`);
  log(`  Chain     ${net.name} (${chainId})`);
  log(`  Seeded    ${fmt(seeded)} MUSD`);
  log(`  Artifacts ${OUT_DIR}`);

  log(`\n== Next steps =========================================================`);
  log(`  1. Seed the treasury with MUSD:`);
  log(`       SEED_TREASURY_MUSD=100 ./node_modules/.bin/hardhat run scripts/fund-treasury.js --network ${network.name}`);
  log(`  2. Create + register an agent wallet:`);
  log(`       ./node_modules/.bin/hardhat run scripts/setup-agent.js --network ${network.name}`);
  log(`  3. Start the app:`);
  log(`       cd ../frontend && npm install && npm run dev`);
  if (chainId !== 31337) {
    log(`\n  NOTE: MUSD on testnet is minted, not faucet-dispensed. Drip testnet BTC`);
    log(`        from ${net.faucet}, then borrow MUSD at https://mezo.org/feature/borrow.`);
  }
  log(``);
}

main().catch((err) => {
  console.error("\n❌ Deploy failed:", err.message || err);
  process.exitCode = 1;
});
