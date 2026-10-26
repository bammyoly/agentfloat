// ---------------------------------------------------------------------------
// AgentFloat — seed the treasury with MUSD
//
//   SEED_TREASURY_MUSD=100 ./node_modules/.bin/hardhat run scripts/fund-treasury.js --network mezoTestnet
//
// Approves the treasury and deposits MUSD from the deployer/owner wallet.
// Idempotent: tops the allowance up only if needed.
//
// MUSD on Mezo testnet is MINTED, NOT FAUCET-DISPENSED. If the deployer holds no
// MUSD: drip testnet BTC from https://faucet.test.mezo.org, then borrow MUSD
// against it at https://mezo.org/feature/borrow with the wallet on Mezo Testnet.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const OUT_DIR = path.resolve(__dirname, "..", "..", "frontend", "src", "contracts");
const log = (...a) => console.log(...a);
const fmt = (wei, dp = 4) => Number(ethers.formatUnits(wei, 18)).toFixed(dp);

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const deploymentPath = path.join(OUT_DIR, "deployment.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No deployment found. Run scripts/deploy.js first.`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const chain = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "chain.json"), "utf8"));

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== deployment.chainId) {
    throw new Error(`Connected to chainId ${chainId}, deployment is on ${deployment.chainId}.`);
  }

  const amount = process.env.SEED_TREASURY_MUSD
    ? ethers.parseUnits(process.env.SEED_TREASURY_MUSD, 18)
    : ethers.parseUnits("100", 18);

  const [signer] = await ethers.getSigners();
  const musd = await ethers.getContractAt(ERC20, chain.musd.address);
  const treasury = await ethers.getContractAt("AgentFloatTreasury", deployment.address);

  const symbol = await musd.symbol();
  const balance = await musd.balanceOf(signer.address);
  const gasBal = await ethers.provider.getBalance(signer.address);

  log(`\n== Fund treasury ========================================================`);
  log(`  treasury  ${deployment.address}`);
  log(`  token     ${chain.musd.address} (${symbol})`);
  log(`  signer    ${signer.address}`);
  log(`  signer ${symbol} balance   ${fmt(balance)}`);
  log(`  signer gas balance  ${fmt(gasBal, 8)} ${chain.nativeCurrency.symbol}`);
  log(`  requested deposit   ${fmt(amount)}`);

  if (balance < amount) {
    throw new Error(
      `Signer holds ${fmt(balance)} ${symbol} but you asked to deposit ${fmt(amount)}.\n` +
      `  On Mezo testnet MUSD is minted by borrowing against testnet BTC:\n` +
      `    1. Drip BTC:      ${chain.faucetUrl || "https://faucet.test.mezo.org"}\n` +
      `    2. Borrow MUSD:   https://mezo.org/feature/borrow  (wallet on Mezo Testnet)\n` +
      `  Or lower the amount: SEED_TREASURY_MUSD=${fmt(balance, 0)} ./node_modules/.bin/hardhat run scripts/fund-treasury.js --network ${chain.name}`
    );
  }
  if (gasBal === 0n) {
    throw new Error(`Signer has no ${chain.nativeCurrency.symbol} for gas. Use the faucet first.`);
  }
  if (signer.address.toLowerCase() !== deployment.owner.toLowerCase()) {
    log(`  WARN  signer is not the treasury owner (${deployment.owner}).`);
    log(`        Anyone may deposit, but only the owner can release funds to agents.`);
  }

  const allowance = await musd.allowance(signer.address, deployment.address);
  if (allowance < amount) {
    const ap = await musd.connect(signer).approve(deployment.address, amount);
    await ap.wait();
    log(`  ✅ approved ${fmt(amount)} ${symbol}  (tx ${ap.hash})`);
  } else {
    log(`  allowance already sufficient (${fmt(allowance)})`);
  }

  const before = await treasury.treasuryBalance();
  const dp = await treasury.connect(signer).deposit(amount);
  await dp.wait();
  const after = await treasury.treasuryBalance();

  log(`\n  ✅ deposited ${fmt(amount)} ${symbol}`);
  log(`     tx        ${dp.hash}`);
  if (chain.explorerUrl) log(`     ${chain.explorerUrl}/tx/${dp.hash}`);
  log(`     treasury balance  ${fmt(before)} -> ${fmt(after)} ${symbol}`);
  log(``);
}

main().catch((err) => {
  console.error("\n❌ fund-treasury failed:", err.message || err);
  process.exitCode = 1;
});
