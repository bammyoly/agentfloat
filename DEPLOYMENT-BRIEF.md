# AgentFloat on Mezo Testnet — Deployment Brief

**Verdict: yes for the x402 payments half. No for the savings-vault half.**

Everything below was checked live against `https://rpc.test.mezo.org`,
`https://mezo-mainnet.boar.network`, and `https://facilitator.vativ.io/supported`
on **2026-10-21**. Run `verify-env.sh` in this folder to reproduce.

---

## 1. What is confirmed working on Mezo Testnet

| Check | Result | How verified |
|---|---|---|
| Testnet RPC live | `eth_chainId = 0x7b7b` (31611), block ~16.27M | `eth_chainId`, `eth_blockNumber` |
| x402 facilitator supports testnet | `eip155:31611` + `eip155:31612`, scheme `exact`, x402 v2 | `GET facilitator.vativ.io/supported` |
| MUSD accepted by facilitator on testnet | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`, symbol `MUSD`, 18 dec, EIP-712 name **`Mezo USD`** v1, `permit2` + `supportsEip2612: true` | facilitator `/supported` |
| x402 settlement proxy deployed on testnet | `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` has runtime bytecode | `eth_getCode` |
| **Buyer pays zero gas** | facilitator advertises extension `eip2612GasSponsoring` | facilitator `/supported` |
| Testnet MUSD is real and liquid | name `Mezo USD`, symbol `MUSD`, 18 decimals, **totalSupply ≈ 523,782,988 MUSD** | `eth_call` |
| SDK availability | `@x402/fetch`, `@x402/evm`, `@x402/express`, `@x402/core`, `@x402/paywall` all at **v2.28.0** on npm. Testnet needs ≥ 2.10.0 (TS), ≥ 2.9.0 (Go), ≥ 2.7.0 (Python) | npm registry |
| Official reference app to fork | `vativ/mezo-hack` → `apps/humor` (MIT): Express `GET /joke` paywalled at 0.001 MUSD + a `@x402/fetch` client that signs a permit2 authorization from a private key | GitHub API |
| Faucet + testnet dApp reachable | `faucet.test.mezo.org` → 200, `testnet.mezo.org` → 200 | HTTP status |

**Conclusion:** your item 2 (agent hits a 402, pays MUSD via x402, gets the result)
is a supported, documented, live path on testnet. This is not speculative.

---

## 2. The blocker: there is no MUSD Savings Vault on testnet

Your plan routes surplus MUSD into the vault for sMUSD. That cannot be demoed on testnet.

| Check | Result |
|---|---|
| Mainnet vault proxy `0xb4D498029af77680cD1eF828b967f010d06C51CC` on **testnet** | `eth_getCode` → `0x` — **no code, does not exist** |
| Same address on **mainnet** | 1,159-byte EIP-1967 proxy, impl `0xb33c3f97bf3b7df59417d114c694353e42929e87` (11,928 bytes) |
| Vault identity on mainnet | `name()` = `MUSD Savings Rate`, `symbol()` = `sMUSD`, `decimals()` = 18 |
| Mainnet vault scale | sMUSD `totalSupply()` ≈ **7,382,416**; MUSD held directly by vault ≈ **66,262** (rest deployed to strategies) |
| Impl on testnet | 209-byte stub at the impl address — not a functioning vault |

An independent Wave 1 builder reached the same conclusion in their README
(`AshThunder/lockwatch`): *"No sMUSD savings vault on testnet. The 'MUSD → savings'
outcome is mainnet-only."*

### Second vault problem: it is **not ERC-4626**

The mainnet vault reverts on every standard 4626 getter. Present in the
implementation bytecode:

```
b6b55f25  deposit(uint256)
2e1a7d4d  withdraw(uint256)
fc0c546a  token()
fbfa77cf  vault()
+ ERC-20: totalSupply, name, symbol, decimals, balanceOf, transfer, approve, allowance
```

Reverting / absent: `asset()`, `totalAssets()`, `convertToShares()`,
`convertToAssets()`, `pricePerShare()`, `maxDeposit()`, `previewDeposit()`,
`mint(uint256,address)`, `redeem(...)`, `permit(...)`.

**Impact:** a generic `IERC4626` adapter — the thing most buildathon vault
projects reach for, and what several public Wave 1 repos assume — will not
compile against this target, let alone work. You must read the actual ABI from
`explorer.mezo.org` and integrate `deposit(uint256)` / `withdraw(uint256)` /
`token()` directly. Note `token()` and `vault()` revert via `eth_call` even on
mainnet, so confirm their mutability from the verified source before wiring them.

### What to do about it

- **Cut the vault from Wave 1.** Do not ship a mock sMUSD and call it Mezo
  integration — judges who check the explorer will see the address is empty on
  testnet, and that reads worse than an honest omission.
- **Reframe Wave 1 as pure Track 2 (Access & Distribution).** The buildathon
  track descriptions are *DeFi* and *Access & Distribution*; your budget-control
  panel is squarely Track 2. Dropping the Track 1 claim costs nothing in Wave 1.
- **Make mainnet the Wave 2 story, and it is a strong one.** Mezo's own docs say
  testnet → mainnet for the x402 seller is a **one-line change**
  (`eip155:31611` → `eip155:31612`, plus set `PAY_TO` explicitly). On mainnet
  *both* legs are real: x402 in MUSD **and** a live sMUSD vault with ~7.4M sMUSD
  outstanding. That is a far better Wave 2 pitch than a testnet mock.
- Keep yield in the write-up as a **mainnet-only, explicitly-labelled** adapter
  with the non-4626 interface documented. That is a credibility win.

---

## 3. Trap: two tokens named MUSD on testnet

Confirmed live. Both answer `name()` = `Mezo USD`, `symbol()` = `MUSD`,
`decimals()` = 18. They are **not interchangeable**:

| Address | totalSupply | `mintList(0xCdF7028…beE5)` | `mintList(0xa14cbA6…1eba)` | Verdict |
|---|---|---|---|---|
| `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` | ≈ 523,782,988 | **true** | false | **Use this one.** In Mezo's contracts reference and in the x402 facilitator registry |
| `0xf9BBcCC0F1b68EA07c86de6F88C76b3d8E2dD0af` | ≈ 100,536,017 | false | **true** | A second, builder-deployed borrow system's token. x402 will not settle in it |

The `BorrowerOperations` proxies corroborate this: `0xCdF7028…beE5.musd()` →
`0x1189…Ac503`, while `0xa14cbA6…1eba.musd()` → `0xf9BB…D0af`.

**Two consequences for you:**

1. A public Wave 1 repo (`0xOucan/leek-stocks`) documents the *opposite*
   conclusion — that `0x1189…` is un-borrowable and `0xf9BB…` is canonical. That
   is true only for the BorrowerOperations instance *they* deployed. Do not copy
   their token address. Your test is the facilitator registry, and it says `0x1189…`.
2. **Assert the token address at runtime.** Do not trust an env var or a copied
   constant. Before the agent's first payment, verify the asset in the 402
   `PaymentRequirements` equals `0x1189…Ac503` and `network` equals
   `eip155:31611`. If your dashboard shows a balance for the wrong MUSD, your
   budget math is fiction — this is the single most likely way your demo silently breaks.

---

## 4. Gas: who needs BTC

Your assumption is correct for the agent, with one caveat:

- **Agent wallet (buyer): zero BTC required.** The facilitator sponsors every
  settle tx in native BTC (`eip2612GasSponsoring`), and authorization is a single
  EIP-712 permit2 signature with no on-chain approval. The agent wallet needs
  MUSD and a private key — nothing else. This is genuinely good for your pitch.
- **Your funding wallet: needs BTC.** Opening the trove to borrow testnet MUSD,
  and the plain ERC-20 `transfer` that moves MUSD into the agent wallet, are
  normal gas-paid transactions. Budget a faucet drip for this.
- **Seller side:** the hosted `facilitator.vativ.io` settles for you. Only if you
  run your own facilitator do you need gas headroom — Mezo gas estimation needs a
  modest multiplier, per Mezo's troubleshooting table.

---

## 5. Funding the agent wallet (do this on day 1)

MUSD on testnet is **minted, not faucet-dispensed**:

1. Drip testnet BTC to your funding account from `https://faucet.test.mezo.org`
   (or `#testnet` in Mezo Discord). This can be slow — start it first.
