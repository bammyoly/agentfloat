// ---------------------------------------------------------------------------
// The Permit2 approval, from the user's own wallet, in the browser.
//
// WHY THIS MODULE EXISTS
//   x402 on Mezo settles with `assetTransferMethod: permit2`. Before a wallet can
//   pay anything at all it must send ONE transaction of its own:
//
//       MUSD.approve(Permit2, amount)
//
//   Without it the policy engine refuses every payment with
//   `permit2_not_approved` — correctly, because the facilitator could not pull the
//   funds. The remedy the gateway printed for that was
//
//       fix with: cd contract && node scripts/grant-permit2.js
//
//   which is a developer command, run from a checkout, with a private key in
//   .env. A person who signed in with Google cannot run it, so the app had a door
//   only its authors could open. This is the same door from the inside: the
//   wallet signs, the wallet sends, no key is ever seen by this app or by the
//   gateway.
//
// WHY THE SEND GOES THROUGH THE RAW PROVIDER
//   `provider.request({ method: "eth_sendTransaction" })` and nothing else. A
//   wallet client would first estimate nonce, gas and fee data over the transport;
//   an embedded provider that does not implement one of those optional methods
//   then fails BEFORE the user ever sees a prompt. For a plain token approval the
//   provider can fill all of it itself, which is what every extension does. Fewer
//   round trips, fewer ways to die between the button and the prompt.
//
// WHY THE CONFIRMATION POLLS THE ALLOWANCE
//   On this RPC `tx.wait()` can hang for minutes AFTER the transaction has
//   confirmed — the same trap that froze `/api/pay` and that
//   `scripts/grant-permit2.js` works around. The allowance is also the thing we
//   actually care about: it is what the policy engine reads, so it is what the UI
//   should believe.
// ---------------------------------------------------------------------------

import { ethers } from "ethers";
import { musdRead } from "./chain.js";
import { ERC20_ABI, MUSD_ADDRESS } from "../contracts/index.js";

/** Canonical Permit2 — the same address on every EVM chain it is deployed to. */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** What "all future payments" means on chain: the max uint256 allowance. */
export const UNLIMITED = ethers.MaxUint256;

const iface = new ethers.Interface(ERC20_ABI);

/**
 * Decide the two arguments of the approval. Split out because it is the whole
 * choice the user is being asked to make, and because "unlimited" must never
 * silently become a number pulled from a quote.
 *
 * @returns {{spender:string, amount:bigint, unlimited:boolean, label:string}}
 */
export function approvalArgs({ unlimited, amountWei }) {
  if (unlimited) {
    return { spender: PERMIT2_ADDRESS, amount: UNLIMITED, unlimited: true, label: "unlimited" };
  }
  const amount = BigInt(amountWei || 0);
  if (amount <= 0n) throw new Error("An exact approval needs an amount greater than zero.");
  return {
    spender: PERMIT2_ADDRESS,
    amount,
    unlimited: false,
    label: `${ethers.formatUnits(amount, 18)} MUSD`,
  };
}

/** Build the calldata for `approve(spender, amount)`. */
export function approvalData(args) {
  return iface.encodeFunctionData("approve", [args.spender, args.amount]);
}

/**
 * Read the current MUSD → Permit2 allowance for one wallet.
 * `null` means the read failed (RPC down, chain not deployed) — which is NOT the
 * same as zero, and callers must not treat it as "approved" or as "not approved".
 */
export async function readAllowance(agent) {
  if (!agent) return null;
  try {
    const musd = musdRead();
    if (!musd) return null;
    return BigInt(await musd.allowance(agent, PERMIT2_ADDRESS));
  } catch {
    return null;
  }
}

/**
 * Send the approval from the user's own wallet.
 *
 * @param wallet  the session's agent wallet (`address` + `getEthereumProvider()`)
 * @param opts    `{ unlimited }` or `{ amountWei }` — see approvalArgs()
 * @returns {{hash:string, amount:bigint, unlimited:boolean, label:string}}
 */
export async function approvePermit2(wallet, opts = {}) {
  if (!wallet?.address) throw new Error("No agent wallet to approve from.");
  if (typeof wallet.getEthereumProvider !== "function") {
    throw new Error("This wallet cannot send transactions from the browser.");
  }
  const args = approvalArgs(opts);
  const provider = await wallet.getEthereumProvider();
  if (!provider?.request) throw new Error("The wallet provider is not ready yet — try again in a moment.");

  const hash = await provider.request({
    method: "eth_sendTransaction",
    params: [{
      from: wallet.address,
      to: MUSD_ADDRESS,
      data: approvalData(args),
      // No gas fields: the provider fills them. See the header comment.
    }],
  });
  if (!hash) throw new Error("The wallet returned no transaction hash.");
  return { hash, ...args };
}

/**
 * Wait until the allowance on chain covers `minWei`.
 *
 * `read` is injectable so this can be tested without a chain; in the app it is
 * `readAllowance`.
 *
 * @returns {{ok:boolean, allowance:bigint|null, ms:number, timedOut:boolean}}
 */
export async function waitForAllowance({ agent, minWei, timeoutMs = 60_000, intervalMs = 1500, read = readAllowance, onTick = () => {} }) {
  const started = Date.now();
  const need = BigInt(minWei || 0);
  for (;;) {
    const allowance = await read(agent);
    const ms = Date.now() - started;
    onTick({ allowance, ms });
    if (allowance !== null && allowance >= need) return { ok: true, allowance, ms, timedOut: false };
    if (ms >= timeoutMs) return { ok: false, allowance, ms, timedOut: true };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * The plain-language version of what an approval does and does not allow. Used by
 * the popup so the two choices are described in the same words everywhere.
 */
export function approvalExplainer({ unlimited, amountWei }) {
  if (unlimited) {
    return {
      title: "All future payments",
      what: "Approve Permit2 to move any amount of this wallet's MUSD.",
      detail:
        "One signature now, no approval prompt again. Permit2 still needs a fresh signature from this wallet for every spender it pays, and your treasury caps — per-call max and daily cap — are enforced by the contract on every payment regardless of this allowance. This is what the protocol's own setup grants.",
      risk:
        "Broadest allowance. If you would rather grant per payment, choose the other option — you can re-approve a smaller amount at any time.",
    };
  }
  const musd = amountWei ? Number(ethers.formatUnits(BigInt(amountWei), 18)) : null;
  return {
    title: "This payment only",
    what: musd === null
      ? "Approve Permit2 for exactly the quoted amount."
      : `Approve Permit2 for exactly ${musd} MUSD.`,
    detail:
      "Tightest option: the allowance is consumed by the payment it was granted for. You will sign one more approval for each new amount — a different seller, or a price change, needs its own.",
    risk: null,
  };
}
