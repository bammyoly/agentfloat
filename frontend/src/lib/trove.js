// frontend/src/lib/trove.js
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatEther,
  parseEther,
  zeroAddress,
} from "viem";
import { mezoTestnet } from "./evm-network.js";
import {
  MUSD_ADDRESS,
  BORROWER_OPERATIONS_ADDRESS,
  TROVE_MANAGER_ADDRESS,
  PRICE_FEED_ADDRESS,
  borrowerOpsAbi,
  troveManagerAbi,
  priceFeedAbi,
  erc20Abi,
  GAS_COMPENSATION,
} from "./mezo-contracts.js";

/* ── Clients ─────────────────────────────────────────── */

const publicClient = createPublicClient({
  chain: mezoTestnet,
  transport: http(),
});

function walletClientFrom(eip1193Provider, account) {
  return createWalletClient({
    chain: mezoTestnet,
    transport: custom(eip1193Provider),
    account,
  });
}

/* ── Bounded tx wait (Mezo RPC hangs after confirm) ───
 * Two guarantees:
 *  1. a reverted transaction THROWS instead of looking like success
 *  2. a hung RPC stops waiting after timeoutMs
 */

async function waitForTx(hash, timeoutMs = 45_000) {
  const receipt = await Promise.race([
    publicClient.waitForTransactionReceipt({ hash }),
    new Promise((_, rej) =>
      setTimeout(
        () => rej(new Error("Still pending after 45s. Check the explorer for " + hash)),
        timeoutMs
      )
    ),
  ]);

  if (receipt.status !== "success") {
    throw new Error("Transaction reverted onchain: " + hash);
  }
  return receipt;
}

/* ── Reads ───────────────────────────────────────────── */

/**
 * Current BTC price in USD.
 * On-chain PriceFeed first, then Coinbase, then CoinGecko, then a testnet default.
 */
export async function getBTCPrice() {
  // 1. On-chain PriceFeed
  try {
    const raw = await publicClient.readContract({
      address: PRICE_FEED_ADDRESS,
      abi: priceFeedAbi,
      functionName: "lastGoodPrice",
    });
    const price = Number(formatEther(raw));
    if (price > 1000) return price;
  } catch (e) {
    console.warn("On-chain price feed unavailable, trying web fallbacks...");
  }

  // 2. Coinbase (2s timeout)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      const p = parseFloat(data?.data?.amount);
      if (p > 1000) return p;
    }
  } catch {}

  // 3. CoinGecko (2s timeout)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      if (data.bitcoin?.usd > 1000) return data.bitcoin.usd;
    }
  } catch {}

  // 4. Last resort default for testnet math
  return 95000;
}

/**
 * Borrowing fee in MUSD for a given net debt amount, or null if the
 * contract call is unavailable. The UI can fall back to an estimate.
 */
export async function getBorrowingFee(musdAmount) {
  try {
    const raw = await publicClient.readContract({
      address: BORROWER_OPERATIONS_ADDRESS,
      abi: borrowerOpsAbi,
      functionName: "getBorrowingFee",
      args: [parseEther(String(musdAmount))],
    });
    return Number(formatEther(raw));
  } catch {
    return null;
  }
}

/**
 * Trove status for one address.
 *
 * getEntireDebtAndColl returns, in order:
 *   [coll, principal, interest, pendingCollateral, pendingPrincipal, pendingInterest]
 * Entire debt = principal + interest (+ pending), and it already includes the
 * 200 MUSD gas compensation.
 */
export async function getTroveStatus(userAddress) {
  const [statusRaw, entire] = await Promise.all([
    publicClient.readContract({
      address: TROVE_MANAGER_ADDRESS,
      abi: troveManagerAbi,
      functionName: "getTroveStatus",
      args: [userAddress],
    }),
    publicClient.readContract({
      address: TROVE_MANAGER_ADDRESS,
      abi: troveManagerAbi,
      functionName: "getEntireDebtAndColl",
      args: [userAddress],
    }),
  ]);

  const status = Number(statusRaw);

  const [
    coll = 0n,
    principal = 0n,
    interest = 0n,
    pendingColl = 0n,
    pendingPrincipal = 0n,
    pendingInterest = 0n,
  ] = Array.isArray(entire) ? entire : [];

  const rawColl = coll + pendingColl;
  const rawDebt = principal + interest + pendingPrincipal + pendingInterest;

  const collBtc = Number(formatEther(rawColl));
  const debtMusd = Number(formatEther(rawDebt));
  const netDebt = Math.max(0, debtMusd - Number(formatEther(GAS_COMPENSATION)));

  let icr = 0;
  if (debtMusd > 0) {
    const price = await getBTCPrice();
    icr = (collBtc * price) / debtMusd;
  }

  return {
    active: status === 1,
    status,
    coll: collBtc,
    debt: debtMusd,
    debtRaw: rawDebt,
    netDebt,
    icr,
    icrPct: Math.round(icr * 100),
  };
}

