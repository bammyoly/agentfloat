# 🌊 AgentFloat — Wave 2

**A budget-controlled, yield-bearing MUSD wallet system for AI agents on Mezo.**

An agent gets an isolated execution wallet — never access to your primary keys or unlimited collateral. A verified treasury contract holds the budget and releases float under per-call maximums and daily spending caps **enforced on-chain and at the gateway level**. 

The agent pays for APIs via **x402 in MUSD**, executes Permit2 approvals server-side without user wallet friction, earns yield by sweeping idle float into Mezo’s native **sMUSD Savings Rate**, and logs every settlement to an auditable, chain-verified ledger.

Deployed and paying on **Mezo Testnet** (`eip155:31611`) — see [`LIVE-DEPLOYMENT.md`](./LIVE-DEPLOYMENT.md) for addresses, transaction hashes, and a reconciliation of every payment against the chain.

Built for the Mezo Buildathon (Wave 1 → Wave 2 Upgrade).

| Resource | Target / Location |
|---|---|
| **Live Web Dashboard** | [https://agentfloat.vercel.app](https://agentfloat.vercel.app) |
| **Verified Treasury Contract** | [`0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79`](https://explorer.test.mezo.org/address/0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79) |
| **sMUSD Savings Vault** | [`0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16`](https://explorer.test.mezo.org/address/0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16) |
| **Deployment Tx Hash** | [`0x6292eb5934627453328f36b63477bd39692434f920b2a28802ad0040d173a05b`](https://explorer.test.mezo.org/tx/0x6292eb5934627453328f36b63477bd39692434f920b2a28802ad0040d173a05b) |

---

## 🛑 The Problem: Agents Can Spend, But They Cannot Budget

As AI agents move from chat interfaces to autonomous market actors, they need to pay for resources (APIs, data, compute) in real time using crypto. However, this introduces three critical failure modes:

1. **The Runaway Spend Risk:** An agent stuck in an infinite loop or prompt injection can drain an entire connected wallet in minutes without daily caps or per-call ceilings.
2. **The Idle Capital Loss:** Funding an agent requires leaving stablecoins sitting idle in an EOA. While waiting to be spent, that capital earns **0% yield**.
3. **The Private Key Paradox:** Giving an LLM or script direct access to your primary wallet is catastrophic. But forcing human wallet signatures (e.g. MetaMask popups) for every $0.001 micro-payment destroys autonomy.

---

## 💡 The Solution: AgentFloat

AgentFloat decouples **Policy/Custody** from **Execution** by creating a sandboxed, budget-enforced agent wallet layer:

- **Isolated Server-Side EOAs:** Your primary wallet authenticates via Reown (EIP-191 challenge) to provision a dedicated Agent EOA. Private keys are encrypted at rest using **AES-256-GCM** in MongoDB and decrypted *only* in-memory within authenticated session contexts.
- **3-Layer Security Defense:** On-chain treasury caps + gateway policy engine + hard on-chain agent wallet balance ceilings.
- **Native Mezo Yield (sMUSD):** Idle float in the agent wallet is automatically swept into the Mezo **sMUSD Savings Rate**. When an x402 payment is triggered, a Just-In-Time (JIT) liquidity function (`ensureLiquidity`) automatically pulls the exact required delta back into the agent wallet.
- **Autonomous x402 Execution:** Server-side Permit2 approvals (`POST /api/agent/approve-permit2`) allow the agent to pay x402 endpoints autonomously while strictly bounded by daily caps.
- **Real-Time Telegram Alerts:** instant notification on your phone whenever your agent pays, gets refused, receives funding, or deposits into sMUSD.

---

## 🌊 What's New in Wave 2 (Climbing the Mezo Ladder)

In Wave 1, AgentFloat was transactional. In Wave 2, we directly addressed judge feedback, fixed a High security finding, and composed natively with Mezo's financial stack:

### 1. High Security Finding Fixed (`/api/pay` Security & Quote Binding)
* **Judge Finding:** `/api/pay` was unauthenticated and signed unchecked quotes, allowing potential cap bypasses up to 1 MUSD.
* **Wave 2 Fix:**
  * **Session Auth:** `/api/pay` requires an encrypted `X-Session-Token` issued via primary-wallet EIP-191 signature.
  * **Rate Limiting:** Enforced at 10 requests per minute per session.
  * **Strict Quote Binding:** The gateway probes the 402 quote, verifies `{amount, asset, payTo}`, and enforces that the signed payment payload strictly matches the probed quote.
  * **Replay & Daily Spend Guards:** MongoDB-backed nonce tracking (`isNonceUsed`) and daily spend limits (`checkAndRecordSpend`) verify limits before touching the chain.

### 2. sMUSD Savings Rate Integration (`0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16`)
* Replaced non-yielding float with an automated background sweep loop (`savings-sweep.js`) that deposits idle agent MUSD into Mezo's **testnet sMUSD vault**.
* Integrates JIT liquidity withdrawal so payments never fail due to funds being locked in savings.

### 3. Native Collateralized Funding (No Operator Faucet)
* Removed operator faucet dependencies.
* Introduced the **Earn Page**: Users supply native BTC collateral to Mezo `BorrowerOperations` to mint MUSD, fund their agent EOA float directly, or drip BTC gas for Permit2 approvals.
* Includes `/api/agent/retrieve` to pull unspent MUSD float back to the primary wallet (destination strictly locked to `req.session.primaryAddress`).

### 4. Reown AppKit & EIP-191 Session Authentication
* Replaced Privy embedded client-side TEEs with server-encrypted EOAs authenticated via **Reown AppKit** (MetaMask, WalletConnect, Coinbase Wallet).
* Zero popups during payment execution while maintaining key isolation.

---

## 🛡️ 3-Layer Defense Architecture

AgentFloat enforces security across three independent layers that fail safe:

| Layer | Location | Enforces | Survives Gateway Compromise? |
|---|---|---|---|
| **1 · Treasury Contract** | On-chain | Maximum float released, per-call ceiling, daily funding cap, emergency recall. | **YES** |
| **2 · Gateway Policy Engine** | Server | Session auth, quote binding, rate-limiting, seller allowlists, daily spend sums, JIT liquidity. | No *(It is the policy engine)* |
| **3 · Agent EOA Balance** | On-chain | Hard ceiling: An agent can never spend more MUSD than is currently in its wallet. | **YES** |

### Why Agent Wallets are Plain EOAs
x402 on Mezo settles via `assetTransferMethod: permit2` using EIP-712 typed signatures. Smart contract accounts (ERC-4337) require ERC-1271 signatures, which standard x402 facilitators do not process. Therefore, Agent wallets are plain EOAs, AES-256-GCM encrypted at rest in MongoDB, and decrypted temporarily in server memory only during authenticated requests.

---

## 📂 Repository File Structure

```
agentfloat/
├── package.json               # Root orchestrator (npm run dev / install-all)
├── package-lock.json
├── README.md                  # Comprehensive protocol whitepaper & guide
├── SUBMISSION.md              # Judge submission summary & contract verification
├── DEPLOYMENT-BRIEF.md        # Environment setup facts and deployment brief
├── LIVE-DEPLOYMENT.md         # Verified testnet contract addresses and tx reconciliation
├── PITCH.md                   # Slide deck source (exportable to PDF)
├── VIDEO-SCRIPT.md            # Timed ≤2:15 walkthrough video script
│
├── contract/                  # Hardhat Smart Contracts Workspace
│   ├── contracts/
│   │   ├── AgentFloatTreasury.sol   # On-chain treasury policy vault
│   │   └── test/MockMUSD.sol        # Local testing mock contracts
│   └── scripts/
│       ├── deploy.js          # Deploys treasury & exports artifacts to frontend
│       ├── setup-agent.js     # Provisions agent allowances on-chain
│       └── grant-permit2.js   # Standalone Permit2 allowance grant tool
│
├── server/                    # Gateway & Session Backend Workspace
│   ├── lib/                   # Core modular backend services
│   │   ├── agent-retrieve.js  # Retrieve MUSD float -> session primary owner
│   │   ├── db.js              # MongoDB connection manager
│   │   ├── rate-limiter.js    # In-memory rate limiting middleware
│   │   ├── savings-sweep.js   # sMUSD sweep loop & JIT ensureLiquidity()
│   │   ├── session-auth.js    # requireSession middleware & EIP-191 challenge/login
│   │   ├── spend-tracker.js   # Mongo-backed daily spend caps & nonce replay guards
│   │   └── wallet-factory.js  # AES-256-GCM agent key generation & decryption
│   ├── agent-gateway.js       # Main Express server, x402 routes, Permit2, pay routes
│   ├── e2e-autopay.mjs        # Live e2e automated payment test harness
│   ├── e2e-onboarding.mjs     # Live e2e onboarding verification test
│   ├── e2e-relay.mjs          # Live x402 payment relay test
│   ├── gas.js                 # Gas drip router for Permit2 approvals
│   ├── limits.js              # Self-service budget router (primaryAddress verified)
│   ├── relay.js               # CORS relay with SSRF guards & quote inspection
│   ├── spend.js               # On-chain spend summation from receipt logs
│   ├── telegram.js            # Telegram notification engine & watcher
│   ├── .env                   # Gateway keys, Mongo URI, Session Secret (gitignored)
│   └── *-state.json           # Local fallback state files (gitignored)
│
└── frontend/                  # React + Vite + Tailwind v4 Workspace
    ├── .env                   # Environment variables (VITE_REOWN_PROJECT_ID)
    ├── .env.example
    ├── index.html
    ├── package.json
    ├── package-lock.json
    ├── vercel.json            # Vercel proxy rewrites
    ├── vite.config.js         # Vite proxy configuration for /api and /paid
    └── src/
        ├── main.jsx           # App entry point
        ├── App.jsx            # Core routing & shared data polling
        ├── index.css          # Tailwind v4 design tokens
        ├── components/        # Navbar, ApprovalModal, UI primitives, SVG Charts
        ├── contracts/         # Generated contract artifacts (deployment.json, chain.json)
        ├── lib/               # Session context, Reown setup, agent-permit2, x402 client
        └── pages/             # Home, Dashboard, Earn, Spend, Ledger, Operate, Alerts
```

---

## 🔄 Core Workflows & Pages

### 1. Onboarding & Session Auth
* User connects primary wallet via **Reown AppKit**.
* Clicks **Authenticate Session** → Signs EIP-191 challenge message.
* Gateway verifies signature against primary address, retrieves/creates encrypted Agent EOA in MongoDB, and sets `req.session = { primaryAddress, agentAddress }` with an HTTP-only token (`X-Session-Token`).

### 2. Earn Page (Collateral, Debt, Yield, & Retrieval)
* **Deposit BTC & Mint MUSD**: Supply native BTC collateral to Mezo `BorrowerOperations`.
* **Fund Agent Float**: Transfer MUSD directly into the agent wallet.
* **Gas Drip**: Send a small BTC drip to cover on-chain approval gas.
* **sMUSD Savings Vault**: Deposit idle float into sMUSD (`0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16`) to earn yield.
* **Retrieve MUSD**: Execute `POST /api/agent/retrieve` to pull unspent MUSD back to the primary wallet. Destination is enforced server-side.

### 3. Spend Page (x402 API Payments)
* **Enable Payments (Permit2)**: One-click `POST /api/agent/approve-permit2` executes `MUSD.approve(PERMIT2, maxUint256)` on-chain using decrypted agent key.
* **Pay x402 Endpoint**: Executes `POST /api/pay`. Verifies session, rate-limits, checks quote binding, sweeps sMUSD if needed via `ensureLiquidity()`, signs x402 payload, and settles transaction.
* **CORS Relay**: `POST /api/relay/probe` and `POST /api/relay/execute` allow paying APIs that lack browser CORS headers while keeping signing safe.

### 4. Operate Page (Self-Service Budgeting)
* Users adjust daily spend caps and per-call limits within published protocol ceilings.
* Authored via EIP-191 challenge → signed by primary wallet (`primaryAddress`) → executed on-chain by protocol owner key (`onlyOwner`).

### 5. Alerts Page (Telegram Integration)
* Authenticate Telegram connection via primary wallet signature.
* Receive instant push alerts for payments, policy refusals, budget updates, sMUSD deposits/withdrawals, and cap warnings.

---

## 🌐 API Endpoints Reference

### Session & Agent Management
* `GET  /api/session/challenge` — Request EIP-191 challenge for connected primary wallet.
* `POST /api/session/login` — Verify EIP-191 signature and issue `X-Session-Token`.
* `GET  /api/agent/:address` — Query balance, active status, daily cap, and spend today.
* `GET  /api/agent/permit2-status` — Query agent's Permit2 MUSD allowance.
* `POST /api/agent/approve-permit2` — Execute server-side `MUSD.approve(PERMIT2)` from decrypted Agent EOA.
* `POST /api/agent/retrieve` — Pull MUSD float from agent wallet back to primary owner.

### Spending & Relay
* `POST /api/quote` — Fetch unpaid HTTP 402 quote and evaluate gateway policy.
* `POST /api/pay` — **Authenticated payment endpoint.** Validates session, rate-limits, checks quote binding, ensures sMUSD liquidity, signs, and settles.
* `POST /api/relay/probe` — Fetch HTTP 402 quote without browser CORS limitations.
* `POST /api/relay/execute` — Execute relayed payment under policy bounds.

### Earn & Savings
* `GET  /api/savings/status` — Query sMUSD yield vault deposit status and balance.

### Self-Service Limits & Telegram
* `GET  /api/limits/challenge` — Request nonce challenge for budget change.
* `POST /api/limits/apply` — Verify primary wallet signature and update caps on-chain.
* `GET  /api/telegram/challenge` — Request nonce challenge for Telegram binding.
* `POST /api/telegram/subscribe` — Link Telegram chat ID to agent wallet.

---

## ⚡ Quick Start

### 1. Installation
Install dependencies across all workspaces:
```bash
npm run install-all
```

### 2. Environment Configuration
Copy environment templates and set required keys:

```bash
# Frontend
cp frontend/.env.example frontend/.env
# Required: VITE_REOWN_PROJECT_ID=your_reown_project_id

# Server
cp server/.env.example server/.env
# Required: MONGODB_URI, SESSION_SECRET, GATEWAY_SIGNER_PRIVATE_KEY, TELEGRAM_BOT_TOKEN
```

### 3. Running Locally
Run the backend gateway (port 4022) and frontend dashboard (port 5173) concurrently:
```bash
npm run dev
```
Open **[http://localhost:5173](http://localhost:5173)** in your browser.

---

## 🛠️ Workspace Command Matrix

| Workspace | Command | Purpose |
|---|---|---|
| **Root** | `npm run install-all` | Install dependencies for contract, server, frontend, and root |
| **Root** | `npm run dev` | **Start Gateway (:4022) + React Dashboard (:5173) concurrently** |
| **Root** | `npm run gateway` | Run backend gateway server only |
| **Root** | `npm run web` | Run frontend Vite dev server only |
| **Root** | `npm run test` | Run Hardhat smart contract unit tests |
| **Root** | `npm run test:gateway` | Run gateway offline unit, policy, and quote-binding tests |
| **Root** | `npm run test:relay` | **LIVE test:** Pay x402 seller on Mezo Testnet and verify settlement |
| **Root** | `npm run check:client` | Audit client code for stale patterns across 32 files |
| **Frontend** | `npm run build` | Build production frontend bundle |

---

## 🔗 Verified Mezo Testnet Contracts

| Asset / Contract | Testnet Address | Explorer / Link |
|---|---|---|
| **Mezo Chain ID** | `31611` (`eip155:31611`) | — |
| **RPC Endpoint** | `https://rpc.test.mezo.org` | — |
| **Explorer** | `https://explorer.test.mezo.org` | — |
| **MUSD Token** | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` | [View on Explorer](https://explorer.test.mezo.org/address/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503) |
| **Permit2 Contract** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical EVM Permit2 |
| **sMUSD Savings Vault** | `0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16` | [View on Explorer](https://explorer.test.mezo.org/address/0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16) |
| **AgentFloat Treasury** | `0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79` | [**Verify Contract Source**](https://explorer.test.mezo.org/address/0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79) |
| **Deploy Transaction** | `0x6292eb5934627453328f36b63477bd39692434f920b2a28802ad0040d173a05b` | [View Tx Hash](https://explorer.test.mezo.org/tx/0x6292eb5934627453328f36b63477bd39692434f920b2a28802ad0040d173a05b) |
| **x402 Facilitator** | `https://facilitator.vativ.io` | — |

*(Judges: Treasury source code is fully verified on the Mezo explorer link above; compiled with Solidity 0.8.28, optimizer 200 runs, London EVM).*

---

## 💼 Business Model & Monetization

AgentFloat generates revenue sustainably alongside protocol growth:

1. **Yield Performance Share (10–15%)**: Taking a performance fee on yield generated by sweeping idle agent float into Mezo's sMUSD Savings Vault.
2. **Payment Micro-Fees (~0.05%)**: Billed on autonomous x402 API settlement volume routed through the gateway.
3. **Hosted Gateway SaaS ($99–$499/mo)**: Subscription tier for AI agent development teams needing key isolation, rate-limiting, custom policy engines, and Telegram alert monitoring.

---

## 🧪 Testing & Verification Suite

```bash
# Hardhat Contract Tests
npm run test

# Gateway Offline Policy & Security Tests
npm run test:gateway

# Client & Browser Integration Tests
npm run test:browser

# Client Code Quality & Pattern Verification
npm run check:client

# Live Testnet x402 Relay Execution
npm run test:relay
```

---

## 📜 License

MIT License. Developed for the Mezo Buildathon.
```