2. Borrow MUSD at `https://mezo.org/feature/borrow` with the wallet connected to
   Mezo Testnet. Docs say you should end up with ≥ 1,800 MUSD.
3. Transfer a fixed budget (e.g. 50 MUSD) to the freshly generated agent wallet.
4. Verify on `https://explorer.test.mezo.org/address/<agent>` that the token
   showing is `0x1189…Ac503` and not the impostor.

Then pay the hosted demo `https://demo.vativ.io/` ($0.001) as a smoke test before
writing a line of your own server code. Mezo is emphatic about this and they are
right: a broken wallet looks identical to a broken server otherwise.

---

## 6. Known dependency landmines

Straight from Mezo's troubleshooting table — these cost builders real time:

- **Pin `@x402/*` to one version and add package-manager overrides.** A
  transitive dep pinning `@x402/paywall`/`@x402/evm` below your target network's
  minimum produces `does not provide an export named 'DEFAULT_STABLECOINS'`, or
  a paywall showing `$10000000000.00` instead of `$0.001` (older SDK formats
  MUSD as 6-decimal USDC). Override **both** packages together —
  `@x402/paywall` imports `DEFAULT_STABLECOINS` from `@x402/evm`.
  ```json
  "pnpm": { "overrides": { "@x402/paywall": "^2.28.0", "@x402/evm": "^2.28.0" } }
  ```
- **`@solana/kit@6.10.0` install failure.** `@x402/paywall` pulls a transitive
  Solana SDK whose 6.10.0 release references unpublished sub-packages. EVM-only
  builds never use it but it still resolves. Override to `"@solana/kit": "6.9.0"`.
- **Network string must be CAIP-2.** `'eip155:31611'` exactly. `'mezo-testnet'`
  and bare `31611` are both rejected.
- **EIP-712 domain name is `Mezo USD`, version `1`** — not the `MUSD` symbol.
  Hand-rolling this wrong fails signature verification with no useful error.
  Let the SDK supply it via `getDefaultAsset`.
- **`PAY_TO` silently falls back** to the hosted demo's receiving address
  (`0xC337…e738`) if unset. Payments "work" and your merchant never gets paid.
  There is no format guard. Always set it explicitly.
- **Wallet chain ID must be decimal 31611**, and the RPC must be the testnet RPC.
  A testnet chain ID against a mainnet RPC gives you a network that looks real
  and holds nothing.
- **The facilitator's signer addresses rotate.** Observed live: three different
  signer pairs across five calls to `facilitator.vativ.io/supported` within
  ~30 seconds (`0x5Bd6DD7c…`/`0x7B384430…`, then `0x66cD2e73…`/`0x02AC5CfD…`,
  then `0x9984b3eE…`/`0x23fe3046…`). **Do not hardcode these anywhere.** In
  particular, do not verify a payment receipt by checking that the settling tx
  sender matches a pinned signer list — that check will start failing at random.
  Verify receipts against the MUSD `Transfer` log (from = agent wallet,
  to = your `PAY_TO`, token = `0x1189…Ac503`) and the settlement tx hash returned
  in the `PAYMENT-RESPONSE` header. The settlement **proxy**
  (`0x402085c248EeA27D92E8b30b2C58ed07f9E20001`) *is* stable and is the address to
  key on.
