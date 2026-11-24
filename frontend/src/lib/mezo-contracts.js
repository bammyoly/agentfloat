// frontend/src/lib/mezo-contracts.js
import { parseEther } from "viem";

/* ── Canonical addresses (Mezo testnet chainId 31611) ──────────────── */
export const MUSD_ADDRESS =
  import.meta.env.VITE_MUSD_ADDRESS ||
  "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";

export const BORROWER_OPERATIONS_ADDRESS =
  import.meta.env.VITE_BORROWER_OPERATIONS ||
  "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5";

export const TROVE_MANAGER_ADDRESS =
  import.meta.env.VITE_TROVE_MANAGER ||
  "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0";

export const PRICE_FEED_ADDRESS =
  import.meta.env.VITE_PRICE_FEED ||
  "0x86bCF0841622a5dAC14A313a15f96A95421b9366";

export const SORTED_TROVES_ADDRESS =
  import.meta.env.VITE_SORTED_TROVES ||
  "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA";

/* ── Protocol constants ──────────────────────────────── */
export const MCR = 110n; // Minimum Collateral Ratio (%)
export const CCR = 150n; // Critical Collateral Ratio (%)
export const GAS_COMPENSATION = parseEther("200"); // 200 MUSD, refunded on close
export const MIN_NET_DEBT = parseEther("1800"); // 1 800 MUSD
export const MAX_FEE_PCT = parseEther("0.05");

/* ── Minimal ABIs ────────────────────────────────────── */

export const borrowerOpsAbi = [
  {
    name: "openTrove",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "_debtAmount", type: "uint256" },
      { name: "_upperHint", type: "address" },
      { name: "_lowerHint", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "addColl",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "_upperHint", type: "address" },
      { name: "_lowerHint", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "repayMUSD",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_amount", type: "uint256" },
      { name: "_upperHint", type: "address" },
      { name: "_lowerHint", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "withdrawMUSD",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_amount", type: "uint256" },
      { name: "_upperHint", type: "address" },
      { name: "_lowerHint", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "adjustTrove",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "_collWithdrawal", type: "uint256" },
      { name: "_debtChange", type: "uint256" },
      { name: "_isDebtIncrease", type: "bool" },
      { name: "_upperHint", type: "address" },
      { name: "_lowerHint", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "closeTrove",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    name: "getBorrowingFee",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_debt", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

export const troveManagerAbi = [
  {
    name: "getTroveStatus",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_borrower", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getEntireDebtAndColl",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_borrower", type: "address" }],
    outputs: [
      { name: "coll", type: "uint256" },
      { name: "principal", type: "uint256" },
      { name: "interest", type: "uint256" },
      { name: "pendingCollateral", type: "uint256" },
      { name: "pendingPrincipal", type: "uint256" },
      { name: "pendingInterest", type: "uint256" },
    ],
  },
];

export const priceFeedAbi = [
  {
    name: "fetchPrice",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "lastGoodPrice",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

export const erc20Abi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];
