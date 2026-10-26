# AgentFloat

**A budget-controlled MUSD wallet for AI agents on Mezo.**

An agent gets a wallet, not a key to yours. A treasury contract holds the budget
and releases float under a per-call maximum and a per-day cap **enforced on
chain**. The agent pays for APIs with x402 in MUSD, every settlement lands in an
auditable ledger, and one transaction stops it cold.

Deployed and paying on **Mezo Testnet** (`eip155:31611`) — see
[`LIVE-DEPLOYMENT.md`](./LIVE-DEPLOYMENT.md) for addresses, transaction hashes
and a reconciliation of every payment against the chain.

Built for the Mezo Buildathon, Wave 1, **Track 2 (Access & Distribution)**.

---

## What makes this more than an x402 demo

Anyone can wire up x402 and pay for an API. The interesting problem is: *what
stops the agent from paying for the wrong thing, too often, or too much?*

AgentFloat answers that with three layers that each fail safe:

| Layer | Where | Enforces | Survives a compromised gateway? |
|---|---|---|---|
| 1 · Treasury | on chain | how much an agent is ever **given** — per-call max, daily cap | **yes** |
| 2 · Gateway | server | whether this **specific** payment may be signed | no — it *is* the gateway |
| 3 · Wallet | on chain | the ceiling: only what is in the wallet can be spent | **yes** |

