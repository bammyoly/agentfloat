// ---------------------------------------------------------------------------
// AgentFloat — grant the Permit2 allowance an x402 agent needs
//
//   node scripts/grant-permit2.js
//
// WHY THIS EXISTS
//   x402 on Mezo settles with `assetTransferMethod: permit2`. For the
//   facilitator to PULL MUSD out of the agent wallet, the agent must first
//   approve the canonical Permit2 contract to spend its MUSD. That is a
//   DIFFERENT allowance from the one the treasury needs to recall unspent
//   float. Missing it does not fail loudly at quote time — the quote decodes
//   perfectly and the policy engine allows the payment, then the facilitator
//   rejects settlement with HTTP 412 and no MUSD moves.
//
//   This is a standalone repair tool: it reads the agent key the gateway
//   already uses, so it can fix a wallet that setup-agent.js registered before
//   Permit2 granting existed.
//
// NOTE ON tx.wait()
//   On Mezo testnet `tx.wait()` can hang for minutes after the transaction has
//   already confirmed. So this script sends the approval and then POLLS the
//   on-chain allowance until it actually changes. The chain is the source of
//   truth, not the receipt promise.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "https://rpc.test.mezo.org";
// Canonical Permit2 — same address on every EVM chain it is deployed to.
const PERMIT2 = ethers.getAddress(
  process.env.PERMIT2_ADDRESS || "0x000000000022D473030F116dDEE9F6B43aC78BA3"
);
const GATEWAY_ENV = path.resolve(__dirname, "..", "..", "server", ".env");
const CHAIN_JSON = path.resolve(__dirname, "..", "..", "frontend", "src", "contracts", "chain.json");

const log = (...a) => console.log(...a);

function readEnvKey(file, key) {
  const m = fs.readFileSync(file, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

const ERC20 = [
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
];

async function main() {
  const chain = JSON.parse(fs.readFileSync(CHAIN_JSON, "utf8"));
  const musdAddress = ethers.getAddress(chain.musd.address);

  const key = process.env.AGENT_PRIVATE_KEY || readEnvKey(GATEWAY_ENV, "AGENT_PRIVATE_KEY");
  if (!key) throw new Error(`No AGENT_PRIVATE_KEY in env or ${GATEWAY_ENV}`);

  const provider = new ethers.JsonRpcProvider(RPC);
  const agent = new ethers.Wallet(key, provider);
  const musd = new ethers.Contract(musdAddress, ERC20, agent);

  log(`\n== Grant Permit2 allowance =============================================`);
  log(`  agent     ${agent.address}`);
  log(`  token     ${musdAddress} (${await musd.symbol()})`);
  log(`  Permit2   ${PERMIT2}`);

  // Permit2 must actually exist on this chain, or the approval is pointless.
  const code = await provider.getCode(PERMIT2);
  if (!code || code === "0x") {
    throw new Error(`Permit2 is NOT deployed at ${PERMIT2} on this chain — cannot proceed.`);
  }
  log(`  Permit2 bytecode present (${(code.length - 2) / 2} bytes)`);

  const existing = await musd.allowance(agent.address, PERMIT2);
  if (existing === ethers.MaxUint256) {
    log(`\n  ✅ already max — nothing to do`);
    return;
  }
  log(`  current allowance  ${ethers.formatUnits(existing, 18)}`);

  const gasBal = await provider.getBalance(agent.address);
  log(`  agent gas balance  ${ethers.formatUnits(gasBal, 18)} ${chain.nativeCurrency.symbol}`);
  if (gasBal === 0n) {
    throw new Error(
      `Agent wallet has no ${chain.nativeCurrency.symbol} for gas. This is the ONE tx the\n` +
      `  agent must pay for itself (x402 payments stay gasless). Fund it from the faucet\n` +
      `  or re-run setup-agent.js, which sends the dust automatically.`
    );
  }

  log(`\n  sending approve(Permit2, max)…`);
  const tx = await musd.approve(PERMIT2, ethers.MaxUint256);
  log(`  tx        ${tx.hash}`);
  if (chain.explorerUrl) log(`  explorer  ${chain.explorerUrl}/tx/${tx.hash}`);

  // Poll the allowance rather than trusting tx.wait(), which hangs on this RPC.
  log(`  waiting for the allowance to change on chain…`);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const now = await musd.allowance(agent.address, PERMIT2);
    if (now === ethers.MaxUint256) {
      log(`\n  ✅ Permit2 allowance granted (verified by reading the chain)`);
      log(`     agent MUSD balance ${ethers.formatUnits(await musd.balanceOf(agent.address), 18)}`);
      log(`     x402 payments can now settle.`);
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(
    `Allowance did not change within 180s. Tx ${tx.hash} may still be pending;\n` +
    `  check ${chain.explorerUrl}/tx/${tx.hash} and re-run — this script is idempotent.`
  );
}

main()
  .then(() => log(``))
  .catch((err) => {
    console.error(`\n❌ grant-permit2 failed:`, err.shortMessage || err.message || err);
    process.exitCode = 1;
  });