- Node.js 20+, pnpm 9+.

---

## 7. Buildathon facts

| | |
|---|---|
| Programme | 3rd Mezo Buildathon, with AKINDO, powered by Supernormal Foundation |
| Started | Friday **October 16, 2026** |
| Runs through | **November 15, 2026** |
| Prize pool | **$7,000 in MEZO** across two waves |
| **Wave 1** | Oct 16–26, **$2,000 MEZO**, submissions due **Oct 26 at 11:00** (AKINDO countdown) |
| **Wave 2** | Nov 2–15, **$5,000 MEZO**, final submissions Nov 15 |
| Winners | **November 23**, announcement + online demo session |
| Tracks | **1. DeFi** (borrowing, lending, looping, yield) · **2. Access & Distribution** (discover, access, use) |
| Requirement | Must integrate **MUSD and/or MEZO** and include a **working deployment** |
| Allowed networks | **Mezo, Ethereum, Base, or BNB Chain** — *"Mezo testnet submissions are welcome too"* |
| Competition | 27 Wave 1 submissions already listed on AKINDO as of Oct 21 |

**Your remaining runway: roughly 5 days from today (Oct 21).**

### One network note

x402-in-MUSD is **Mezo-only**. The facilitator supports exactly `eip155:31611`
and `eip155:31612`. Deploying the agent-payments leg on Base or Ethereum would
mean a different facilitator and a different asset (USDC), which kills the MUSD
integration. Mezo testnet is the right and only choice for your core flow. The
broader network allowance matters only if you later add a non-x402 component.

### Differentiation pressure

Two public Wave 1 entrants overlap your space: `elon00/qmoosa-mezo`
("Autonomous AI Payment & DeFi Hub", MUSD/x402, $0.001 sub-cent micropayments on
testnet) and `0xOucan/LeekWallet` (signing wallet, Track 2). Your honest
differentiator is the **policy layer** — budget caps, approved-endpoint
allowlist, pause, receipts — not the payment itself. Lead the pitch with the
control panel, and say plainly that Mezo's own quickstart already proves the
payment leg. Judges reward that clarity.

---

## 8. Recommended Wave 1 scope (5 days)

Your MVP as written is too big for 5 days if the budget policy is on-chain.
Cut in this order.

**Keep — this is the submission:**
1. Agent wallet: generated keypair, funded with a fixed MUSD budget, **zero BTC**.
2. Seller: fork `vativ/mezo-hack/apps/humor`, swap `GET /joke` for your own
   paywalled route. Keep the middleware wiring verbatim. Set `PAY_TO`.
3. Agent client: `@x402/fetch` wrapped client, key from env, asserts token =
   `0x1189…Ac503` and network = `eip155:31611` before signing.
4. **Policy gateway** (the differentiator): a thin layer the agent must pass
   through before it is allowed to sign. Enforces per-call max, daily limit,
   approved-endpoint allowlist, and a pause flag. Off-chain, in your own service.
5. Dashboard: budget remaining, per-endpoint caps, payment log with explorer
   links to real settlement txs, pause toggle.

**Cut from Wave 1, promise in Wave 2:**
- sMUSD vault adapter (impossible on testnet — see §2).
- On-chain policy enforcement.
- Service discovery / provider directory.
- Telegram monitoring.

### On-chain vs off-chain budget enforcement

Be honest about this in the write-up; it is the first technical question a judge
will ask.

- **Wave 1 (off-chain gateway):** the agent key sits in your service, the
  gateway refuses to sign anything over the cap. Fast to build, easy to demo,
  and the hard cap is still real: *the wallet cannot spend more than its
  balance.* Weakness: the gateway is trusted, and a leaked key bypasses it.
  Say so explicitly rather than letting a judge find it.
- **Wave 2 (on-chain policy):** MUSD is `permit2` + EIP-2612, so the agent
  wallet can sign permits **gaslessly** naming a `BudgetVault` contract as
  spender. The contract enforces per-call max, daily cap, payee allowlist and
  pause, and is the only address that can move the funds. The agent key becomes
  unable to overspend even if compromised. This is a genuinely good Wave 2
  deliverable and a clean Track 1-adjacent upgrade.
- The interim middle ground is an **allowance cap**: approve the policy contract
  for exactly the daily limit, re-set each day. One approval tx from the funding
  wallet, no new contracts, and it bounds blast radius today.

### Security posture you already got right

Not giving an LLM the user's main-wallet key, and bounding total exposure by the
agent wallet's balance, is the correct design and worth a paragraph in the
submission. Keep the agent key in the service env, never in the browser, never in
the LLM context.

---

## 9. Suggested 5-day plan