And the ledger is verified against the chain, not against HTTP status codes —
which turned out to matter a great deal. See
[Ledger integrity](#ledger-integrity-the-chain-is-the-source-of-truth).

Three things separate this from a demo that only its author can use, and each is
covered in its own section below:

- **[Self-service budget](#self-service-budget-you-sign-the-protocol-applies)** —
  a user changes their own caps from their own wallet. They sign an
  authorization; the protocol applies it on chain inside a published ceiling. An
  agent still cannot raise its own limit.
- **[The relay](#paying-sellers-that-send-no-cors-headers)** — most paid APIs
  send no CORS headers, so a browser cannot even fetch the 402. The signature
  stays in the wallet and only the HTTP hop moves to the gateway.
- **[Telegram alerts](#telegram-alerts)** — payments, refusals, cap changes and a
  low-budget warning, bound to a wallet by signature. Off, and honestly labelled
  as off, until a bot token exists.

---

## Multi-user: everyone gets an agent wallet

Privy provides Google/email sign-in. On first login Privy creates an **embedded
EOA** for that user; the same identity gets the same address and the same balance
on every later login, with no mapping stored by us.

Two wallet roles, kept strictly separate:

- **Agent** — the user's own embedded EOA. Receives faucet MUSD, signs x402
  payments in the browser. The key never leaves Privy's TEE; it is not in our
  bundle and not on our server.
- **Operator** — the treasury owner. Detected by comparing the connected address
  to `treasury.owner()` **read from the contract**, so nobody can grant
  themselves those controls by editing local state.

The faucet registers each new wallet as an agent in the treasury, so a faucet
user is governed exactly like the demo agent: it appears in the ledger and can be
paused or recalled.

### Why the wallets must be EOAs

x402 on Mezo settles with `assetTransferMethod: permit2`, which is an **EIP-712
signature**. Only an externally-owned account can produce one. So in the Privy
config:

- **no** ERC-4337 smart wallets
- **no** Privy gas sponsorship — it delegates the wallet via EIP-7702, giving the
  address contract code and forcing ERC-1271 signature mode, which the x402
  client does not use

Privy's default embedded wallet is an EOA secured by TEE + Shamir's Secret
Sharing, which is exactly right here.

### What a user sees first

Two of these are product requirements rather than styling, and both came from a
real misreading of the earlier UI.

**The dashboard leads with your own agent.** Order on `/dashboard`:

1. **Your agent wallet** (left, two-thirds width) — the spendable float, the
   address, and the three operations beside it: faucet, x402 payment, ledger.
   Under them, the on-chain caps that bound the wallet: left today, daily cap,
   per-call max.
2. **Onboarding** (right rail) — a four-step timeline with a `step 2 of 4`
   badge: create wallet → claim 10 MUSD → first x402 payment → verify on the
   ledger. The current step is the only one lit.
3. A divider labelled **Shared Protocol Infrastructure**.
4. Master treasury, the operator's demo agent, the sMUSD panel, chain facts.

It used to open with the treasury and the gateway's demo agent, and a first-time
user read the demo agent's float as their own — "I already have something set
up". Every state is now explicit, because a dashboard that guesses teaches the
wrong lesson: provisioning shows a skeleton with **no numbers**, an in-flight
chain read shows a skeleton bar (never a pulsing `0.0000`, which is
indistinguishable from "your balance is gone"), and an unfunded wallet shows a
real zero next to the one action that changes it.

**Operate is your budget first.** `/operate` used to be an operator console:
every action needed the treasury-owner wallet, so a user who had just created an
agent wallet with their email saw a page of disabled controls and no reason
anywhere — and reasonably concluded the product was not for them. It is now two
zones:

1. **Your agent budget** — the caps the chain currently enforces on your wallet,
   sliders and inputs bounded by the published ceiling, one **Apply change**
   button (challenge → sign → applied on chain, with the tx link), your own
   freeze/unfreeze switch, and your change history. Available to every signed-in
   user.
2. A divider labelled **Protocol controls · treasury owner only** — releasing
   float, depositing MUSD, pausing, emergency stop. For a non-owner this zone is
   an *explanation* of what those controls are and who holds the key, not a wall
   of greyed-out buttons: disabled controls with no reason read as a broken page.

**The navbar chip is a menu.** It still shows what it always showed — who you
are, and your agent address — but clicking it opens:

- the **full agent address**, click to copy, with a `✓ copied` confirmation;
- the connected external wallet, when there is one (the operator's MetaMask);
- the network, with a switch button when it is measured to be wrong;
- **Sign out**.

Sign out moved inside because it was the one destructive action in the navbar
sitting directly beside the thing people click to copy an address. The menu
closes on outside click, Escape, and navigation.

Copying goes through `copyText()` in `src/components/ui.jsx`, which falls back to
a hidden textarea + `execCommand`. `navigator.clipboard` only exists in a secure
context, so on `http://192.168.1.195:5173` — reaching the dev server from a phone
on the same LAN — a naive copy fails silently while the UI says "copied ✓". The
helper returns a boolean so the UI can tell the truth instead.

---

## Layout

```
agentfloat/
├── package.json               # root orchestrator: npm run dev / install-all
├── README.md
├── DEPLOYMENT-BRIEF.md        # verified Mezo facts, traps, day-by-day plan
├── LIVE-DEPLOYMENT.md         # what is actually on testnet, reconciled
├── verify-env.sh              # re-checks all 18 environment facts
│
├── contract/                  # Solidity + Hardhat
│   ├── contracts/
│   │   ├── AgentFloatTreasury.sol   # the policy vault
│   │   └── test/MockMUSD.sol        # LOCAL TESTS ONLY — never deployed
│   └── scripts/
│       ├── check-env.js       # pre-flight: gas, MUSD, token identity, facilitator
│       ├── deploy.js          # deploys + exports artifacts into frontend/src/contracts
│       ├── setup-agent.js     # creates/reuses an agent, grants BOTH allowances
│       ├── fund-treasury.js   # seeds the treasury with MUSD
│       ├── grant-permit2.js   # repair: Permit2 allowance (standalone, polls chain)
│       ├── set-limits.js      # change caps / active flag without a full re-setup
│       └── retire-agent.js    # deactivate an agent + drop it from agents.json
│
├── server/                    # the agent gateway (moved out of frontend/ — it is
│   │                          #  a backend, not part of the React app)
│   ├── agent-gateway.js       # policy gate + x402 signer + relay/alert routes + demo seller
│   ├── relay.js               # browser-signs-gateway-fetches: SSRF guard, probe, execute
│   ├── limits.js              # self-service budget: challenge → signature → owner-key tx
│   ├── telegram.js            # alert binding, long-poll, renderer, on-chain watcher
│   ├── faucet.js              # MUSD faucet router (nonce+signature, cooldown, caps)
│   ├── gas.js                 # capped BTC drip so a new wallet can send its approval
│   ├── spend.js               # today's SPEND, summed from the treasury's own receipts
│   ├── test-gateway.mjs       # 213 offline assertions for the modules above
│   ├── faucet-test.js         # LIVE faucet security harness (spends 10 MUSD)
│   ├── e2e-relay.mjs          # LIVE relay proof · e2e-onboarding.mjs · e2e-autopay.mjs
│   ├── .env                   # AGENT + GATEWAY_SIGNER keys — gitignored
│   └── *-state.json           # faucet / limits / telegram runtime state — gitignored
│
└── frontend/                  # React + Vite + Tailwind v4
    ├── .env.example           # VITE_PRIVY_APP_ID
    ├── vite.config.js         # Tailwind plugin + /api and /paid proxies
    └── src/
        ├── main.jsx           # router; lazy-loads Privy only if configured
        ├── App.jsx            # shared data polling + routes
        ├── index.css          # Tailwind v4 @theme design tokens
        ├── components/        # Navbar, ui primitives, ApprovalModal (the Permit2 popup)
        ├── pages/             # Home, Dashboard, Spend, Ledger, Alerts, Faucet, Operate,
        │                      #   Architecture, Diagnose
        ├── lib/               # chain, gateway client, session, privy, mezo, x402-browser,
        │                      #   agent-status (the shared useAgentStatus hook),
        │                      #   permit2 (the approval a wallet signs), autopay (the
        │                      #   automated-spending state machine), RingSpinner,
        │                      #   auth-errors (the two layers of sign-in copy),
        │                      #   privy-dom (the probe that tells a cancelled login
        │                      #   from a broken one)
        └── contracts/         # GENERATED by scripts/deploy.js — never hand-edited
```

`contract/scripts/deploy.js` writes everything the frontend needs into
`frontend/src/contracts/`. The React app imports addresses from the deployment,
never from hand-copied constants, so the UI cannot drift from what is on chain.
`src/lib/mezo.js` likewise derives its viem chain object from that generated
`chain.json`.

---

## Quick start

```bash
# 1. install every workspace (contract, server, frontend, root)
npm run install-all

# 2. configure
cp frontend/.env.example frontend/.env      # add VITE_PRIVY_APP_ID
cp server/.env.example   server/.env        # agent + gateway signer keys
cd contract && cp .env.example .env         # DEPLOYER_PRIVATE_KEY
cd ..

# 3. run the gateway (127.0.0.1:4022) and the dashboard (localhost:5173)
npm run dev
```

Two things in `server/.env` are optional but change what the UI can offer:

- **`GATEWAY_SIGNER_PRIVATE_KEY`** (the treasury owner) enables on-chain
  receipts *and* self-service budget changes. Without it `/api/limits/*` answers
  503 and the Operate page says so instead of offering a button that cannot work.
- **`TELEGRAM_BOT_TOKEN`** (+ optional `TELEGRAM_BOT_USERNAME`) enables alerts.
  Without it every `/api/telegram/*` endpoint answers 503 with the BotFather hint
  and the Alerts page shows the setup steps. Nothing is simulated.

`USER_PER_CALL_MAX_MUSD` (5), `USER_DAILY_CAP_MUSD` (50) and
`USER_MIN_PER_CALL_MUSD` (0.001) are the self-service ceiling; `ALLOWED_ENDPOINTS`
restricts which sellers may be paid (empty = any public https).

**Open <http://localhost:5173/> — not the LAN IP.** Browsers only expose
WebCrypto (`crypto.randomUUID`, `crypto.subtle`) and injected wallet APIs in a
*secure context*: HTTPS, or `http://localhost` / `127.0.0.1`. Vite also prints a
`Network:` URL like `http://192.168.1.x:5173`, and opening that one breaks Privy
and wallet extensions with errors such as

```
Uncaught TypeError: crypto.randomUUID is not a function
```

That is the browser enforcing its security model, not a bug in this app. The
dashboard renders a banner when it detects a non-secure origin. `npm run dev`
binds `127.0.0.1` for exactly this reason; use `npm run dev:lan` only when you
need a tunnel or a hosted preview.

### Which script lives where

Each folder is its own npm package with its own `package.json`, so a script only
exists where it is declared. This is the single most common way to run this wrong:

| You are in | Command | What happens |
| --- | --- | --- |
| **repo root** | `npm run install-all` | installs `contract/`, `server/`, `frontend/` and the root |
| **repo root** | `npm run dev` | **gateway + dashboard together** — the one you normally want |
| **repo root** | `npm run dev:lan` | same, but the dashboard binds `0.0.0.0` for tunnels/previews |
| **repo root** | `npm run gateway` | gateway only (`127.0.0.1:4022`) |
| **repo root** | `npm run web` | dashboard only (`127.0.0.1:5173`) |
| **repo root** | `npm run resume` | undo an emergency stop: unpause + release float |
| **repo root** | `npm run test:gateway` | 138 offline assertions: relay SSRF guard, payment-header shapes, budget ceilings, alert renderer |
| **repo root** | `npm run test:browser` | 684 offline assertions for browser-only code: network switch state machine, the x402 signer/header logic, the Permit2 approval, automated spending, the chart arithmetic, and the sign-in failure copy |
| **repo root** | `npm run test:relay` | **LIVE**: pays a real seller through the relay and proves settlement on chain — spends 0.001 MUSD, needs the gateway up |
| `server/` | `npm start` *(or `npm run dev`)* | gateway only |
| `server/` | `node faucet-test.js` | 15 faucet security assertions (needs a running gateway) |
| `frontend/` | `npm run dev` | dashboard only — `/api` calls fail without the gateway |
| `frontend/` | `npm run dev:all` | gateway + dashboard, without needing root `node_modules` |
| `frontend/` | `npm run check:deps` | crawl the served module graph for raw CommonJS (needs `npm run dev`) |
| `frontend/` | `npm run check:privy` | assert the Privy app behind your App ID is configured for AgentFloat |
| `frontend/` | `npm run check:client` | is *this* checkout current? 127 known-stale patterns across 32 files, after every module is parsed |
| `frontend/` | `npm run test:network` | unit tests for the wallet switch/add state machine |
| `frontend/` | `npm run test:x402` | unit tests for the browser half of an x402 payment — fake EIP-1193 provider, stubbed fetch |
| `frontend/` | `npm run test:auth` | 274 assertions on the sign-in failure copy — a cancelled login must not read as a failure |
| `frontend/` | `npm run install-all` | now also restores `@reown/appkit` + its ethers adapter |
| `contract/` | `npm test` | the 40 Hardhat unit tests |

`npm run install` is never a command — installing is plain **`npm install`** (no
`run`). `npm run` is only for scripts declared in `package.json`.

### Windows (PowerShell) equivalent

```powershell
cd C:\Users\user\Desktop\MPS\projects\Mezo\agentfloat2

# install each workspace explicitly (bulletproof; `npm --prefix` + install has
# historically mis-resolved the target folder on some Windows npm versions)
cd contract ;  npm install ; cd ..
cd server   ;  npm install ; cd ..
cd frontend ;  npm install ; cd ..
npm install                       # root: just `concurrently`

npm run dev                       # gateway + dashboard
```

If `npm run dev` at the root misbehaves, run the two halves in **separate
PowerShell windows** — identical result, easier to read the logs:

```powershell
# window 1
cd C:\Users\user\Desktop\MPS\projects\Mezo\agentfloat2\server ; npm start

# window 2
cd C:\Users\user\Desktop\MPS\projects\Mezo\agentfloat2\frontend ; npm run dev
```

Port already in use? Find and kill the holder:

```powershell
netstat -ano | findstr :4022
taskkill /PID <that-pid> /F
```

> **`npm run dev` starts both.** Running only `npm run dev` inside `frontend/`
> starts Vite alone, and every `/api` call fails with
> `ECONNREFUSED 127.0.0.1:4022` — the dashboard then sits in a "gateway offline"
> state. That is the single most common way to run this wrong.

Other root scripts: `npm run check-env`, `npm run deploy`, `npm run setup-agent`,
`npm run test`, `npm run resume`.

> **`npm run resume` undoes an EMERGENCY STOP.** The Operate page's red button
> calls `treasury.emergencyStop(agent)`, which pauses the treasury **and** sweeps
> the agent's entire float back in one transaction. While it is paused every
> payment is refused with `paused_onchain`, and `fundAgent` reverts too (it is
> `whenNotPaused`) — so recovery must **unpause first, then re-fund**, which is
> exactly what `resume.js` does. It is plain Node + ethers, needs no browser and
> no MetaMask, and polls the chain rather than awaiting `tx.wait()`:
>
> ```bash
> npm run resume                      # unpause + restore a 2 MUSD float
> REFUND_MUSD=5 npm run resume        # restore a different amount
> SKIP_FUND=1  npm run resume         # unpause only
> ```
>
> It finishes by printing both allowances (Permit2 and recall), since a zero
> Permit2 allowance is the other way payments silently fail with HTTP 412.

> **Never use `npx hardhat`.** With no local install present, `npx` silently
> downloads Hardhat **3.x**, whose ESM config is incompatible with this project
> and which refuses to run on Node 20 (`required: node >= 22`). The npm scripts
> use the pinned local Hardhat 2 binary.

---

## Privy setup

1. Create a free app at <https://dashboard.privy.io>.
2. Put the **App ID** in `frontend/.env` as `VITE_PRIVY_APP_ID`. The App ID is a
   public client-side value. The app **secret** belongs nowhere in this repo.
3. In the dashboard, under **App settings → Login methods**, enable **Google**
   and **Email** (and **Wallet** if you want the operator to connect MetaMask
   through the same navbar). Privy's shared Google credentials are enough for a
   demo; bring your own OAuth credentials for production.
4. In **App settings → Domains**, add `http://localhost:5173` (and every origin
   you deploy to). An empty list is permissive, but once you add one domain the
   served iframe enforces the others, so a missing origin breaks sign-in.
5. **Do not** enable smart wallets or gas sponsorship — see
   [Why the wallets must be EOAs](#why-the-wallets-must-be-eoas).

Two of these are *not* dashboard settings, which is easy to get wrong:

| Setting | Where it lives | Required value |
| --- | --- | --- |
| Login methods (Google, email, wallet) | dashboard | Google **on** |
| Allowed domains | dashboard | `http://localhost:5173` |
| Smart wallets | dashboard | **off** |
| `createOnLogin` | **`src/lib/privy.js`** | `embeddedWallets.ethereum.createOnLogin: "all-users"` |

`createOnLogin` is a client-side `PrivyProvider` config and defaults to `"off"`.
There is no dashboard switch for it. It must be nested under `ethereum` —
`embeddedWallets.createOnLogin` is not in the SDK 3.x config type, so it is
**silently dropped** and users sign in successfully and receive *no agent wallet*,
with no error anywhere. Verify the nesting against
`node_modules/@privy-io/react-auth/dist/dts/types-*.d.ts`, not blog posts.

### Verifying all of it: `npm run check:privy`

```
cd frontend && npm run check:privy
```

Queries Privy for the live configuration behind your App ID and asserts the four
things AgentFloat depends on, then checks the `createOnLogin` nesting in our own
source. No browser needed, no user interaction, exit code 1 on any failure:

```
✓ embeddedWallets.ethereum.createOnLogin = "all-users" (src/lib/privy.js)
✓ smart wallets disabled (required — agent wallets must stay EOAs for permit2)
✓ Google OAuth enabled
✓ allowed_domains covers local dev: http://localhost:5173, http://127.0.0.1:5173
```

This exists because the failure mode is invisible: the modal opens, spins, and
closes, and the console says nothing useful. A wrong-but-valid App ID, Google left
off, or smart wallets on all produce exactly that.

Note `enforce_wallet_uis` is on by default, so Privy shows its own confirmation
modal for each signature and overrides our `showWalletUIs: false`. That is right
for a demo. For unattended agent signing, turn off **Add confirmation modals** in
the dashboard's Embedded wallets page.

Without an App ID the app still runs: the navbar shows **"Privy not configured"**,
the faucet and per-user wallets stay off, and operator controls fall back to an
injected wallet (MetaMask). Nothing crashes and nothing is faked.

If Privy *is* configured but its chunk fails to load — bad App ID, offline auth
API, an extension interfering with WebCrypto — an error boundary in `main.jsx`
catches it and falls back to the same operator-wallet mode behind a banner. The
dashboard, ledger, spend and faucet pages do not need Privy, so a wallet-provider
problem never takes them down.

### A note on bursa, and on being wrong

`github.com/bammyoly/bursa` is an earlier, shipped Privy app by the same author.
Its config suggested that `appearance.walletList` (excluding `detected_wallets`)
fixes a login modal that opens, spins and vanishes. That hypothesis was applied,
then **falsified**: a clean reinstall of the SDKs fixed the modal with
`detected_wallets` still default, so the real cause was a corrupted install or
stale optimize cache. The bursa-derived settings were reverted. The one keeper
is `showWalletLoginFirst: false`, a UX choice: Google and email lead, wallet
stays available behind them.

Two of bursa's keys do not exist in SDK 3.50.0 at all — top-level
`embeddedWallets.createOnLogin` and `noPromptOnSignature` — verified against
`dist/dts/types-CoijvGho.d.ts`. Privy ignores unknown keys without a word, so a
copied config can carry dead settings that read as guarantees. Check keys
against the installed types, not against another project's config.

### If Privy will not work: replacement providers

The login modal opening, loading, and then vanishing usually has nothing to do
with Privy's service — see [Is this checkout current?](#is-this-checkout-current)
first, because a stale `src/main.jsx` reproduces that symptom exactly. If Privy
genuinely has to go, the constraint below narrows the field hard.

**Three things must all be true**, or the product changes shape:

1. **Wallet creation.** A brand-new user signs in with Google and gets an
   address. That is the Track 2 pitch, so a plain connector — RainbowKit, wagmi
   connectors, WalletConnect, injected MetaMask — does not qualify. Those attach
   wallets users already have.
2. **A raw EOA.** x402 on Mezo authorizes with an EIP-712 permit2 signature. A
   smart contract account must answer with ERC-1271, which the x402 client does
   not use, so every payment fails. See
   [Why the wallets must be EOAs](#why-the-wallets-must-be-eoas).
3. **Custom chain support.** Mezo testnet is chain `31611` and is in no standard
   chain list.

| Provider | EOA by default | Google + email | Custom chain | Notes |
| --- | --- | --- | --- | --- |
| **Thirdweb In-App Wallets** | ✅ `executionMode` defaults to `"EOA"` | ✅ plus passkey, phone, guest | ✅ `defineChain({ id: 31611, rpc })` | **Closest replacement.** `account.signTypedData()` gives permit2 directly; free tier covers embedded wallets; Vite-native React SDK |
| Dynamic (now Fireblocks) | ⚠️ MPC *or* smart contract, configurable | ✅ 9 OAuth | ✅ 100+ EVM | Key model not published; direction uncertain post-acquisition |
| Magic | ✅ delegated key, no native smart accounts | ✅ email-first | ✅ | Auth-only — anything beyond signing needs a second vendor |
| MetaMask Embedded Wallets (ex-Web3Auth) | ✅ SSS/MPC EOA | ✅ 14 OAuth | ✅ | Brand mid-transition; popup-first |
| Turnkey | ✅ TEE enclave | via passkey / API | ✅ 50+ | **Ships no UI** — you build the whole login flow |

⚠️ **The trap.** Thirdweb's own docs *recommend*
`executionMode: { mode: "EIP7702", sponsorGas: true }`. For AgentFloat that is
actively wrong: EIP-7702 delegates the EOA to contract code and forces ERC-1271,
which is the same reason Privy gas sponsorship stays off here. Take Thirdweb's
EOA default and ignore the gasless upsell.

**Avoid outright:** Crossmint and Sequence (smart contract wallets by default),
Safe (multisig contract), Coinbase Smart Wallet, and any configuration enabling
ERC-4337.

A swap touches `src/lib/SessionLayer.jsx` plus one new `…Layer.jsx`. **The gateway
and the contracts do not change at all** — a wallet is an address plus a signer.
`canSignX402()` in `src/lib/privy.js` is the only line that hardcodes
`walletClientType === "privy"`.

As a cheaper hedge, an injected/MetaMask path can run *alongside* Privy as a
second sign-in option. `SessionContext` already carries `operatorSigner` and
`externalWallets`, and `InertSessionProvider` already defines the shape, so a
second provider is additive rather than a rewrite. It does not create wallets, but
the faucet can fund whatever address connects, so the demo loop survives.

### The Reown connector (integrated)

Reown AppKit is wired in as a first-class session provider, alongside Privy
rather than instead of it. `src/lib/wallet-choice.js` decides, in order:

1. `VITE_WALLET_PROVIDER` overrides everything: `privy`, `reown` or `injected`.
2. `VITE_REOWN_PROJECT_ID` set → **Reown AppKit** (its modal lists installed
   wallets *and* WalletConnect from a phone).
3. a wallet injected at `window.ethereum` → the bare injected transport — no
   vendor, no signup, nothing extra in the bundle.
4. Privy configured → Privy, as before.
5. otherwise → inert operator-wallet mode.

So a machine that can use a real wallet is never held hostage by Privy's
`exited_auth_flow`, while a machine with no wallet at all still gets the Privy
path instead of a dead end. Get the Project ID free at
<https://cloud.reown.com>; it is a public client-side value like the Privy App
ID. Put it in `frontend/.env` as `VITE_REOWN_PROJECT_ID`.

**Network handling is the point.** AgentFloat only exists on Mezo testnet, so on
connect — and on page load for an already-connected wallet, and on demand from
the navbar's *wrong network* button — `src/lib/evm-network.js` runs:

```
eth_chainId → already 31611? done
            → wallet_switchEthereumChain            (chain known)
            → on 4902: wallet_addEthereumChain, then switch again   (EIP-3085)
```

A rejection (4001) is the user's answer: it is surfaced in the toast and never
retried silently. `-32603` is only treated as "unknown chain" when the message
says so, so a plain refusal never triggers a spurious add-request. The whole
state machine is unit-tested against a fake EIP-1193 provider:

```
cd frontend && npm run test:network    # 61 assertions, plain Node, no browser
```

**Why the swap is cheap.** Everything downstream reads `SessionContext` and never
asks which provider produced it. An external wallet wears a Privy-shaped shim
(`address` + `getEthereumProvider()`), so `lib/x402-browser.js` builds its viem
payer unchanged and permit2 signing routes through MetaMask. The gateway and the
contracts do not know or care. `canSignX402()` accepts `privy`, `injected` and
`reown` — all plain EOAs — and refuses anything else.

One honest limitation: an external wallet is one the user already has. Privy
remains the only provider here that can *create* a wallet for someone with none,
which is why it stays available behind `VITE_WALLET_PROVIDER=privy`.

### Is this checkout current?

Files in this repo get copied by hand between machines, and a stale file produces
a symptom that looks like a vendor bug. The canonical case is the Privy login
modal that opens, loads, and vanishes with nothing useful in the console: that is
`<React.StrictMode>` in an old `src/main.jsx` remounting `PrivyProvider`, which
strands the iframe's event queue.

```
cd frontend && npm run check:client
```

Greps the local source for every known-bad pattern this project has already paid
for, and names the file to recopy:

| File | Checked |
| --- | --- |
| `src/main.jsx` | no `StrictMode`, one `createRoot()`, exports nothing |
| `src/lib/privy.js` | `createOnLogin` nested correctly, `walletChainType` under `appearance`, no smart-wallet keys |
| `src/lib/PrivyLayer.jsx` | `login` from `useLogin()` with `onError`, `useWallets().ready` awaited, chain state **read** not hardcoded, `fixNetwork` really calls `ensureWalletChain()` |
| `src/App.jsx` | `/alerts` routed, `/diagnose` routed, no hook exports (Fast Refresh) |
| `src/components/Navbar.jsx` | address copyable, Sign out inside the user menu, `AuthErrorToast` rendered in **every** session state, switch button gated on `chainOk !== false`, the toast shows `err.user` and folds `err.dev` behind a disclosure, tone/title/persistence taken from the classifier, every hook above the early return |
| `src/lib/auth-errors.js` | a dismissal and a structural failure are separate outcomes, no maintainer vocabulary in the user-facing branch, the `dev` layer intact, no imports and no `import.meta` so Node can test it |
| `src/lib/privy-dom.js` | the probe exists once, an unreadable DOM is never called a fault, all four healthy thresholds checked, no DOM access at module scope |
| `src/pages/Diagnose.jsx` | imports the shared probe instead of redefining it |
| `src/components/ui.jsx` | `Button` merges an incoming `className`, clipboard copy survives an insecure context |
| `src/index.css` | `--color-ink-dim` token, `@keyframes shimmer`, `cursor-pointer` on `.btn` |
| `src/pages/Dashboard.jsx` | `<YourAgent>` renders **before** `<ProtocolSection>`, the shared `useAgentStatus()` hook (not a local copy), **no hook below an early return**, no animation classes that do not exist, a loading balance is never shown as zero |
| `src/pages/Operate.jsx` | self-service budget present (`limitsChallenge` → `session.signMessage`), the page does not call itself "Owner only", `<YourBudget>` renders **before** `<OwnerControls>` |
| `src/pages/Spend.jsx` | the gateway relay exists and is the default path, `makeRelaySigner()` is used |
| `src/lib/x402-browser.js` | `@x402/*` is imported **dynamically** — a static import OOMs the build |
| `vite.config.js` | `customLogger`, `optimizeDeps` interop list, nested `qrcode` for WalletConnect, loopback host |

Twenty-three checks across twelve files, plus eleven presence-only entries. Each
pattern was regression-tested both ways: green on the current source, and red on a
tree with the specific old bug re-introduced — a checker that only ever passes is
decoration. (The last six were re-verified that way when they were added: a copy
of `frontend/` with the `/alerts` route removed, the hook moved below the
`!deployed` guard, `eyebrow="Owner only"` restored, `<OwnerControls>` hoisted
above `<YourBudget>`, `useState("relay")` flipped to `"browser"`, and a static
`@x402/fetch` import prepended — all six fired.)

It checks *patterns*, not hashes: a file can be reorganised and still be correct,
and a hash would only say "different", not "wrong". Comments are stripped before
matching — a correct `main.jsx` explains the StrictMode bug in prose and
literally contains the text `<React.StrictMode>`, so matching the raw file would
flag the fixed version and pass the broken one.

### Reading the browser: `/diagnose`

`check:client` covers the source; some causes are only visible in a running
browser. Open **<http://localhost:5173/diagnose>** — a public route, because it
is only interesting while sign-in is broken.

It probes the live DOM and session and states a verdict:

| Probe | Healthy | What it means when it is not |
| --- | --- | --- |
| provider mounts / unmounts | `1 / 0` | `PrivyProvider` was constructed more than once — StrictMode, or a second `createRoot()`. **This is the "modal opens, loads, disappears" cause.** |
| React roots | `1` | the entry module was re-imported |
| Privy iframes | `1` once signed in | two confirms the double mount; zero while `ready` is true means an extension or blocked site data |
| secure context | `true` | WebCrypto is off, so no embedded wallet can be created |
| origin | in the allowlist | Privy answers `invalid_origin` |

Leave the page open, click **Sign in**, and watch the *Provider lifecycle* card —
it re-scans every 700ms, so the mount counters move at the moment the modal opens
and closes. **Copy report** puts a plain-text dump of everything on the clipboard.

The mount counters are published by a `useEffect` in `PrivyLayer.jsx`
(`window.__agentfloatBridgeMounts` / `…Unmounts`). StrictMode's dev behaviour is
mount → unmount → remount, which is exactly what those two numbers detect, and it
is the one thing about this bug that cannot be inferred from the source alone.

### Keeping Privy loadable: `npm run check:deps`

`vite.config.js` keeps `@privy-io/react-auth` and the `@x402` SDK out of Vite's
dep pre-bundler, because pre-bundling their whole tree OOM-kills esbuild on small
machines. The cost is that Vite then serves those packages **raw**, with no
CommonJS→ESM interop — and their trees contain CJS-only files a browser cannot
evaluate. The first one is a nested `eventemitter3`:

```
node_modules/@privy-io/react-auth/node_modules/eventemitter3/
  index.mjs ->  import EventEmitter from './index.js'
  index.js  ->  module.exports = EventEmitter     (pure CJS, no ESM exports)
```

Served raw, the browser follows `index.mjs` into `index.js` and dies with

```
Uncaught SyntaxError: The requested module
'/node_modules/@privy-io/react-auth/node_modules/eventemitter3/index.js'
does not provide an export named 'default'
```

which takes the whole app down unless the error boundary catches it. A crawl of
the served graph found **26** such files — the browser only ever reports the
first, so fixing them by hand is whack-a-mole.

`CJS_INTEROP` in `vite.config.js` lists all of them so esbuild pre-bundles each
one individually, which is cheap. To re-verify after bumping `@privy-io/*` or
`@x402/*`:

```bash
npm run dev            # terminal 1
npm run check:deps     # terminal 2 — exits 1 and lists any raw CJS file
```

It crawls `/src/lib/PrivyLayer.jsx` and `/src/lib/x402-browser.js` straight from
the dev server, so it works with no `.env` and no App ID. Last run: **3,944
modules, 0 landmines** — from both `/src/main.jsx` (the whole app graph) and the
Privy/x402 entries.

If your machine has ~4 GB or more free you can skip the whole scheme and let Vite
pre-bundle Privy normally — faster page loads and immune to new transitive CJS
deps:

```bash
# PowerShell
$env:AGENTFLOAT_PREBUNDLE_PRIVY=1 ; npm run dev
# bash
AGENTFLOAT_PREBUNDLE_PRIVY=1 npm run dev
```

On a 2 GB box that gets esbuild OOM-killed (`The service was stopped`), which is
why it is opt-in rather than the default.

### Silence the sourcemap spam: the `customLogger`

Excluding Privy from pre-bundling has one cosmetic cost. Vite serves those files
raw, sees `//# sourceMappingURL=…` comments pointing at `.map` files that are not
in the tarball, and prints

```
Sourcemap for "…/@privy-io/react-auth/dist/index.js" points to missing source files
```

once per file — **roughly 300 lines**, every cold start, every page load. It is
harmless: no sources are missing that we use, nothing is broken, and the app works
normally. But it buries every real message.

`frontend/vite.config.js` installs a `customLogger` that drops exactly that
message and prints one four-line notice instead, so the `[web]` pane is just the
banner, the two URLs, and the explanation. Measured: **77 log lines / 38 warnings
before, 44 lines / 0 warnings / 1 notice after**. Everything else passes through
unfiltered.

One trap worth recording: Vite emits this via `logger.warnOnce(...)`, and inside
`createLogger()` that method calls an internal `output()` closure **directly** —
it never goes through `logger.warn`. Overriding only `warn` filters nothing and
fails silently, with no indication that your patch isn't being hit. The config
patches both.

Setting `AGENTFLOAT_PREBUNDLE_PRIVY=1` (above) removes these at the source, since
pre-bundled deps get no stray sourcemap comments.

---

## Faucet

`Faucet` page → claim **10 MUSD** per wallet, once every **48 hours**, sent from
the operator wallet. On first claim the wallet is also registered as an agent in
the treasury with its own caps.

This endpoint spends real funds, so it is written as something an attacker will
try to drain. Controls, all server-side:

1. **Nonce + signature.** The server issues a short-lived nonce; the wallet signs
   a message containing its own address and that nonce; the server recovers the
   signer and refuses on mismatch. You cannot claim for an address you do not
   control, and a captured signature cannot be replayed because the nonce is
   consumed.
2. **Cooldown.** 48h per address, persisted to `server/faucet-state.json`
   (gitignored) so a restart does not reset it.
3. **Global caps.** Daily and total outflow limits — default 200/day, 1000 total
   — so the worst case is bounded instead of open-ended.
4. **Balance check.** Never promises MUSD the operator does not hold.

Tune with `FAUCET_AMOUNT_MUSD`, `FAUCET_COOLDOWN_HOURS`, `FAUCET_DAILY_CAP_MUSD`,
`FAUCET_TOTAL_CAP_MUSD`, `FAUCET_AGENT_PER_CALL_MAX`, `FAUCET_AGENT_DAILY_CAP`.

```bash
cd server && node faucet-test.js   # 15 assertions: legit claim, cooldown,
                                   # forged claim, replay, tampered message
```

> The faucet spends from the **treasury owner** wallet, which is fine on testnet
> and keeps the demo to one funded key. In production it should be a separate
> wallet with a hard budget, so a drained faucet cannot touch treasury ownership.

---

## Self-service budget: you sign, the protocol applies

`setAgentLimits()` is `onlyOwner`, and that is deliberate rather than an
oversight. An agent that can raise its own ceiling is not budget-controlled: a
prompt-injected or merely buggy agent would lift its own limit and the "hard cap"
would become a suggestion. So the authority to *choose* a number and the authority
to *enforce* the envelope are separated:

| Who | Does | Cannot |
|---|---|---|
| **The user** | sign a gateway-authored message naming their address, both values and a single-use nonce | exceed the ceiling, or reuse a nonce |
| **The protocol** | recover the signer, burn the nonce **before** the tx, refuse on any mismatch, apply inside the ceiling | choose the user's numbers |
| **The owner key** | execute `setAgentLimits` / `setAgentActive` on chain | be substituted — the values applied are exactly the values that were signed |

```
GET  /api/limits/config                                  # the published ceiling, and whether an owner key exists
GET  /api/limits/challenge?action=limits|freeze|unfreeze  # → { nonce, message, expiresAt }
POST /api/limits/apply   { nonce, signature }             # → { txHash, confirmed, previous, … }
GET  /api/limits/history?address=0x…                      # audit trail, attributed to "self-service"
```

Ceilings (env, `server/.env`): `USER_PER_CALL_MAX_MUSD` **5**,
`USER_DAILY_CAP_MUSD` **50**, `USER_MIN_PER_CALL_MUSD` **0.001**, plus
`dailyCap ≥ perCallMax`. Rate limited to 12 changes per address per hour and 240
globally, because each one is an owner transaction paid in real gas. Nonces live
5 minutes.

Refusals are specific rather than generic: `400` for a value outside the
envelope, `403` naming the address the signature actually came from, `409` for a
wallet that is not registered yet (claim from the faucet first), `410` for an
expired or already-used nonce, `429` at the rate limit, and `503` when the gateway
has no owner key — in which case the UI says exactly that instead of offering a
button that cannot work.

Verified end to end on testnet, including the forged, replayed and tampered
cases: [`LIVE-DEPLOYMENT.md`](./LIVE-DEPLOYMENT.md) §Wave 1 additions.

---

## Enable payments: the approval a user grants themselves

x402 on Mezo settles with `transferMethod: permit2`, which means the facilitator
*pulls* MUSD out of the agent wallet. That needs one `MUSD.approve(Permit2, amount)`
from the wallet that owns the key — and without it every payment is refused with
`permit2_not_approved`, correctly, before anything is signed.

The first version of this product told the user to run
`cd contract && node scripts/grant-permit2.js`. A person who signed in with Google
in a browser has no checkout and no private key, so that advice was a dead end. It
is now a popup — `components/ApprovalModal.jsx`, mounted on `/spend`, on the
dashboard's next-steps rail, and as the first button after a faucet claim:

- **This payment only** — approves exactly the quoted amount. The next purchase asks
  again.
- **All future payments** — approves the maximum, so the agent can run unattended.
  This is the default, and it is what the automation below assumes.

Both are explained in the user's own words, with the risk stated, and neither is a
setting somebody else flips for them.

**The half nobody mentions: gas.** An approval is a transaction, and a wallet
created by Privy has never held native BTC. So the popup reads the wallet's balance,
and when it cannot pay for the approval it offers:

1. **A capped drip from the operator key** — `server/gas.js`. Authorized by a
   signature over a gateway-issued nonce (the recovered address must equal the
   address being funded), and bounded by a 24 h per-address cooldown, a 0.005 BTC
   daily cap, a 0.02 BTC total cap, and a 0.01 BTC reserve so the owner key can
   always pay for its own transactions. Only a **registered agent wallet** can ask,
   so it is not an open BTC faucet.
2. **Mezo's own faucet** — `https://faucet.test.mezo.org`, which costs the operator
   nothing and is always shown next to the drip.

The approval is sent as a raw `provider.request({ method: "eth_sendTransaction" })`
with `{ from, to, data }` and **no gas fields** — building a viem wallet client
instead would run nonce and fee estimation first, and an embedded provider missing
any one of those methods fails *before the user sees a prompt*. Confirmation is
polled by reading the allowance, because `tx.wait()` on this RPC can hang for minutes
after the transaction has confirmed. All of it is pinned offline by
`npm run test:permit2` (46 assertions, fake EIP-1193 provider).

---

## Automated spending: run it until the budget stops it

On `/spend`, once a quote exists, the user chooses **Pay once** or **Run
automatically**. The automation repeats *that* purchase — the seller's real quoted
price, never a number somebody typed — on a schedule, and its purpose is to make the
budget controls visible without anybody clicking Pay forty times.

The panel shows, before anything is signed:

- a gauge of today's spend against the daily cap,
- this quote against the per-call max,
- **how many runs will settle, and which run number the cap will refuse**.

Then the run log shows what actually happened, one row per purchase: the outcome
(`settled`, `refused by policy`, `charged, no delivery`, `failed`), the MUSD that
**moved** — a refusal moves nothing, and the log says so — the rule that stopped it
in the gateway's own words, and the transaction that proves it.

The loop stops itself. It does not retry a budget refusal, because retrying a policy
that is working is how an agent drains a wallet. Every stop reason is named:
run budget used up, stopped by your own budget policy, stopped after a failed run,
the seller charged without delivering, or the endpoint asked for nothing.

**One implementation rule worth stating:** the loop calls the *same* `purchase()`
the Pay button calls, and the decision to run again comes from
`shouldContinue(runs, schedule)` reading the log — never from a counter kept in a
ref. Two sources of truth is how a loop ends up running forever. All the arithmetic
(classification, totals, stop rules, the projection) is pure and lives in
`lib/autopay.js`, tested offline by `npm run test:autopay` (110 assertions) and
live by `npm run test:autopay:live`.

With **your own wallet** every run needs a signature, and the panel says so: an
agent that could spend repeatedly without the key holder is the thing this product
refuses to be. For an unattended demonstration, switch the payer to the gateway's
demo agent — it signs server-side and the same on-chain caps apply to it.

---

## Two budgets with one name: daily spend vs daily funding

`dailyCap` appears in two places and means two different things. Getting this wrong
was the largest bug found in this project.

| | Where enforced | Counts | Field |
|---|---|---|---|
| **Daily funding cap** | `fundAgent()`, on chain | MUSD the treasury *released* to the agent today | `dayFunded` → `remainingToday` |
| **Daily spend cap** | the gateway's policy engine | MUSD the agent *paid away* today | summed from the treasury's `PaymentRecorded` receipts |

The contract's `remainingToday` is `dailyCap - dayFunded`, and nothing in the
payment path moves `dayFunded`. Comparing a payment against it made the daily cap a
second per-call max: **eight live purchases of 0.001 MUSD went through a 0.005 MUSD
cap without one refusal.** The faucet makes this worse, because it transfers MUSD
directly rather than calling `fundAgent()`, so `dayFunded` stays 0 forever.

`server/spend.js` now sums today's spend from the treasury's own receipts
(`paymentsByAgent()`, newest first, day boundary taken from the chain's block
timestamp in UTC — the same boundary the contract uses). It fails **closed**: if the
receipts cannot be read the payment is refused with `spend_read_failed`, and if
every receipt in the window is from today the sum is only a lower bound, so the
gateway refuses rather than guess (`DAILY_SPEND_LOOKBACK`, default 300, widens it).

Every policy answer carries the `budget` it was judged with — `spentToday`,
`leftToday`, `projectedAfterThis`, `receiptsRead`, `truncated` — and the contract's
counter is reported separately as `fundingHeadroomToday`. Wherever the UI shows that
counter it is labelled **Funding left today**, with a hint saying it is not a
spending budget.

The refusal now says what it counted:

> `daily_cap` — 0.001 MUSD would take today's spend to 0.006 MUSD, over the 0.005
> MUSD daily cap — 0.005 already spent across 5 on-chain receipts

Verified live: five purchases, 0.005 MUSD moved, the sixth refused, the denial
written on chain, and the funding counter unmoved at 0.005 the whole time.

---

## Paying sellers that send no CORS headers

A user's wallet signs x402 payments in the browser. That works — until the seller
is a normal API server, which sends no `Access-Control-Allow-Origin`, so the
browser's unpaid probe fails with `Failed to fetch` before anything can be signed.
The same quote through the gateway worked, which is what made it look like an app
bug rather than CORS doing its job.

So the two halves are separated, and only the half that needs no trust is relayed:

1. **`POST /api/relay/probe { url, agent }`** — the gateway fetches the URL
   unpaid and returns the *filtered* 402 headers, the body, the decoded offer
   (scheme, network, asset, amount, payTo, method) and the policy verdict for
   that agent. Nothing is signed here.
2. **The browser signs.** `makeRelaySigner(wallet)` in `src/lib/x402-browser.js`
   rebuilds the response and asks `x402HTTPClient` for a permit2 payload — the
   Privy prompt appears in the user's browser, and the key never leaves the TEE.
   The gateway cannot produce this signature. It hands back
   `{ payment, paymentHeaders, payload }`, where `paymentHeaders` is the map the
   SDK itself named — see the two warnings below.
3. **`POST /api/relay/execute { url, agent, payment, paymentHeaders }`** — the
   gateway re-checks the URL, reads the payer and the price **out of the payment
   itself**, refuses what it cannot read (`422 payer_unverifiable`,
   `422 amount_unverifiable`), refuses a payer that is not the claimed agent
   (`403 payer_mismatch`), applies the caps, fetches with the payment header the
   client chose, then proves settlement from the canonical MUSD `Transfer` logs
   and records it on chain.

**Two things about the payment header that are easy to get wrong.** Both cost a
real failed payment before they were found — `LIVE-DEPLOYMENT.md` §37–38:

- **The header name is part of the protocol.** x402 v1 travels as `X-PAYMENT`;
  v2 — which is what Mezo's facilitator and its hosted demo speak — travels as
  `PAYMENT-SIGNATURE`. `encodePaymentSignatureHeader()` returns a *map* so the
  caller never has to choose, and forwarding that map is what
  `wrapFetchWithPayment()` does internally. The relay forwards it filtered to
  those two names, so a client cannot smuggle `Host`, `Authorization` or `Cookie`
  through the operator's machine. A seller that never sees the header answers 402
  again: no error anywhere, ~30 s, no MUSD moves, and a log line that blames
  settlement.
- **The payer and the price are not at `payload.payer`.** v2 carries them in
  `payload.permit2Authorization.from` and `accepted.amount` (EIP-3009 uses
  `payload.authorization.from`); v1 keeps the requirement in an **array**, which
  read as an object yields `undefined` for every field. A guard written
  `if (payer && mismatch) deny` fails **open** on a payload it cannot parse, and a
  price it cannot parse becomes `0` — under every cap. Both are now refused with
  422 *before* anything is fetched.

A public relay endpoint is an SSRF hole without guards, so `server/relay.js`
enforces, **in this order**:

- **protocol** — https only. http is allowed for the gateway's own origins alone,
  which is how the built-in demo seller stays reachable.
- **allowlist** — `ALLOWED_ENDPOINTS`, when set, is checked *before* any DNS
  lookup, so an unlisted host is refused without resolving it.
- **SSRF** — IP literals are judged as written; hostnames go to
  `dns.lookup(..., {all:true})` and **every** resolved address is judged against
  private, loopback and link-local ranges, including the cloud metadata address.
  A name blocklist alone is bypassed by DNS rebinding, which is why this resolves.

Plus `redirect: "manual"` (a redirect is an unchecked second URL), a 512 KB body
cap, a 20 s timeout, and a `agentfloat-relay/1.0` user agent.

**What it costs, stated plainly:** the gateway now sees the request and the
response body in plaintext. It cannot sign and cannot exceed the caps, but it can
read what you bought. That is why the relay is per-purchase, labelled in the UI,
and never the only path — a seller that *does* send CORS headers can still be paid
directly from the browser.

---

## Telegram alerts

A cap you have to watch a dashboard to see working is not much of a cap, so
payments, refusals, budget changes, freezes, faucet claims and a once-a-day
"20% of your daily cap is left" warning are pushed to Telegram.

**Setup (operator, one time).** Create a bot with [@BotFather](https://t.me/BotFather)
(`/newbot`), then in `server/.env`:

```bash
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_BOT_USERNAME=agentfloat_alerts_bot   # optional; enables the one-tap t.me link
TELEGRAM_WATCH_SECONDS=300                    # optional; the on-chain watcher interval
```

Restart the gateway — the boot line changes from `🔕 telegram alerts off` to
`telegram on`. Until then every alert endpoint answers **503** with the BotFather
hint and the Alerts page shows the setup steps. Nothing is simulated: a
notification that was never sent is worse than none, because the user believes it
was.

**Binding a chat is signature-authorized**, because otherwise anyone who knows an
address could receive — or silence — somebody else's spending alerts:

```
GET  /api/telegram/challenge?address=0x…&action=subscribe|unsubscribe|test
POST /api/telegram/subscribe   { nonce, signature }  → { code, link, expiresAt }
POST /api/telegram/unsubscribe { nonce, signature }
POST /api/telegram/test        { nonce, signature }
GET  /api/telegram/status?address=0x…                → { enabled, subscribed, chatUsername, recent[] }
```

The user opens `t.me/<bot>?start=<code>` (or pastes the code by hand), presses
Start, and the bot binds that chat to the address and burns the code. Codes are
8 characters, single-use, 15-minute TTL, one live code per address — regenerating
replaces the old one, so a leaked link cannot be redeemed afterwards. `/stop`
unbinds, `/status` reports. Because the binding lands on the gateway and not in
the page, `/alerts` polls `/status` while a code is outstanding and flips to
**connected** by itself — doing what the app asked should not require a reload to
be told it worked.

Design choices worth stating:

- **No webhook.** The gateway usually runs on a laptop behind NAT with no public
  URL, so it long-polls `getUpdates`. A 409 means another poller is running:
  logged loudly and backed off for 60 s rather than fought over.
- **Best-effort by design.** A blocked bot, a deleted chat or a Telegram outage
  must never fail a payment or a budget change, so every `notify()` is
  fire-and-forget — and the delivery log the Alerts page shows is what keeps that
  from meaning *silently* dropped.
- **Per-chat rate limit** of 15 messages a minute.
- **The watcher reads the chain**, not the gateway's memory, so an event the
  gateway never saw — a payment settled straight from a browser — still produces
  an alert.
- **Stored:** one chat id per address, in `server/telegram-state.json`,
  gitignored. No key, no message content beyond the last send attempts.

---

## The interface

A spending product whose numbers you cannot read is not a spending product, so the
UI decisions below are load-bearing rather than decorative — and each one is pinned
by `npm run check:client`.

**Type scale and contrast.** Body copy is 15px on a documented scale (11 micro / 12
caption / 13 small / 14 body / 15 lead / 17 title / 20 page / 28 stat / 36 hero).
The old sheet had prose at 12–13px. `--color-muted` was lifted to ~9.4:1 and
`--color-dim` to ~7.7:1 against the panel background — both were below WCAG AA for
normal text — and `--color-faint` was added for rules and de-emphasised labels,
which is the only place a low-contrast colour belongs. 136 individual size bumps
across eight pages, applied as one mapping pass: sequential replaces cascade
(11 → 12.5 → 13.5) and quietly double the bump on whichever sizes they hit twice.

**Icons** come from `lucide-react` and go through one `<Icon />` wrapper, so size,
`strokeWidth` and the `aria-hidden`/`aria-label` decision are made once. `<IconTile />`
derives its colour with `color-mix()` on a tone token rather than a parallel set of
hardcoded hex values.

**Charts are SVG, not a dependency.** `Sparkline`, `BarChart`, `Donut` and
`RankBars` in `components/charts.jsx` render only; every number comes from
`activitySummary()` in `lib/charts-data.js`, which is pure and covered by
`npm run test:charts` (102 assertions). Two rules are enforced there: buckets are
UTC and cross-checked against `dayStartSec()` in `server/spend.js` — the module that
decides whether a payment is refused — so the dashboard cannot disagree with the
cap; and a series with fewer than two buckets renders words, never a flat zero line,
because on a fresh deployment an empty axis reads as "this protocol is dead".
Strokes use `vector-effect: non-scaling-stroke` so the line weight does not vary
with panel width.

**The dashboard shows your activity and the protocol's separately**, from the same
`<ActivityPanel />` with different inputs. That split is the organising idea of the
page: the treasury and the operator's demo agent are shared state, and a new user
who mistakes the demo agent's float for their own balance has been misled by the
layout. Both panels state how many receipts they read, because `/api/chain-records`
is capped at 100 and a truncated series that looks complete is a lie with a
gradient on it.

**The Spend page has a five-step instrument, not a caption.** `flowStep()` maps the
page's real state onto request → 402 → policy → signature → settle, so a refusal
lands on the step that produced it and the steps after it stay unreached.
`permit2_not_approved` lands on *signature*, not *policy* — pointing at policy
sends the user to lower a cap that was never the problem. All 19 gateway refusal
codes are mapped, and the mapping is tested against that list so the two cannot
drift.

**The pre-hydration shell is dark before anything loads.** `index.html` carries an
inline background on `<html>` *and* `<body>`, plus the spinner's own `@keyframes`,
because a white border flashing around the boot ring happens before any React code
runs and therefore cannot be fixed in the bundle. The indicator is the ring alone,
with no text.

**Accessibility primitives.** `Segmented` is a real `radiogroup` with `radio`
children, `aria-checked`, and ArrowLeft/Right plus Home/End — it replaced two
side-by-side `aria-pressed` buttons, which announced as "2 of 2 buttons" and could
not be driven by keyboard. `Meter` carries `role="meter"` and `aria-valuenow`.
`AddressLink` is a copy `<button>` plus a separate explorer `<a>`; it used to be one
`<a target="_blank">` whose `onClick` also copied, so clicking it navigated away and
swallowed the confirmation. A global `:focus-visible` ring and a
`prefers-reduced-motion` block that names every animation are in the stylesheet.

---

## Deploy to Mezo Testnet

### 0. Get testnet funds

MUSD on testnet is **minted by borrowing, not faucet-dispensed**:

1. Drip testnet BTC from <https://faucet.test.mezo.org>.
2. Borrow MUSD against it at <https://mezo.org/feature/borrow> with your wallet
   on Mezo Testnet (110% MCR / 150% CCR / 200 MUSD gas compensation).

The deployer needs **both**: BTC for gas, MUSD to seed the treasury.

### 1–4. Deploy and configure

```bash
npm run check-env                      # pre-flight, 18 live checks
SEED_TREASURY_MUSD=100 npm run deploy  # deploys + writes frontend artifacts
AGENT_PER_CALL_MAX=2 AGENT_DAILY_CAP=20 AGENT_INITIAL_FLOAT=2 npm run setup-agent
```

`setup-agent.js` is idempotent: it **reuses** the agent key from `server/.env`,
skips registration and limit updates that would not change anything, and skips
allowances that are already granted.

#### The agent needs TWO allowances — easy to confuse

| Allowance | Spender | Purpose | If missing |
|---|---|---|---|
| MUSD → **Permit2** | `0x0000…8BA3` (canonical, all chains) | lets the facilitator **pull** each payment | every payment fails with **HTTP 412**; the quote looks perfect and policy *allows* it, but no MUSD moves |
| MUSD → **treasury** | your `AgentFloatTreasury` | lets the owner **recall** unspent float | `emergencyStop` pauses but cannot sweep |

Repair an existing wallet with `cd contract && npm run permit2:grant`. The
gateway reports `agent.permit2.ready` in `/api/health` and refuses up front with
`permit2_not_approved` rather than letting settlement fail.

---

## Key handling

| Key | Where it lives | Used for | Exposure if leaked |
|---|---|---|---|
| **Owner** | your browser wallet | policy changes, releases, pause, **and applying a user's signed budget authorization** | full control of the treasury |
| **Gateway signer** | `server/.env` | writing receipts on chain | can forge ledger entries — cannot move funds |
| **Demo agent** | `server/.env` | signing x402 payments | bounded by its own balance and the caps |
| **User agent (Privy)** | Privy's TEE — never in our bundle or server | signing x402 payments in the browser | bounded by that wallet's own balance |

The owner key is also what executes a *user's* budget change: the gateway verifies
the signature, enforces the ceiling, and signs `setAgentLimits` itself. It never
sees a user's key and never accepts a value the user did not sign. When the owner
key is the same wallet as the gateway signer (`GATEWAY_SIGNER_PRIVATE_KEY`), that
one key can both forge ledger entries and move caps — which is why the ceiling and
the rate limits live in the gateway rather than in its goodwill, and why
production wants them separated.

No private key is ever given to a model. No agent key ever reaches the browser.
The React app talks to the gateway over **relative** URLs; Vite proxies them to
127.0.0.1, and the gateway binds loopback only — never `0.0.0.0`, because it
holds a key.

The gateway loads `server/.env` **by absolute path**, not from the cwd. A bare
`import "dotenv/config"` reads `process.cwd()`, so launching from anywhere else
silently loaded nothing and left x402 unarmed with no error at all.

---

## Ledger integrity: the chain is the source of truth

The audit log is the product, so a false entry in it is the worst bug AgentFloat
could have. Deploying found two, in opposite directions:

1. **A payment that never happened.** The gateway recorded `PaymentRecorded` for
   *any* response, including a 412 rejection where no MUSD moved. It now requires
   `status < 400` **and** `payment-response.success !== false`.
2. **A charge recorded as a refusal.** The facilitator has been observed settling
   the transfer on chain while the seller still answered HTTP 402 — so a
   status-only check logged a denial for money that had already moved. The
   gateway now captures the block height before signing and, on any non-success
   response, scans the canonical MUSD `Transfer` logs for the exact amount. If
   MUSD moved it records a **payment** flagged `charged_without_delivery`; only if
   nothing moved does it record a denial.

Browser-settled payments (a Privy user paying directly) are verified the same way:
`POST /api/record-settlement` reads the receipt, confirms a MUSD transfer left
that agent in that tx, and records the amount and payee **taken from the chain**,
not from the request body. A client that lies gets `verified: false` and nothing
is written.

The log is append-only — there is no delete function, by design — so the two rows
written before those fixes are still on chain. They are badged `unverified` in
the UI and disclosed in `LIVE-DEPLOYMENT.md`.

---

## Verified Mezo facts

`verify-env.sh` re-checks all of these live; `npm run check-env` verifies the
ones that matter before deploying.

- Testnet chainId **31611**, CAIP-2 **`eip155:31611`** — the bare string
  `"mezo-testnet"` and the number `31611` are both rejected by the facilitator.
  RPC `https://rpc.test.mezo.org`, explorer `https://explorer.test.mezo.org`.
- Mainnet is `eip155:31612`, RPC `https://mezo-mainnet.boar.network`.
  (`https://rpc.mezo.org` does not resolve.)
- **MUSD canonical (testnet)** `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`.
  A second token — `0xf9BB…D0af` — reports the identical name, symbol and
  decimals. It is an impostor, absent from the facilitator registry.
  `deploy.js` verifies metadata on chain and hard-blocks it. Distinguish them via
  `mintList()` on the two `BorrowerOperations` proxies.
- Facilitator `https://facilitator.vativ.io` serves **only** `eip155:31611` and
  `eip155:31612`. Scheme `exact`, x402 v2, `assetTransferMethod: permit2`,
  EIP-712 domain name **`Mezo USD`**. `eip2612GasSponsoring` means **the agent
  needs zero BTC to pay**.
- The facilitator's **signer addresses rotate between calls** — never hardcode
  them. Verify via the MUSD `Transfer` log.
- Solidity **0.8.28**, `evmVersion: london`, optimizer 200 runs.

### Traps handled in code

- The x402 SDK throws `RouteConfigurationError` **asynchronously from a background
  init handler**, so a `try/catch` around the seller mount does *not* contain it
  and the whole gateway dies. The mount is gated on the facilitator's networks
  and a last-resort handler keeps the API up.
- `EADDRINUSE` is **fatal** and exits non-zero. Limping along there produced a
  genuinely confusing failure: the banner printed, "gateway API stays up" was
  logged, and the dashboard quietly talked to a *stale* gateway running older code.
- Express matches middleware in registration order — a 404 catch-all placed above
  the faucet routes swallowed them entirely, while `/api/health` reported the
  faucet as enabled. The catch-all is now registered last.
- `tx.wait()` on the Mezo testnet RPC hangs for minutes **after** the transaction
  has confirmed. It froze `/api/pay` for 600s+ on a payment that had succeeded.
  Receipt writes race it against a 20s bound and return the hash (known at
  broadcast) plus a `confirmed` flag; the standalone scripts **poll the chain**
  for the expected state change instead.
- Hardhat is pinned to `^2` and `chai` to `^4` (5+ is ESM-only). `@solana/kit` is
  overridden to `6.9.0` — 6.10.0 references unpublished sub-packages.
- **Privy must be lazy-loaded.** Statically importing it put WalletConnect, the
  MetaMask SDK and a Solana tree into the main graph: Vite's esbuild dep
  pre-bundler got OOM-killed and `vite build` exhausted the heap. It now sits
  behind a dynamic `import()`, so an app with no App ID never loads it.
- **Lazy-loading is not enough — Privy's subtree needs CommonJS interop.** It is
  still in `optimizeDeps.exclude` to keep memory bounded, but excluding a package
  also strips CJS→ESM interop from its whole subtree, and 26 files in there are
  CJS-only. The first (`eventemitter3`) produced
  *"does not provide an export named 'default'"* and took the app down the moment
  a real App ID was set. All 26 are now listed in `CJS_INTEROP` for esbuild to
  pre-bundle individually; `npm run check:deps` re-verifies the graph. See
  [Keeping Privy loadable](#keeping-privy-loadable-npm-run-checkdeps).
- **A failing wallet provider must not take the app down.** `main.jsx` wraps the
  lazy Privy chunk in an error boundary that degrades to operator-wallet mode
  behind a banner. The dashboard, ledger, spend and faucet pages do not need
  Privy at all.
- **`http://<LAN-IP>:5173` is not a secure context**, so the browser disables
  `crypto.randomUUID` and injected wallets there — Privy and wallet extensions
  fail in ways that look like app bugs. `npm run dev` binds `127.0.0.1`;
  `App.jsx` renders a banner if it is loaded from a non-secure origin. Use
  `npm run dev:lan` only for tunnels and previews.
- The **in-process demo seller is flaky**: roughly half of payment attempts
  against it return HTTP 402 *after* the facilitator has settled, so the agent is
  charged and receives an empty body. Mezo's hosted demo settles reliably. The
  dashboard therefore defaults to `https://demo.vativ.io/`; the chain check above
  makes the failure harmless and visible.
- Mezo's hosted demo sends **no** `Access-Control-Allow-Origin`, so a browser
  cannot even fetch its 402 — the unpaid probe dies with `Failed to fetch` while
  the identical quote through the gateway succeeds. That asymmetry is what made it
  look like an app bug. The relay (above) is the fix: the browser signs, the
  gateway fetches. Our own seller sends `*`, so direct browser payment still works
  for it and stays available as a labelled option.
- **`isPrivateAddress()` must never be handed a hostname.** Its rule is "anything
  that is not an IP literal is refused", which is right for a guard and fatal for
  a caller: the relay's SSRF check passed hostnames to it, so every real seller
  came back `ssrf_blocked` while every private-range test case stayed green.
  `isIpLiteral()` now splits the two — literals judged as written, names resolved
  with `dns.lookup(..., {all:true})` and *every* address judged, because a name
  blocklist is bypassed by DNS rebinding. Caught by the one public-hostname
  *allow* case in `test-gateway.mjs`.
- **`x402Client` cannot build an `X-PAYMENT` header.** Header encode/parse lives
  on `x402HTTPClient` (`@x402/core/client`, re-exported by `@x402/core/http` and
  `@x402/fetch`): `getPaymentRequiredResponse(getHeader, body?)` →
  `createPaymentPayload()` → `encodePaymentSignatureHeader()`. `wrapFetchWithPayment()`
  is unusable for a relay because it signs *and* fetches, and those halves must
  happen in different processes. Its types are not in a `client.d.mts` — read the
  package's `exports` map.
- **`signer.signTypedData is not a function`, with the wallet connected and the
  quote correct.** `createWalletClient({ account: ADDRESS })` builds a viem
  **JSON-RPC account** — `{ address, type }`, data only, signing expected to go
  over the transport. `registerExactEvmScheme()` wants `{ address, signTypedData }`.
  `schemeSigner()` in `lib/x402-browser.js` binds the methods on the *client*
  instead. A `privateKeyToAccount` LocalAccount already has them, which is why the
  gateway never hit this and no server-side test could. Do **not** add
  `readContract` to a browser signer: it switches the SDK onto the optional
  EIP-2612 sponsoring path, one more thing to fail between the user and the
  prompt.
- **A polling effect that depends on a ticking clock never fires.** `/alerts`
  polls the gateway while a Telegram code is outstanding, because the binding
  lands server-side and nothing tells the page. Depending on the countdown's `now`
  recreated the interval every second, so the poll never ran. Depend on booleans
  that flip at most once (`subscribed`, `expired`) instead.
- **Vite tolerates a bare JSON import; Node does not.** `import chain from
  "./chain.json"` works in the dev server and throws *"needs an import attribute
  of type json"* in plain Node, which silently made browser modules untestable
  offline. They now use `with { type: "json" }`, which both accept — that is what
  lets `npm run test:x402` drive `lib/x402-browser.js` in Node.
- **A hook below an early return is a time bomb.** `Dashboard` read the agent
  status *after* `if (!deployed) return …`, so the hook count changed between
  renders the moment the artifacts appeared: "Rendered more hooks than during the
  previous render", whole page down, nothing in the network tab. Read first,
  return second — and `check:client` now asserts that order.
- `pkill -f agent-gateway.js` kills your own shell when the command line contains
  that string. Use `fuser -k 4022/tcp`, or kill by PID.

---

## Tests

```bash
npm run test                # 40 Hardhat policy tests
npm run test:gateway        # 213 offline assertions: SSRF guard, payment-header shapes, ceilings,
                            #   gas-drip caps, daily-spend arithmetic, alert renderer
npm run test:browser        # 684 offline assertions: network (61) + x402 (29) + permit2 (46)
                            #   + autopay (172) + charts (102) + sign-in copy (274)
                            #   + permit2 approval (46) + automated spending (172) + chart data (102)
npm run test:deploy         # 55 assertions: boots the REAL gateway as a child process in deployed
                            #   and loopback mode, then asserts over HTTP — PORT precedence, bind
                            #   address, the origin allowlist, admin-token lock, STATE_DIR
npm run test:auth           # 274 offline assertions: the sign-in failure copy. A person closing
                            #   the login popup must read as a dismissal, not an incident
npm run check:client        # is THIS checkout current? Every src module is parsed
                            #   with esbuild first (a file that does not parse makes every pattern
                            #   check on it meaningless), then pattern-checked. Includes server/gas.js,
                            #   server/spend.js and server/agent-gateway.js, not just src/
npm run check:deps          # Privy/x402/Reown dependency audit
cd server && node faucet-test.js  # LIVE: 15 faucet security assertions (registers an agent, spends 10 MUSD)
npm run test:relay          # LIVE: 20 checks, pays a real seller, spends 0.001 MUSD
npm run test:onboarding     # LIVE: new wallet → faucet → gas drip → approval → two payments, no terminal
npm run test:autopay:live   # LIVE: self-service caps, then the loop stops on the run it predicted
```

The contract suite covers every cap, the UTC-day rollover, pause semantics,
recall with and without an allowance, emergency stop, receipt authorisation,
ownership transfer, and a regression for lowering `dailyCap` below today's spend
(which used to underflow and panic `0x11`).

`test:gateway` needs no chain, no bot token and no network, which is why it runs
on every change to `server/`. It covers: the SSRF guard's private/loopback/
link-local/metadata cases **and a public-hostname allow case** (that one found a
real bug — see `LIVE-DEPLOYMENT.md` §32), `isIpLiteral()`, guard ordering,
`decodeOffer()` / `inspectPaymentHeader()` against the **real** v1 and v2 payload
shapes a wallet signs (v2 permit2, v2 EIP-3009, v1's requirement array, plus the
two payloads that cannot be attributed or priced, which must come back unreadable
so the gateway refuses them), `paymentHeadersFrom()`'s protocol-version header
naming and its allowlist,
`parseMusd()` and the ceiling derivation, real signature round-trips against
`ethers.Wallet.createRandom()` including an attacker key, a tampered message and a
cross-action replay (a `limits` signature must not authorize a `freeze`), and the
alert renderer's HTML escaping.

`test:browser` covers the code that cannot be reached without a real Privy login,
which is exactly where the two worst x402 bugs shipped (§37–38 in
`LIVE-DEPLOYMENT.md`). It drives `makeRelaySigner()` and `makeBrowserPayer()`
against a fake EIP-1193 provider that records every call and signs with a
throwaway key, plus a stubbed `fetch`: 402 → signature → `PAYMENT-SIGNATURE` on
the second request → resource returned, with the payer and amount asserted from
the decoded payload. No browser, no Privy, no network.

`test:permit2` and `test:autopay` cover the two things a user can lose money to and
cannot see: how the approval transaction is sent (raw `eth_sendTransaction`, no gas
fields, allowance polled rather than `tx.wait()`ed, a *partial* allowance not counted
as approved), and the automated-spending arithmetic (schedule clamping, what a
refusal moved — nothing — when the loop must stop, which run a cap refuses, and which
of the five x402 stages a given refusal code belongs to). Both were mutation-tested:
6 and 11 deliberate breakages respectively, all caught.

`test:auth` covers the words a failed sign-in shows, because that copy shipped wrong
in production and looked correct: closing the Privy popup produced a red *Sign-in
failed* alert plus a paragraph about iframe handshakes, `status.privy.com` and
`npm run check:client` — true, and addressed to a maintainer. Privy reports
`exited_auth_flow` for both a deliberate dismissal and a torn-down flow, so
`src/lib/privy-dom.js` supplies the evidence that separates them (provider mount and
unmount counts, iframe count, React root count) and `src/lib/auth-errors.js` returns
two strings per outcome — `user` for the toast, `dev` behind a disclosure. The suite
asserts that no maintainer vocabulary reaches `title`/`user` for any of the 19 codes,
that the technical layer survived rather than being deleted, that a real failure never
auto-dismisses, and — reading `Navbar.jsx` from disk — that every tone the classifier
can emit is one the toast can render, since an unmapped tone silently falls back to
red. Mutation-tested 15/15. See `LIVE-DEPLOYMENT.md` §54–55.

`test:charts` covers the arithmetic behind every dashboard chart, because a chart is
an assertion about data and a wrong one looks identical to a right one: the UTC day
boundary (**cross-checked against `dayStartSec()` in `server/spend.js`**, so the
dashboard cannot disagree with the cap that actually refused a payment), empty
buckets preserved rather than compacted, BigInt sums that survive records with no
`amount`, and the refusal-reason tally.

`test:deploy` is the newest suite and the only one that boots the gateway as a real
child process — twice, once bound `0.0.0.0` with an allowlist and an admin token,
once on loopback — then asserts over HTTP. It exists because four of the six
deployment blockers were invisible to unit tests: a wildcard that quietly accepted
`https://vercel.app`, an unauthenticated `/api/pause`, a bind address a PaaS could
not route to, and state files that a redeploy would wipe. 28 of its assertions are
the 11-origin CORS matrix. `check:client` was mutation-tested the same way — 28
broken-file scenarios, 28 caught — because a checker that cannot fail is
decoration.

The end-to-end cases that *do* touch the chain — a real budget change, a forged
signature, and a full relayed payment against Mezo's hosted demo (settlement tx
`0x10d392de…c770`, 0.001 MUSD moved, `paymentCount` 11 → 12) — are recorded with
their transaction hashes in `LIVE-DEPLOYMENT.md` §Wave 1 additions. `npm run
test:relay` re-runs the relay one on demand.

---

## Deploying it: gateway on Render, frontend on Vercel

```bash
# 1. gateway first — Render → New → Blueprint → this repo (render.yaml does the rest)
# 2. then the frontend — Vercel → Import → Root Directory: frontend
```

The split works, and the relay gets *better* on a server rather than worse: a
server-to-server fetch has no CORS, so sellers a browser could never reach become
reachable. The one awkward part is that each side needs the other's address —
`VITE_GATEWAY_URL` on Vercel, `GATEWAY_ALLOWED_ORIGINS` on Render — so one of them
deploys twice. `DEPLOYMENT-BRIEF.md` §15 gives the order that avoids guessing, the
six code changes that made it possible, key handling on a host you do not control,
and the verified 11-origin CORS matrix.

Two things worth saying up front:

- **`VITE_GATEWAY_ADMIN_TOKEN` is not a lock.** Every `VITE_`-prefixed value is
  inlined into the shipped bundle, so publishing the admin token there hands the
  pause switch to every visitor. Leave it unset. `/operate` reads
  `deployment.adminLocked` from `/api/health`, disables the gateway pause with an
  explanation, and points at the on-chain `pause()` — which needs the owner wallet
  and survives a restart — as the real remedy.
- **Render's filesystem is ephemeral.** Without the disk in `render.yaml` and
  `STATE_DIR`, every deploy wipes the faucet cooldowns (so a restart becomes a way
  to claim again), the gas-drip caps, the self-service budget audit trail and every
  Telegram binding. A free-tier service cannot attach a disk; expect the reset.

Local development is unchanged and needs no configuration: with no `GATEWAY_HOST`
the gateway binds loopback, the allowlist is not enforced, and `npm run dev` works
exactly as before.

---

## Building for production

```bash
cd frontend && npm run build
```

The build script invokes node directly with `--max-old-space-size=4096` rather
than `NODE_OPTIONS=… vite build`, which does not work in Windows cmd/PowerShell.
You need roughly **4GB of free RAM**: Privy's dependency tree is large. A `npm run
dev` session does not bundle and is unaffected.

---

## Limitations

Stated here and in the UI, because a judge will ask.

1. **The gateway is trusted.** It holds the demo agent key, so per-payment
   enforcement is only as strong as that process. Layers 1 and 3 still hold if it
   is compromised.
2. **A contract cannot veto an individual x402 payment.** Authorization is an
   EIP-712 permit2 signature, which only an EOA can produce. So on-chain
   enforcement is on *funding*, and per-payment enforcement lives in the gateway.
   Closing that gap — a permit2-spender policy contract — is the Wave 2 upgrade.
3. **Pause cannot unsign what is already funded.** Pausing stops *further*
   releases; an agent holding float can still spend it. `emergencyStop` is the
   actual stop, and its sweep requires the recall allowance.
4. **The faucet spends real operator funds**, from the treasury owner wallet.
   Global caps bound the damage; production wants a separate funded wallet.
5. **No sMUSD yield on testnet.** The vault proxy holds 0 bytes of bytecode here
   and 1,159 on mainnet. The UI says "unavailable on testnet" rather than mocking
   an APR. It is also **not ERC-4626** — every standard getter reverts; the real
   interface is `deposit(uint256)` / `withdraw(uint256)` / `token()`.
6. **Daily caps reset at 00:00 UTC** from `block.timestamp`, not your local day.
7. **A relayed purchase is a trusted hop.** The relay is what lets a browser
   wallet pay sellers with no CORS headers, and the signature stays in the
   browser — but the gateway sees the request and the response body. It cannot
   sign and cannot exceed the caps; it can read what was bought. Per-purchase,
   labelled, never the only path.
8. **Alerts are best-effort.** A Telegram outage, a blocked bot or a chat rate
   limit means a missed notification, never a failed payment. The delivery log on
   the Alerts page is the mitigation: silence is recorded, not swallowed. And
   with no bot token configured, no alert is sent at all — the endpoints answer
   503 and the UI says so.
9. **Self-service ceilings live in env, not in the contract.**
   `USER_*_MUSD` is an operator choice; per-agent ceilings set at registration
   would make it a protocol one.

---

## Wave 2 roadmap

1. **Mainnet.** `eip155:31611` → `eip155:31612` is a one-line change per Mezo's
   docs, plus setting `PAY_TO` explicitly. Then both legs are real.
2. **sMUSD surplus sweep.** An adapter against the vault's actual interface,
   keeping enough MUSD liquid for near-term spending. Yield is variable.
3. **On-chain per-payment policy.** A permit2-spender contract so caps hold
   without trusting the gateway.
4. **Provider directory.** Sellers list paid endpoints; agents discover them.
5. **Alerts beyond Telegram.** The binding, the renderer and the on-chain watcher
   are built; what is missing is routing (webhooks, email), per-agent alert
   preferences, and pause/ownership events, which are protocol-wide rather than
   per-wallet.
6. **Ceilings on chain.** Move `USER_*_MUSD` into the contract as per-agent
   ceilings set at registration, so the envelope is not an operator's env file.
7. **Direct-to-seller payments.** A seller-side CORS profile (or a signed-request
   convention) would remove the trusted relay hop for sellers who opt in.
