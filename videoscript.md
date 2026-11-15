# AgentFloat Wave 2 — Demo Video Script (≤ 2:15)

**Target: 2:08**  
**Do not exceed 2:15**

Prep before record:
- [ ] Fresh session (or logged out)
- [ ] Agent has a little MUSD + BTC gas
- [ ] Permit2 not yet approved (so Enable payments is visible) OR already approved (skip to pay)
- [ ] Telegram already linked on phone (or link mid-demo if fast)
- [ ] Built-in seller URL ready on Spend
- [ ] Browser zoom 110–125%; hide bookmarks bar
- [ ] Second screen/phone for Telegram notification

---

## [0:00–0:12] HOOK (12s)

**Visual:** Home page + title card “AgentFloat — Wave 2 / Mezo Testnet”

**VO:**
> “AI agents need to pay for APIs — without holding your keys or blowing your budget.
> AgentFloat gives every agent a capped MUSD wallet on Mezo: on-chain limits, x402 payments, and idle float earning in sMUSD.”

---

## [0:12–0:28] CONNECT + SESSION (16s)

**Visual:** Click Connect (Reown) → pick wallet → **Authenticate Session** → sign EIP-191 → dashboard shows primary + agent address.

**VO:**
> “I connect with Reown and sign one challenge. The gateway provisions an isolated agent EOA — key encrypted server-side. My primary wallet never signs a payment.”

**On-screen callout:** `primary 0x7623…` · `agent 0x24A6…`

---

## [0:28–0:48] EARN + sMUSD (20s)

**Visual:** Earn page — show agent MUSD balance → point at Savings / sMUSD vault balance → (optional) short fund or “already swept” state. Flash explorer tab of vault `0x6f461c…8e16`.

**VO:**
> “Wave 1 used an operator faucet. Wave 2 funds from my wallet — or a BTC trove via BorrowerOperations. Idle float is swept into Mezo’s testnet sMUSD savings rate so the agent earns while it waits.”

**On-screen callout:** `sMUSD 0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16`

---

## [0:48–1:08] ENABLE PAYMENTS (20s)

**Visual:** Spend page → yellow “Enable payments” → click → tx submits (server-side Permit2) → banner turns green.

**VO:**
> “One click enables Permit2. The gateway decrypts the agent key in memory, submits approve on-chain, and discards it. No permit popup on every call.”

---

## [1:08–1:32] PAY + POLICY (24s)

**Visual:** Built-in seller preset `/paid/insight` → Quote (show amount + policy allowed) → **Pay** → success receipt with settlement tx. Optional: show Operate cap briefly.

**VO:**
> “The judge’s High finding on Wave 1: pay was unauthenticated and could sign a different quote than it checked. Wave 2 binds amount, asset, and payTo, requires a session, rate-limits, and enforces daily spend from on-chain receipts — then settles x402 in MUSD.”

**On-screen callout:** `requireSession · quote binding · daily cap`

---

## [1:32–1:48] TELEGRAM (16s)

**Visual:** Phone / Telegram window — payment alert arrives (“Agent paid 0.001 MUSD…”). Quick cut to Alerts page “Connected”.

**VO:**
> “The same second, Telegram notifies me: payment, payee, and what’s left of today’s cap. Refusals, vault moves, and budget changes land here too.”

---

## [1:48–2:00] LEDGER + TREASURY (12s)

**Visual:** Ledger page (gateway + chain receipt) → cut to explorer treasury page.

**VO:**
> “Every settlement is on the ledger and optionally on-chain. Treasury is verified on the Mezo explorer — caps survive even if the gateway doesn’t.”

**On-screen:** full treasury URL  
`https://explorer.test.mezo.org/address/0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79`

---

## [2:00–2:08] CLOSE (8s)

**Visual:** Simple end card