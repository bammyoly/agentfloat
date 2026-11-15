# AgentFloat — Wave 2 Submission

**Budget-controlled MUSD wallets for AI agents on Mezo.**

| Field | Value |
|---|---|
| **Product** | AgentFloat |
| **Network** | Mezo Testnet (`eip155:31611`) |
| **App** | _<paste production URL>_ |
| **Repo** | _<paste GitHub URL>_ |
| **Video** | _<paste ≤2:15 demo link>_ |
| **Deck** | `PITCH.md` → export PDF |
| **Primary wallet (demo)** | `0x76233C3D6c4D1A715Acad5D83031E686b2a88349` |
| **Demo agent** | `0x24A60a47B79f9656Dd58c923DFBe5145f5114A07` |

---

## 1. Contract verification (please click)

**AgentFloatTreasury**

- **Address:** [0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79](https://explorer.test.mezo.org/address/0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79)
- **Deploy tx:** [0x6292eb5934627453328f36b63477bd39692434f920b2a28802ad0040d173a05b](https://explorer.test.mezo.org/tx/0x6292eb5934627453328f36b63477bd39692434f920b2a28802ad0040d173a05b)
- **Block:** 16278029
- **Deployed:** 2026-10-21 · owner/deployer `0x76233C3D6c4D1A715Acad5D83031E686b2a88349`
- **Compiler:** Solidity **0.8.28**, optimizer **200 runs**, EVM **london**
- **Source:** `contract/contracts/AgentFloatTreasury.sol`
- **Artifact:** `frontend/src/contracts/deployment.json`

**Mezo primitives we compose with**

| Primitive | Testnet address | Role in AgentFloat |
|---|---|---|
| **MUSD** | [`0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`](https://explorer.test.mezo.org/address/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503) | Payment asset |
| **sMUSD Savings Rate** | [`0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16`](https://explorer.test.mezo.org/address/0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16) | Idle float yield (Wave 1 probed mainnet — **fixed to testnet**) |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | x402 settlement path |
| **BorrowerOperations** | Mezo Liquity stack | Earn page: BTC collateral → MUSD (replaces operator faucet) |
| **x402 facilitator** | `https://facilitator.vativ.io` | Settlement |

---

## 2. What Wave 1 was / what the judge asked

**Wave 1 shipped:** treasury with on-chain per-call + daily caps, x402 MUSD payments via Permit2, gateway policy, Telegram, faucet funding, dashboard.

**Judge feedback (quoted) and Wave 2 response:**

> *“Integration is at the transactional level today… swapping in USDC would be a config change. To climb the ladder in Wave 2, compose with Mezo itself: sweep idle float into the testnet MUSDSavingsRate (sMUSD)… or fund agents from a trove through BorrowerOperations instead of an operator faucet.”*

→ **Done.** sMUSD sweep + JIT `ensureLiquidity` on the **testnet** vault address. Earn page funds agents from BTC troves / primary wallet. Operator faucet removed from product path and Telegram copy.

> *“Technical is capped at 2 by a High finding: /api/pay is unauthenticated and checks the first 402 quote, then signs a second, unchecked one and records the probe amount, so anyone can bypass your per-call and daily caps up to x402's 1 MUSD default per call. Fix it with a client policy that only signs the checked {amount, asset, payTo} plus auth on /api/pay.”*

→ **Done.** See §3.

> *“Also verify the treasury on the explorer, keep the video under 2:15, add a short deck, and state how the product earns money.”*

→ **Done.** Explorer links above · `VIDEO-SCRIPT.md` · `PITCH.md` · monetization in §5 and pitch.

---

## 3. High finding — fixed in depth

`POST /api/pay` now runs this pipeline **in order**:

| # | Control | Mechanism |
|---|---|---|
| 1 | **Auth** | `requireSession` — `X-Session-Token` → `primaryAddress` + `agentAddress` |
| 2 | **Rate limit** | 10 req / min / session |
| 3 | **Structural quote** | `amount`, `asset`, `payTo` required |
| 4 | **payTo whitelist** | Optional `TREASURY_ADDRESS` lock |
| 5 | **Nonce replay** | Mongo `isNonceUsed` / `markNonceUsed` (1h TTL) |
| 6 | **Daily spend (Mongo)** | `checkAndRecordSpend(agent, amount, DAILY_SPEND_CAP)` |
| 7 | **On-chain policy** | Treasury registration, per-call max, **spent-today from receipts** (not `dayFunded`), wallet balance, Permit2 allowance, allowlist, SSRF |
| 8 | **sMUSD JIT** | `ensureLiquidity` before sign |
| 9 | **Sign once** | Per-user agent key via `createAgentX402(agentAddress)` — single paid fetch |
| 10 | **Quote binding** | Settled amount must match checked amount when facilitator exposes it; mismatch logged + flagged on receipt |
| 11 | **Receipt + lock nonce** | Gateway + optional on-chain `recordPayment` |

**Keys never hit the browser.** Agent EOAs are AES-256-GCM in MongoDB; decrypted only inside the authenticated request.

**Same primary-wallet auth pattern** applied to `/api/limits/*` and `/api/telegram/*` (Wave 1 verified the agent address; Wave 2 stores `primaryAddress` in the nonce and verifies the signer against it).

---

## 4. Mezo composition (ladder climb)

### sMUSD idle-float sweep
- Background `startSweepLoop` moves surplus agent MUSD into  
  **[sMUSD Savings Rate `0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16`](https://explorer.test.mezo.org/address/0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16)**  
  (explicitly the **testnet** address called out by the judge).
- Before each pay, `ensureLiquidity(agent, neededMusd)` withdraws only what the payment needs.
- Telegram: `vault_deposit` / `vault_withdraw` events.

### Fund from trove / primary (no operator faucet)
- Earn page: BTC collateral via BorrowerOperations → borrow MUSD → fund agent.
- Primary → agent MUSD transfer; BTC gas drip for Permit2.
- `POST /api/agent/retrieve` returns MUSD **only** to `req.session.primaryAddress` (destination not client-supplied).
- Faucet claim UX and Telegram “faucet claims” copy removed.

### Still transactional where it should be
- x402 path remains MUSD + Permit2 + facilitator — correct for pay-per-call APIs.
- Asset/network checks in policy refuse non-MUSD / wrong CAIP-2.

---

## 5. How the product earns money

| Stream | Model | Why it fits |
|---|---|---|
| **Yield share** | 10–15% of sMUSD yield on swept float | Aligns with “float should work while agents sleep” |
| **Payment micro-fee** | ~0.05% of x402 notional settled via gateway | Metered with volume; tiny vs API cost |
| **Hosted gateway SaaS** | Seat / usage subscription | Teams get isolated keys, policy, Telegram, ledger without ops |

Not a mixer, not a custodian of primary keys: **policy + yield on constrained agent float**.

---

## 6. Demo path (what the video shows)

1. Connect Reown wallet → EIP-191 session → agent EOA provisioned  
2. Earn: fund agent + show sMUSD sweep / vault balance  
3. Spend: Enable payments (server-side Permit2) → pay built-in `/paid/insight`  
4. Operate: tighten daily cap  
5. Alerts: Telegram payment + remaining cap  
6. Ledger: gateway + on-chain receipt  

Script: `VIDEO-SCRIPT.md` (**target 2:05–2:10, hard cap 2:15**).

---

## 7. Architecture snapshot
Primary wallet (Reown)
│ EIP-191 session
▼
Gateway (session-auth, policy, sweep, telegram)
│ decrypt agent key (request-scoped)
▼
Agent EOA ──Permit2──► x402 facilitator ──► seller
│
├── float ──sweep──► sMUSD (0x6f461c…8e16)
└── caps ──────────► AgentFloatTreasury (0xf10e…f79)

text


**3 layers:** on-chain treasury · gateway policy (auth, quote bind, spend) · agent balance.

---

## 8. Wave 2 file map (reviewer shortcuts)

| Area | Path |
|---|---|
| Pay auth + binding | `server/agent-gateway.js` → `POST /api/pay` |
| Session | `server/lib/session-auth.js` |
| Agent keys | `server/lib/wallet-factory.js` |
| Daily spend + nonce | `server/lib/spend-tracker.js` |
| sMUSD sweep / JIT | `server/lib/savings-sweep.js` |
| Retrieve to owner | `server/lib/agent-retrieve.js` |
| Limits primary verify | `server/limits.js` |
| Telegram Wave 2 | `server/telegram.js` |
| Treasury | `contract/contracts/AgentFloatTreasury.sol` |
| Deployment artifact | `frontend/src/contracts/deployment.json` |

---

## 9. Checklist against judge notes

| Ask | Status |
|---|---|
| Auth on `/api/pay` | ✅ `requireSession` + rate limit |
| Sign only checked `{amount, asset, payTo}` | ✅ single probe + binding check |
| sMUSD testnet vault (not mainnet) | ✅ `0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16` |
| Fund via trove / not operator faucet | ✅ Earn + retrieve; faucet path removed |
| Verify treasury on explorer | ✅ links in §1 |
| Video ≤ 2:15 | ✅ script timed |
| Short deck | ✅ `PITCH.md` |
| State how product earns money | ✅ §5 + pitch |

---

## 10. One-line pitch

**AgentFloat is the budget and yield layer for AI agents on Mezo: isolated MUSD wallets, on-chain caps, x402 payments, and idle float in sMUSD — so agents can spend while you sleep, without spending the house.**



AgentFloat is the budget and yield layer for AI agents on Mezo. It provides isolated MUSD wallets with on-chain spending caps, automated x402 API payments, and yield generation on idle balances via sMUSD—allowing AI agents to operate autonomously without risking primary user funds.

Deployment & Verification
Network: Mezo Testnet (eip155:31611)

Live: https://agentfloat-iota.vercel.app
Pitch: https://docsend.com/v/2mt6q/agentfloat
Video Walkthrough: 

AgentFloatTreasury Contract: 0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79 (Verified at block 16278029; Deploy tx: 0x6292eb5934627453328f36b63477bd39692434f920b2a28802ad0040d173a05b)

Core Mezo Integrations: MUSD (0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503), sMUSD Savings Rate (0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16), Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3), BorrowerOperations, and the x402 facilitator (facilitator.vativ.io).

Wave 2 Upgrades & Security Fixes
Building on Wave 1's core treasury and Telegram alerting system, Wave 2 addresses all judge feedback with deep Mezo composability and hardened security:

Native Mezo Composability: Replaced the Wave 1 operator faucet with a dedicated Earn flow allowing users to mint MUSD against BTC collateral via BorrowerOperations or fund agents directly from their primary wallet. A background loop automatically sweeps idle agent MUSD into the testnet sMUSD vault, using Just-In-Time (JIT) liquidity (ensureLiquidity) to withdraw only what is needed before each payment.

Hardened /api/pay Pipeline: Resolved the Wave 1 unauthenticated quote-bypass vulnerability. All payment, limit, and Telegram endpoints now enforce EIP-191 primary-wallet session authentication (X-Session-Token), rate limiting, nonce replay protection, and strict quote binding. The gateway signs only once per verified {amount, asset, payTo} quote, ensuring settled amounts match checked limits. Agent keys are AES-256-GCM encrypted at rest and decrypted strictly per request on the server.

Architecture & User Flow
AgentFloat operates across three layers: an on-chain treasury enforcing hard caps, a policy-enforcing gateway managing authentication and spend tracking, and an isolated agent EOA.

Users connect a primary wallet to provision an encrypted agent EOA.

Users fund the agent via BTC troves or direct MUSD transfer; idle funds automatically sweep into sMUSD.

The agent executes pay-per-call x402 requests via Permit2 within daily and per-call limits, sending real-time receipts and cap updates via Telegram.

Users can adjust limits on the fly or retrieve remaining agent MUSD back to their primary address.

Business Model
AgentFloat monetizes non-custodially without touching primary user keys through three streams:

Yield Share: A 10–15% fee on sMUSD yield generated from idle agent float.

Payment Micro-Fee: A ~0.05% fee on x402 payment volume settled through the gateway.

Hosted Gateway SaaS: Subscription tiers for teams needing isolated key management, custom policies, and audit ledgers.