| Day | Do | Exit criterion |
|---|---|---|
| **Oct 21 (today)** | Faucet BTC → borrow MUSD → pay `demo.vativ.io` $0.001 → generate agent wallet → transfer 50 MUSD budget | Explorer shows the smoke-test transfer out of your funding wallet, and 50 MUSD of `0x1189…Ac503` in the agent wallet |
| **Oct 22** | Fork `apps/humor`. Seller route live locally. Agent client pays it end to end with `@x402/fetch` | Unpaid `curl` → 402; agent call → 200 + real settlement tx in explorer |
| **Oct 23** | Policy gateway: per-call max, daily limit, endpoint allowlist, pause. Agent refuses to sign when blocked | Demo a blocked call and a pause, with the reason surfaced in the UI |
| **Oct 24** | Dashboard: budget, caps, payment log with explorer links, pause control. Deploy seller + dashboard to a public URL | A stranger can open the URL and watch the agent spend, hit a cap, and get paused |
| **Oct 25** | 2–3 min demo video, README with the verified-address table from §1 and §3, honest limitations section, AKINDO submission drafted | Submission complete, buffer day remaining |
| **Oct 26** | Submit before **11:00**. Post the build in Mezo Discord | Submitted |

Deploy the seller and dashboard somewhere public. A judge who has to run your
repo locally will often not bother.

---

## 10. Copy-paste constants (verified 2026-10-21)

```
NETWORK_TESTNET      eip155:31611          (chain id 31611, decimal — not 0x7B7B)
NETWORK_MAINNET      eip155:31612          (chain id 31612)
RPC_TESTNET          https://rpc.test.mezo.org
WSS_TESTNET          wss://rpc-ws.test.mezo.org
EXPLORER_TESTNET     https://explorer.test.mezo.org
FAUCET               https://faucet.test.mezo.org
TESTNET_DAPP         https://testnet.mezo.org
FACILITATOR          https://facilitator.vativ.io     (serves both networks)
SETTLEMENT_PROXY     0x402085c248EeA27D92E8b30b2C58ed07f9E20001   (same both nets)

MUSD_TESTNET         0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503   ← x402 settles in this
MUSD_MAINNET         0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186
MUSD_IMPOSTOR        0xf9BBcCC0F1b68EA07c86de6F88C76b3d8E2dD0af   ← never use, x402 rejects it

BORROWER_OPS_TESTNET 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5   (musd() -> 0x1189…Ac503)
EIP712_DOMAIN        name "Mezo USD", version "1"
DECIMALS             18
GAS_SPONSORING       eip2612GasSponsoring (buyer pays no gas)

SAVINGS_VAULT        0xb4D498029af77680cD1eF828b967f010d06C51CC   MAINNET ONLY — not on testnet
VAULT_IMPL_MAINNET   0xb33c3f97bf3b7df59417d114c694353e42929e87   (EIP-1967)
VAULT_INTERFACE      deposit(uint256), withdraw(uint256), token() — NOT ERC-4626
RPC_MAINNET          https://mezo-mainnet.boar.network
                     https://mezo.drpc.org
                     https://rpc_evm-mezo.imperator.co
EXPLORER_MAINNET     https://explorer.mezo.org
```

---

## 11. Revised submission TL;DR

> **AgentFloat** gives an AI agent a dedicated MUSD wallet on Mezo and a
> human-set spending policy — per-call max, daily cap, approved-endpoint
> allowlist, and a pause button. The agent pays for HTTP services through x402,
> where Mezo's facilitator sponsors gas, so the wallet needs MUSD and nothing
> else. Every payment is logged with its on-chain settlement receipt.
>
> Every user gets their own wallet behind a Google or email login, and **sets
> their own caps**: they sign an authorization from that wallet and the protocol
> applies it on chain inside a published ceiling, so an agent can never raise its
> own limit. Sellers that send no CORS headers are paid through a relay that
> moves only the HTTP hop — the permit2 signature is still produced in the user's
> browser. Payments, refusals, budget changes and a low-balance warning are
> pushed to Telegram, bound to a wallet by signature.
>
> Live on Mezo Testnet (`eip155:31611`) settling in MUSD. Because Mezo's docs
> make testnet → mainnet a one-line change, Wave 2 moves the same agent to
> mainnet and adds the surplus-sweep adapter for Mezo's MUSD Savings Vault —
> a mainnet-only product issuing transferable sMUSD at a variable,
> non-guaranteed rate, with a non-ERC-4626 interface we integrate directly.
>
> **Category:** AI payments, treasury automation
> **Track:** Track 2 — Access & Distribution (Wave 1); Track 1 DeFi extension in Wave 2

The change from your draft: the vault is named as mainnet-only and the yield is
labelled variable and non-guaranteed, which is both accurate and what Mezo's own
docs say. Claiming testnet sMUSD would be the one thing in this submission a
judge could falsify in thirty seconds.

---

## 12. Post-brief changes (v0.2, 2026-10-21)

This brief was written before the deployment. Everything above is still accurate
as research, but the project has since been deployed, paid for real on testnet,
and restructured. This section records what changed so the brief does not
mislead.

### Structure: `server/` moved to the repo root

The gateway used to live at `frontend/server/`. It is a backend, not part of the
React app, so it now lives at `server/`, alongside `contract/` and `frontend/`.
A root `package.json` orchestrates all three.

```bash
npm run install-all   # every workspace
npm run dev           # gateway (4022) + dashboard (5173)
```

Five things had that path hardcoded and were updated with the move:

| File | What changed |
|---|---|
| `server/agent-gateway.js` | `CONTRACTS_DIR` gains a `frontend` segment; `.env` is now loaded by **absolute path** |
| `contract/scripts/setup-agent.js` | `GATEWAY_ENV` → `../../server/.env` |
| `contract/scripts/grant-permit2.js` | same |
| `frontend/package.json` | `gateway` script → `node ../server/agent-gateway.js` |
| `.gitignore` | `frontend/server/.env` → `server/.env` |

Two of those are worth calling out as traps in their own right:

- **`.env` loading.** The gateway used `import "dotenv/config"`, which reads
  `process.cwd()`. That only worked because you happened to `cd` into the folder
  first. Run it from anywhere else and it silently loaded nothing — no error,
  just `⚠️ AGENT_PRIVATE_KEY missing/invalid` and an unarmed gateway. It now
  resolves `.env` from `__dirname`.