export async function getMUSDBalance(address) {
  const raw = await publicClient.readContract({
    address: MUSD_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  return Number(formatEther(raw));
}

export async function getBTCBalance(address) {
  const raw = await publicClient.getBalance({ address });
  return Number(formatEther(raw));
}

/* ── Writes ──────────────────────────────────────────── */
// Every write simulates first. A bad ABI, an existing trove, too little
// collateral or too little MUSD surfaces here as a readable error, instead of
// a wallet popup whose Confirm button never enables.

export async function openTrove(eip1193Provider, userAddress, btcAmount, musdAmount) {
  const wc = walletClientFrom(eip1193Provider, userAddress);

  const { request } = await publicClient.simulateContract({
    account: userAddress,
    address: BORROWER_OPERATIONS_ADDRESS,
    abi: borrowerOpsAbi,
    functionName: "openTrove",
    args: [
      parseEther(String(musdAmount)), // net MUSD requested (fee + 200 gas comp are added on top)
      zeroAddress, // upperHint
      zeroAddress, // lowerHint
    ],
    value: parseEther(String(btcAmount)),
  });

  const hash = await wc.writeContract(request);
  await waitForTx(hash);
  return hash;
}

/**
 * Add collateral and/or borrow more MUSD on an EXISTING trove, in one tx.
 * Uses adjustTrove: BTC goes in as msg.value, extra MUSD is minted to the caller.
 * Either amount may be "0", but not both. Amounts are decimal strings.
 */
export async function borrowMore(eip1193Provider, userAddress, extraBtc, extraMusd) {
  const wc = walletClientFrom(eip1193Provider, userAddress);
  const btc = parseEther(String(extraBtc || "0"));
  const musd = parseEther(String(extraMusd || "0"));

  if (btc === 0n && musd === 0n) {
    throw new Error("Enter BTC to add, MUSD to borrow, or both");
  }

  const { request } = await publicClient.simulateContract({
    account: userAddress,
    address: BORROWER_OPERATIONS_ADDRESS,
    abi: borrowerOpsAbi,
    functionName: "adjustTrove",
    args: [0n, musd, musd > 0n, zeroAddress, zeroAddress],
    value: btc,
  });

  const hash = await wc.writeContract(request);
  await waitForTx(hash);
  return hash;
}

export async function closeTrove(eip1193Provider, userAddress) {
  const wc = walletClientFrom(eip1193Provider, userAddress);

  const { request } = await publicClient.simulateContract({
    account: userAddress,
    address: BORROWER_OPERATIONS_ADDRESS,
    abi: borrowerOpsAbi,
    functionName: "closeTrove",
    args: [],
  });

  const hash = await wc.writeContract(request);
  await waitForTx(hash);
  return hash;
}

export async function fundAgent(eip1193Provider, userAddress, agentAddress, musdAmount) {
  const wc = walletClientFrom(eip1193Provider, userAddress);

  const { request } = await publicClient.simulateContract({
    account: userAddress,
    address: MUSD_ADDRESS,
    abi: erc20Abi,
    functionName: "transfer",
    args: [agentAddress, parseEther(String(musdAmount))],
  });

  const hash = await wc.writeContract(request);
  await waitForTx(hash);
  return hash;
}

/**
 * Close a trove after checking the wallet can cover the repayment.
 * The 200 MUSD gas compensation is refunded from the GasPool, so the wallet
 * needs entire debt minus 200, not the full figure.
 */
export async function repayAndClose(eip1193Provider, userAddress, totalDebt) {
  const musdBal = await getMUSDBalance(userAddress);
  const debtNum =
    typeof totalDebt === "bigint"
      ? Number(formatEther(totalDebt))
      : Number(totalDebt);

  const needed = Math.max(0, debtNum - Number(formatEther(GAS_COMPENSATION)));

  if (musdBal < needed) {
    throw new Error(
      `Need ${needed.toFixed(2)} MUSD to close but you only have ${musdBal.toFixed(2)}. ` +
        `Get ${(needed - musdBal).toFixed(2)} more MUSD first.`
    );
  }

  return closeTrove(eip1193Provider, userAddress);
}

/** Send native BTC (gas) from the connected wallet to the agent EOA. */
export async function fundAgentGas(eip1193Provider, userAddress, agentAddress, btcAmount) {
  const wc = walletClientFrom(eip1193Provider, userAddress);
  const hash = await wc.sendTransaction({
    to: agentAddress,
    value: parseEther(String(btcAmount)),
    account: userAddress,
    chain: mezoTestnet,
  });
  await waitForTx(hash);
  return hash;
}

