// ---------------------------------------------------------------------------
// Chain access for the dashboard.
//
// Two providers, deliberately separate:
//   * readProvider  — plain JsonRpcProvider straight at Mezo's public RPC.
//                     Mezo sends `access-control-allow-origin: *`, verified, so
//                     the browser can read balances and policy with no backend
//                     and no wallet connected.
//   * walletProvider — the operator's injected browser wallet (MetaMask). Used
//                     ONLY for writes (fund / pause / set limits), because those
//                     need the treasury OWNER key. The agent key is never here;
//                     it lives in the gateway process.
// ---------------------------------------------------------------------------

import { ethers } from "ethers";
import {
  CHAIN, CHAIN_ID, RPC_URL, ADD_CHAIN_PARAMS,
  TREASURY_ADDRESS, TREASURY_ABI,
  MUSD_ADDRESS, ERC20_ABI,
  IS_DEPLOYED, explorerTx, explorerAddress,
} from "../contracts/index.js";

let _readProvider = null;

export function readProvider() {
  if (!_readProvider) {
    _readProvider = new ethers.JsonRpcProvider(RPC_URL, Number(CHAIN_ID), {
      staticNetwork: true,
      batchMaxCount: 10,
    });
  }
  return _readProvider;
}

export function treasuryRead() {
  if (!IS_DEPLOYED) return null;
  return new ethers.Contract(TREASURY_ADDRESS, TREASURY_ABI, readProvider());
}

export function musdRead() {
  return new ethers.Contract(MUSD_ADDRESS, ERC20_ABI, readProvider());
}

// --- formatting ------------------------------------------------------------
export function fmtMusd(wei, dp = 4) {
  if (wei === null || wei === undefined) return "—";
  try {
    return Number(ethers.formatUnits(BigInt(wei), 18)).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: dp,
    });
  } catch {
    return "—";
  }
}

export function fmtGas(wei, dp = 8) {
  if (wei === null || wei === undefined) return "—";
  try {
    return Number(ethers.formatUnits(BigInt(wei), 18)).toFixed(dp).replace(/0+$/, "").replace(/\.$/, "");
  } catch {
    return "—";
  }
}

export function short(addr, n = 6) {
  if (!addr) return "—";
  return addr.length > n * 2 + 2 ? `${addr.slice(0, n + 2)}…${addr.slice(-n)}` : addr;
}

export function timeAgo(ts) {
  if (!ts) return "—";
  const ms = typeof ts === "number" ? (ts < 1e12 ? ts * 1000 : ts) : new Date(ts).getTime();
  const diff = Date.now() - ms;
  if (Number.isNaN(diff)) return "—";
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export { CHAIN, CHAIN_ID, RPC_URL, TREASURY_ADDRESS, TREASURY_ABI, MUSD_ADDRESS, IS_DEPLOYED, explorerTx, explorerAddress };

// --- operator wallet (writes) ---------------------------------------------
export function hasInjectedWallet() {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

export async function connectOperator() {
  if (!hasInjectedWallet()) {
    throw new Error("No injected wallet found. Install MetaMask (or any EIP-1193 wallet) to operate the treasury.");
  }
  const provider = new ethers.BrowserProvider(window.ethereum);
  const accounts = await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== Number(CHAIN_ID)) {
    await switchOrAddChain(provider);
  }
  return { provider, signer, address: accounts[0] || signer.address };
}

export async function switchOrAddChain(provider) {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ADD_CHAIN_PARAMS.chainId }],
    });
  } catch (err) {
    // 4902 = chain not added yet
    if (err && (err.code === 4902 || /Unrecognized chain/i.test(err.message || ""))) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [ADD_CHAIN_PARAMS],
      });
    } else {
      throw err;
    }
  }
  return provider;
}

/** Wrap a write tx with consistent error extraction for the UI. */
/**
 * Send an owner transaction and report the result.
 *
 * Does NOT block on tx.wait(). On the Mezo testnet RPC that call can hang for
 * minutes after the transaction has already confirmed, which froze the gateway's
 * /api/pay for 600s+ on a payment that had in fact succeeded. The hash is known
 * the moment the wallet broadcasts, so return it immediately and race the
 * receipt against a bound, reporting `confirmed` separately.
 */
export async function sendTx(label, fn, confirmMs = 25_000) {
  try {
    const tx = await fn();
    const rc = await Promise.race([
      tx.wait().catch(() => null),
      new Promise((r) => setTimeout(() => r(null), confirmMs)),
    ]);
    return {
      ok: true,
      hash: tx.hash,
      label,
      confirmed: Boolean(rc && rc.status === 1),
      reverted: Boolean(rc && rc.status === 0),
    };
  } catch (e) {
    return {
      ok: false,
      label,
      error: e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || String(e),
      // Custom errors carry the policy reason — surface it, it is the point of the app.
      code: e?.errorName || (e?.error?.errorName) || null,
      data: e?.error?.args ? e.error.args.map(String) : null,
    };
  }
}