- **`.gitignore`.** Missing that one line makes the agent private key
  committable. It is the only change in the move with a security consequence.

### Frontend: Tailwind v4 + routing + pages

Hand-written CSS replaced by Tailwind v4 (configured in `index.css` via `@theme`,
no `tailwind.config.js`). The single scrolling dashboard became seven routed
pages: Home (landing), Dashboard, Spend, Ledger, Faucet, Operate, How it works.

The palette is the original one, carried into `@theme` tokens so the product kept
its identity.

### Multi-user via Privy

Google/email sign-in creates a per-user **embedded EOA** agent wallet — once per
identity, reattached on later logins. This is the single biggest architectural
change: the product no longer assumes one operator-owned agent.

Privy fits only because its default embedded wallet is an **EOA**. x402
authorizes with an EIP-712 permit2 signature, which a contract wallet cannot
produce. So the config must avoid smart wallets and gas sponsorship (the latter
delegates via EIP-7702, giving the address contract code). See §8's note on why
the agent wallet is an EOA — that reasoning now constrains the auth provider too.

**Dependency landmine (add to §6):** Privy pulls WalletConnect, the MetaMask SDK
and a Solana tree — `frontend/node_modules` reaches ~1.5GB. Statically importing
it got Vite's esbuild dep pre-bundler OOM-killed and made `vite build` exhaust the
heap. Fixes, both required:

- `React.lazy(() => import("./lib/PrivyLayer.jsx"))` in `main.jsx`, so Privy is a
  separate chunk loaded only when `VITE_PRIVY_APP_ID` is set
- `optimizeDeps.exclude: ["@privy-io/react-auth", "@x402/fetch", "@x402/evm"]`
- `@solana/kit` overridden to `6.9.0`, as already noted in §6
- `viem` pinned to `2.56.5` — `@privy-io/ethereum` requires that exact version

Production builds need ~4GB of free RAM. `npm run dev` does not bundle and is
unaffected.

### Faucet

New: 10 MUSD per wallet per 48h, from the operator balance, with the wallet
registered as a treasury agent on first claim. Because it spends real funds it is
guarded by a server-issued nonce plus a signature the server recovers and
compares, a persisted per-address cooldown, and global daily/total caps.
`server/faucet-test.js` asserts all of it, including forged and replayed claims.

### Ledger integrity — the most important lesson

§8 assumed the gateway's HTTP response told you whether a payment succeeded. On
testnet it does not, in **both** directions:

- a 412 rejection was recorded as a `PaymentRecorded` for money that never moved
- a settlement that *did* move MUSD on chain was recorded as a denial, because
  the seller answered HTTP 402 anyway

The gateway now verifies against the MUSD `Transfer` logs before classifying
anything. If you take one thing from this brief into Wave 2, take this: **the
chain is the only authoritative record of whether a payment happened.** The
append-only ledger has no delete function, so the two rows written before the fix
are still there, badged `unverified` in the UI.

Current live state, transaction hashes and a full reconciliation are in
[`LIVE-DEPLOYMENT.md`](./LIVE-DEPLOYMENT.md).

---

## 13. Wave 1 additions (v0.3, 2026-10-23)

§8 scoped Wave 1 as "caps + payments + ledger". Three of the things that turned
out to matter were not in that scope, and all three came from treating this as an
app that people other than its author will use. Everything below is implemented,
and the parts that touch the chain are verified with transaction hashes in
[`LIVE-DEPLOYMENT.md`](./LIVE-DEPLOYMENT.md) §Wave 1 additions.

### Self-service budget: the permission model was wrong

§8 put `setAgentLimits` behind `onlyOwner` and stopped there, which in a
single-operator demo is fine and in a multi-user app is a dead end: every control
on `/operate` needed the treasury owner, so a user who had just created an agent
wallet saw a page of disabled buttons and no reason anywhere.

The constraint is real and stays — an agent that can raise its own ceiling is not
budget-controlled, so `setAgentLimits` remains `onlyOwner`. What changed is who
gets to *ask*:

1. the gateway issues a nonce **and the exact message**, with the requested values
   already inside it;
2. the user signs it with their own agent wallet (Privy prompt; the key never
   leaves the TEE);
3. the gateway recovers the signer, burns the nonce **before** the transaction,
   and refuses on any mismatch — then applies the change with the owner key,
   inside a published ceiling (5 MUSD per call, 50 MUSD a day, `dailyCap ≥
   perCallMax`), rate limited because every change costs the operator real gas.

Same shape as a bank letting you set your own card limits up to a product
maximum. The values applied are exactly the values signed; nothing in the second
request is trusted but the signature. `action=freeze|unfreeze` reuses it for
`setAgentActive`, with its own message text so a `limits` signature cannot be
replayed as a freeze.

### The relay: browser signs, gateway fetches

§8 assumed a browser could pay any seller. It cannot: most paid APIs send no
`Access-Control-Allow-Origin`, so the unpaid probe fails with `Failed to fetch`
before anything can be signed — including Mezo's own hosted demo, the
third-party seller this project pays. The identical quote through the gateway
worked, which is exactly what makes it look like an app bug.

So the two halves were separated. `POST /api/relay/probe` returns the filtered
402 headers, the body, the decoded offer and the policy verdict; the browser
turns that into a permit2 payload with `x402HTTPClient` (the signature is
produced locally, and the gateway cannot produce it); `POST /api/relay/execute`
re-checks the URL, reads the payer and the price out of the payment itself,
refuses what it cannot read, requires the payer to equal the claimed agent
(`403 payer_mismatch`), applies the caps, fetches with the payment header the
client named, and proves settlement from the MUSD `Transfer` logs before
recording it.

