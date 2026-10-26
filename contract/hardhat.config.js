require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("dotenv").config();

// ---------------------------------------------------------------------------
// AgentFloat — Hardhat config
//
// Mezo specifics (from mezo.org/docs, verified live on 2026-10-21):
//   * Testnet chain id 31611, RPC https://rpc.test.mezo.org
//   * Native gas token is BTC (18 decimals) — NOT ETH. Prices are tiny but the
//     deployer key must hold some BTC or every tx fails.
//   * solc 0.8.28 with evmVersion "london" is what Mezo documents. Do NOT let
//     this drift to a newer EVM target: newer targets emit PUSH0/Cancun
//     opcodes that a non-Ethereum L1 may not accept.
//
// Deliberately CommonJS: Hardhat is pinned to v2 (v3 is ESM + different config).
// ---------------------------------------------------------------------------

const TESTNET_RPC = process.env.MEZO_TESTNET_RPC || "https://rpc.test.mezo.org";
const MAINNET_RPC = process.env.MEZO_MAINNET_RPC || "https://mezo-mainnet.boar.network";
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

// Fail loudly rather than deploying from the zero key.
const accounts = PRIVATE_KEY && PRIVATE_KEY.startsWith("0x") && PRIVATE_KEY.length === 66
  ? [PRIVATE_KEY]
  : [];

if (!accounts.length && process.env.HARDHAT_NETWORK === "mezoTestnet") {
  console.error(
    "\n[agentfloat] DEPLOYER_PRIVATE_KEY is missing or malformed in contract/.env.\n" +
    "             Expected a 66-char 0x-prefixed hex key (32 bytes).\n"
  );
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "london",
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    mezoTestnet: {
      url: TESTNET_RPC,
      chainId: 31611,
      accounts,
      // Mezo gas estimation needs modest headroom (per Mezo's own troubleshooting
      // notes). Without this, deploys can fail estimation intermittently.
      gasMultiplier: 1.2,
      timeout: 120000,
    },
    mezoMainnet: {
      url: MAINNET_RPC,
      chainId: 31612,
      accounts,
      gasMultiplier: 1.2,
      timeout: 120000,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: { timeout: 120000 },
};
