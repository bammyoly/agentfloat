// server/lib/agent-retrieve.js
//
// Move MUSD from a user's server side agent wallet back to THAT USER's own
// connected wallet.
//
// The one rule that matters: the destination is never an input. The caller
// passes ownerAddress, which the route takes from the verified session, not
// from the request body. A stolen or replayed request can therefore only ever
// move the agent's money to its rightful owner.
//
// Gas: the agent wallet is a plain EOA, so it pays BTC gas for the transfer
// (and for a vault withdrawal if the MUSD is sitting in the savings vault).

import { ethers } from "ethers";
import { getAgentPrivateKey } from "./wallet-factory.js";
import { ensureLiquidity } from "./savings-sweep.js";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const RECEIPT_WAIT_MS = 25_000;

// One retrieval per agent at a time. A double click must not send two transfers.
const inFlight = new Set();

export class RetrieveError extends Error {
  constructor(status, code, message, hint = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/**
 * @param {object} p
 * @param {string} p.agentAddress  the agent EOA (from the session)
 * @param {string} p.ownerAddress  the user's primary wallet (from the session)
 * @param {string} p.amount        decimal MUSD string, e.g. "125.5"
 * @param {string} p.rpcUrl
 * @param {number} p.chainId
 * @param {string} p.musdAddress
 * @param {Function} p.log
 */
export async function retrieveToOwner({
  agentAddress, ownerAddress, amount, rpcUrl, chainId, musdAddress, log = console.log,
}) {
  if (!ethers.isAddress(agentAddress) || !ethers.isAddress(ownerAddress)) {
    throw new RetrieveError(400, "bad_address", "session carries an invalid address");
  }
  const agent = ethers.getAddress(agentAddress);
  const owner = ethers.getAddress(ownerAddress);
  if (agent === owner) {
    throw new RetrieveError(400, "same_address", "agent and owner are the same address");
  }

  if (typeof amount !== "string" || !/^\d+(\.\d{1,18})?$/.test(amount.trim())) {
    throw new RetrieveError(400, "bad_amount", "amount must be a positive decimal number");
  }
  const amountWei = ethers.parseUnits(amount.trim(), 18);
  if (amountWei <= 0n) {
    throw new RetrieveError(400, "bad_amount", "amount must be greater than zero");
  }

  if (inFlight.has(agent)) {
    throw new RetrieveError(409, "in_flight", "a retrieval for this agent is already running");
  }
  inFlight.add(agent);

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl, chainId);

    // Decrypt the key for this one operation only.
    const wallet = new ethers.Wallet(await getAgentPrivateKey(agent), provider);
    if (wallet.address !== agent) {
      // Never sign with a key that does not belong to the address on the session.
      throw new RetrieveError(500, "key_mismatch", "stored key does not match the agent address");
    }

    const token = new ethers.Contract(musdAddress, ERC20_ABI, wallet);

    // Liquid MUSD first. If short, pull the difference out of the savings vault.
    let fromVault = false;
    let liquid = await token.balanceOf(agent);
    if (liquid < amountWei) {
      const liq = await ensureLiquidity(agent, Number(amount), rpcUrl, log);
      if (!liq?.sufficient) {
        throw new RetrieveError(
          409, "insufficient_funds",
          `not enough MUSD: ${liq?.error || "the agent wallet and savings vault together hold less than the amount requested"}`,
          "Check the agent's liquid and vault balances, and make sure it holds a little BTC for gas.",
        );
      }
      fromVault = true;
      liquid = await token.balanceOf(agent);
      if (liquid < amountWei) {
        throw new RetrieveError(
          409, "vault_short",
          "the vault withdrawal came up slightly short of the amount requested",
          "Try a marginally smaller amount.",
        );
      }
    }

    // The agent pays gas. Say so clearly instead of surfacing a raw RPC error.
    const gasBalance = await provider.getBalance(agent);
    if (gasBalance === 0n) {
      throw new RetrieveError(
        409, "no_gas",
        "the agent wallet holds no BTC to pay for the transfer",
        "Send a little BTC gas to the agent from the Operate page first.",
      );
    }

    let tx;
    try {
      tx = await token.transfer(owner, amountWei);
    } catch (e) {
      if (e?.code === "INSUFFICIENT_FUNDS") {
        throw new RetrieveError(
          409, "no_gas",
          "the agent wallet does not hold enough BTC to pay for the transfer",
          "Send a little more BTC gas to the agent from the Operate page.",
        );
      }
      throw e;
    }

    // Mezo's RPC can hang on tx.wait() long after confirmation, so wait with a bound.
    const rc = await Promise.race([
      tx.wait().catch(() => null),
      new Promise((r) => setTimeout(() => r(null), RECEIPT_WAIT_MS)),
    ]);
    const confirmed = Boolean(rc && rc.status === 1);
    if (rc && rc.status === 0) {
      throw new RetrieveError(502, "reverted", `the transfer reverted onchain (tx ${tx.hash})`);
    }

    log(`  [retrieve] ${agent.slice(0, 10)}… -> ${owner.slice(0, 10)}… ${amount} MUSD tx ${tx.hash}${fromVault ? " (from vault)" : ""}`);

    return {
      ok: true,
      txHash: tx.hash,
      confirmed,
      amount: amount.trim(),
      agent,
      to: owner,
      fromVault,
    };
  } finally {
    inFlight.delete(agent);
  }
}