**Paying through it found two bugs that nothing else could.** The first relayed
attempt took 31 s, returned 502 `no MUSD moved`, and left `paymentCount`
unchanged — while `POST /api/pay` for the same quote settled in seconds next to
it. Cause one: the relay hardcoded `X-PAYMENT`, which is x402 **v1**; Mezo's
facilitator and its hosted demo speak **v2**, where the payment travels as
`PAYMENT-SIGNATURE`. `encodePaymentSignatureHeader()` returns a *map* precisely so
the caller does not have to know, and the relay now forwards that map, filtered to
the two protocol names so nothing else can be smuggled through the operator's
machine. A header the seller never reads raises no error anywhere — it just
answers 402 again. Cause two: the gateway read the payer from `payload.payer` and
the price from `payload.paymentRequirements`, neither of which exists. v2 keeps
them in `payload.permit2Authorization.from` and `accepted.amount`; v1 keeps the
requirement in an *array*. The guard was `if (payer && mismatch) deny`, which
fails **open** on a payload it cannot parse, and an unreadable price fell back to
`0` — under every cap. Both are now refused before anything is fetched (422
`payer_unverifiable` / `amount_unverifiable`), and the ledger still carries the
two denials recorded at `attempted: 0` as the fingerprint.

The user-facing half had its own version of the same mistake:
`createWalletClient({ account: ADDRESS })` yields a viem JSON-RPC account —
`{ address, type }`, data only — and that is what was handed to
`registerExactEvmScheme()`, which asks for `{ address, signTypedData }`. The
wallet was connected, the quote was right, and paying died with
`signer.signTypedData is not a function`: an error naming a function instead of a
cause. `schemeSigner()` now binds the methods on the *client*. A
`privateKeyToAccount` LocalAccount already has them, which is why the gateway
never hit this and no server-side test could — so `npm run test:x402` drives the
browser path in Node against a fake EIP-1193 provider that records every call.

The relay has now paid Mezo's hosted demo for real: settlement tx
[`0x10d392de…c770`](https://explorer.test.mezo.org/tx/0x10d392de6d8199606983459c362aa26dd7f24f73849b2d16daf091a2428fc770),
0.001 MUSD out of the agent wallet, `paymentCount` 11 → 12, receipt `status 1`,
seller body `{"ok":true,"message":"Paid! You unlocked the Mezo x402 Quickstart."}`.

A public relay endpoint is an SSRF hole without guards, so `server/relay.js`
judges **protocol → allowlist → DNS/private-range**, in that order: https only
(http for the gateway's own origins alone), `ALLOWED_ENDPOINTS` checked before any
lookup so an unlisted host is never resolved, IP literals judged as written and
hostnames resolved with `dns.lookup(..., {all:true})` with *every* address judged
(a name blocklist is bypassed by DNS rebinding), plus `redirect: "manual"`
because a redirect is an unchecked second URL, a 512 KB body cap and a 20 s
timeout. The honest cost is recorded in the UI and the docs: a relayed hop is a
privacy hop, so it is per-purchase, labelled, and never the only path.

### Telegram alerts

Deferred to Wave 2 in §8, pulled into Wave 1 because a cap you must watch a
dashboard to see working is not much of a cap. Payments, refusals, budget
changes, freezes, faucet claims and a once-per-UTC-day "20% of your daily cap
left" warning are pushed to Telegram.

No webhook — the gateway runs on a laptop behind NAT with no public URL — so it
long-polls `getUpdates`, treats a 409 as "another poller exists" (loud log, 60 s
backoff), and binds a chat only against a wallet signature over a
gateway-authored message. Codes are 8 characters, single-use, 15 minutes, one
live code per address. Per-chat rate limit 15/min. Delivery is fire-and-forget so
an alerting outage can never fail a payment, and the send log is shown in the UI
so "silently dropped" is visible. A watcher diffs on-chain counters per
subscriber, so an event the gateway never saw — a payment settled straight from a
browser — still alerts.

With no `TELEGRAM_BOT_TOKEN` every endpoint answers 503 with the BotFather hint
and the page shows the setup steps. **Nothing is simulated**: a notification that
was never sent is worse than none, because the user believes it was.

The binding itself lands on the *gateway* — its long-poll sees `/start <code>` —
so nothing tells the page it happened. `/alerts` therefore polls
`/api/telegram/status` while a code is outstanding (first check after 1.5 s, then
every 4 s, stopping the moment it lands or the code expires) and flips to
**connected** on its own. A user who does what the app asked should not have to
reload to be told it worked.

### The rest of the UI caught up

`/operate` is now two zones with a labelled divider (your budget, then
owner-only — and for a non-owner an explanation, not a wall of disabled buttons);
`/spend` offers the relay as the default with "direct from browser" kept as a
labelled alternative; `/ledger` gained a **mine / all wallets** filter with a
`yours` badge, because a protocol-wide table is correct but not useful to someone
with three payments; `/faucet` reads your caps back from the contract after a
claim; `/architecture` states the relay's cost and the alert flow plainly;
`/alerts` is new. The state you see before the first page renders became a single
shared indicator — `lib/RingSpinner.jsx`, a turning ring, plus a `BootScreen` that
names the provider loading and warns that Google sign-in is slower the first time
— because a pulsing dot on a blank screen reads as a hang, and an inline copy in
`index.html` covers the moment before React mounts. `useAgentStatus()` moved to
`src/lib/agent-status.jsx` so five
pages share one read and one copy of the subtle part — `agentStatus()` reverts for
an unregistered wallet, and that revert means "new user, no float", not failure.

### Testing

`npm run test:gateway` — **138 offline assertions**, no chain, no token, no
network: the SSRF guard (including a public-hostname *allow* case, which is what
found the hostname bug above), guard ordering, 402 decode/inspect against the
**real** v1 and v2 payload shapes a wallet signs — v2 permit2, v2 EIP-3009, v1's
requirement array, and the two payloads that can be neither attributed nor priced,
which must come back unreadable — `paymentHeadersFrom()`'s version-dependent header
naming and its allowlist, ceiling derivation, real signature round-trips against a
random `ethers.Wallet` including an attacker key, a tampered message and a
cross-action replay, and the alert renderer's escaping.

`npm run test:browser` adds **90** for code that cannot be reached without a real
login: the network switch/add state machine (61) and the browser half of an x402
payment (29), driven against a fake EIP-1193 provider and a stubbed `fetch`, so
402 → signature → `PAYMENT-SIGNATURE` on the second request → resource returned
runs with no browser, no Privy and no network.

With the 40 contract tests and 15 faucet assertions that is **283 automated
offline checks**, and `check:client` adds 46 named patterns across 24 files, each
regression-tested both ways — every one of the nine assertions added this round
was verified to fail when the code it protects is broken.

`npm run test:relay` is the live one: 20 checks that pay a real seller through the
relay and then submit a stranger's payment, an unattributable payment, a 999 MUSD
price and an empty header map, asserting each is refused **and** that no MUSD
moved. It costs 0.001 MUSD per run, so it is deliberately not part of
`npm test`.

---

## 14. Wave 1.5 (v0.4, 2026-10-25) — self-service approval, gas, automation

Three additions and one correction, all verified on testnet.

**1 · The Permit2 approval is granted from the page.** The refusal
`permit2_not_approved` used to print `cd contract && node scripts/grant-permit2.js` —
a command no signed-in user can run, and one that could not work for a Privy embedded
wallet in principle (the key never leaves the enclave). `components/ApprovalModal.jsx`
now offers **this payment only** or **all future payments**, is mounted on `/spend`,
the dashboard rail and `/faucet`, and the refusal carries
`action: "approve_permit2"` so a UI can act on it. Sent as a raw
`eth_sendTransaction` with no gas fields; confirmed by polling the allowance.

**2 · Gas for that approval.** A new wallet holds MUSD and no BTC, so the approval
would fail on gas. `server/gas.js` drips a capped dust amount from the operator key
(nonce + signature, registered wallets only, 24 h cooldown, 0.005 BTC/day, 0.02 BTC
total, 0.01 BTC reserve) and the popup always shows Mezo's own faucet as the
zero-cost alternative. "Needs gas" is derived from the live cost — `gasPrice ×
60 000 × 50`, floored at 1e-8 BTC — because a hardcoded threshold declared a wallet
that had just been dripped to still need gas. One drip ≈ 5.7 million approvals.

**3 · Automated spending on `/spend`.** After a quote, **Pay once** or **Run
automatically**: repeat that purchase on a schedule, with a projection of which run
the cap will refuse, a live gauge, and a run log that separates what moved from what
was attempted. The loop stops itself and never retries a budget refusal. All the
arithmetic is pure (`lib/autopay.js`, 110 offline assertions) and the loop calls the
same `purchase()` the Pay button does.

**4 · The correction: the daily cap was not a cap on spending.** The treasury's
`remainingToday` is `dailyCap - dayFunded` — how much more *float* may be released
today — and the gateway was comparing *payments* against it. Eight live purchases of
0.001 MUSD went through a 0.005 MUSD cap with no refusal. Daily **spend** is now
summed from the treasury's own receipts in `server/spend.js` (UTC day from the chain's
block timestamp, newest-first scan, fails closed on an unreadable or truncated
window), and every policy answer carries the `budget` it was judged with. The
contract's counter is still reported, as `fundingHeadroomToday`, and every UI label
that called it "Left today" now says **Funding left today**. Proven live by
`npm run test:autopay:live`: five purchases, 0.005 MUSD, sixth refused, denial on
chain, funding counter unmoved.

**For the video:** `WALKTHROUGH.md` in the repo root is a 3-minute shooting script —
timecodes, click paths, narration verbatim, the numbers to set beforehand (daily cap
0.005 MUSD, per-call max 0.002, quote 0.001), and what to say if the seller misbehaves
on camera.

---

## 15. Hosting it: gateway on Render, frontend on Vercel (v0.5, 2026-10-25)

The split works, and the relay gets **better** on Render rather than worse — a
server-to-server fetch has no CORS at all, so a seller that a browser could never
reach is reachable from the gateway. But the two halves need each other's address,
and that is the only genuinely awkward part. Everything below is verified, not
planned.

### 15.1 The order that avoids guessing

Each side needs a value only the other side can supply:

| side | needs | from |
|---|---|---|
| frontend build | `VITE_GATEWAY_URL` | the gateway's Render URL |
| gateway | `GATEWAY_ALLOWED_ORIGINS` | the frontend's Vercel domain |

So one of them deploys twice. Do it in this order and the second deploy is a
one-line edit rather than a rebuild mystery:

1. **Deploy the gateway first.** Push the repo, Render → New → Blueprint → pick the
   repo; `render.yaml` creates the service, the 1 GB disk and every non-secret env
   var. Set the three secrets in the dashboard (`AGENT_PRIVATE_KEY`,
   `GATEWAY_SIGNER_PRIVATE_KEY`, `GATEWAY_ADMIN_TOKEN`) plus `SELLER_PAY_TO`.
   Leave `GATEWAY_ALLOWED_ORIGINS` at the wildcard `https://*.vercel.app` for now.
2. **Check it is actually up:** `curl https://<svc>.onrender.com/api/health`. On the
   free tier this is also the cold-start test — the first request after ~15 idle
   minutes takes 30–60 s.
3. **Deploy the frontend.** Vercel → Import → set **Root Directory `frontend`**,
   framework Vite, output `dist`. Add `VITE_PRIVY_APP_ID` and `VITE_GATEWAY_URL`
   (`https://<svc>.onrender.com`, no trailing slash).
4. **Add the Vercel domain to Privy's allowed origins** — Auth → Allowed Origins.
   Without this the login modal loads and then fails, which looks exactly like the
   stale-bundle symptom in `npm run check:client`.
5. **Tighten the allowlist.** Replace the wildcard in Render with the exact origin
   (`https://agentfloat.vercel.app`), redeploy, re-test. The wildcard is for the
   window in which the domain is still settling, not the end state.

`vercel.json` cannot read environment variables, so a rewrite there is not an
alternative to `VITE_GATEWAY_URL` — it can only point at a hardcoded host.

### 15.2 What changed in the code to make this possible

Six things were blocking, and all six are fixed and tested (`npm run test:deploy`,
55 assertions that boot the real gateway as a child process in both modes and
assert over HTTP):

1. **The gateway ignored `process.env.PORT`** and bound `127.0.0.1`, so a PaaS
   could not route to it. Now `PORT` → `GATEWAY_PORT` → 4022, and `GATEWAY_HOST`
   → `127.0.0.0` when set.
2. **Every client call was relative** (`/api/…`), which only works behind the Vite
   dev proxy. `GATEWAY_BASE` is now derived from `VITE_GATEWAY_URL`, and a
   cross-origin failure names `GATEWAY_ALLOWED_ORIGINS` in the error rather than
   reporting a bare "Failed to fetch".
3. **`cors()` was wide open** *and* `/api/pause` + `/api/unpause` were
   unauthenticated — a public gateway could be paused by anyone who found the URL,
   with one POST. Both are now behind `GATEWAY_ALLOWED_ORIGINS` and
   `requireAdmin`.
4. **The wildcard matched the shared apex.** `https://*.vercel.app` compiled `*.` to
   zero-or-more labels, so `https://vercel.app` itself was accepted — i.e. every
   stranger's Vercel deploy could call a gateway holding a signing key. It now
   compiles to `(?:[a-z0-9-]+\.)+`, one-or-more, and `test:deploy` pins it.
5. **State files lived beside the code.** Render's filesystem is ephemeral, so
   every deploy wiped the faucet cooldowns (making a restart a way to claim again),
   the gas-drip caps, the self-service budget audit trail and every Telegram
   binding. `STATE_DIR` points the four `*-state.json` files at the disk. Note: a
   free-tier service cannot attach a disk — expect the reset there.
6. **`render.yaml` had an invalid `disk.sync: false`**, which is an envVar-only key.

### 15.3 Key handling on a host you do not control

Render shows env vars to everyone with dashboard access. Therefore:

- **Never put the treasury owner's key in `AGENT_PRIVATE_KEY`.** That key holds the
  BTC gas reserve and can `emergencyStop` the protocol. Use a fresh throwaway agent
  key funded with ~1 MUSD.
- `GATEWAY_SIGNER_PRIVATE_KEY` signs receipts and, on testnet, is the deployer key
  that also owns the treasury — which is what makes self-service caps, the faucet
  and the gas drip work at all. Give it a little BTC. On mainnet these must be
  separate wallets.
- **`VITE_GATEWAY_ADMIN_TOKEN` is not a lock.** Any `VITE_`-prefixed value is
  inlined into the shipped bundle, so publishing the admin token there hands the
  pause switch to every visitor. Leave it unset; `/operate` detects
  `deployment.adminLocked` from `/api/health`, disables the gateway pause with an
  explanation, and offers the on-chain `pause()` — which needs the owner wallet and
  survives a restart — as the real remedy.

### 15.4 Verified from a browser on the deployed shape

| Origin sent to the gateway | result |
|---|---|
| `https://agentfloat.vercel.app` | 200, `Access-Control-Allow-Origin` echoed |
| `https://abc123.vercel.app` | 200 (wildcard matches a subdomain) |
| `https://a.b.vercel.app` | 200 |
| `http://localhost:5173` | 200 (loopback always allowed) |
| `https://vercel.app` | **403** — the apex is not a subdomain |
| `https://agentfloat.vercel.app.evil.com` | **403** — suffix spoof |
| `https://evil.com/https://agentfloat.vercel.app` | **403** — path spoof |
| `null` (sandboxed iframe) | **403** |
| `http://agentfloat.vercel.app` | **403** — scheme downgrade |
| no `Origin` header at all | 200 — server-to-server callers are unaffected |

A refusal is 403 with `{ error: "origin_not_allowed", origin, allowedOrigins,
detail }` and no `Access-Control-Allow-Origin`, so the browser reports it as a CORS
failure and the gateway log carries a `⛔ cors:` line naming the refused origin.
Preflight (`OPTIONS`) answers 204 with `PAYMENT-RESPONSE`, `X-PAYMENT` and
`PAYMENT-SIGNATURE` exposed, `Vary: Origin`, and never `Allow-Credentials`.

**Local development is unchanged and needs no configuration:** with no
`GATEWAY_HOST` the gateway binds loopback, the allowlist is not enforced, and
`npm run dev` works exactly as before.
