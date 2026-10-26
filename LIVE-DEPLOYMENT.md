# AgentFloat — Live on Mezo Testnet

Everything on this page was read back **from the chain**, not from a deploy log.
Last reconciled **2026-10-23 at block 16319650**, after the Wave 1 additions
(self-service budget changes, the x402 relay, Telegram alert binding — see
§Wave 1 additions below). Earlier full reconciliation: 2026-10-21, block
16285547.

Chain: **Mezo Testnet**, chainId `31611`, CAIP-2 `eip155:31611`.
Explorer: <https://explorer.test.mezo.org>

> **Structure note.** The gateway moved from `frontend/server/` to `server/` at
> the repo root, and the frontend was rebuilt on Tailwind v4 with routed pages,
> Privy sign-in and a MUSD faucet. See §Faucet below and
> `DEPLOYMENT-BRIEF.md` §12 for what the move touched.

---

## Deployed addresses

| Role | Address |
|---|---|
| `AgentFloatTreasury` (v`1.0.0`) | [`0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79`](https://explorer.test.mezo.org/address/0xf10e9DdFB2aE67604f230b7CE4A1A560268EDf79) |
| Owner / gateway signer / demo-seller `payTo` | `0x76233C3D6c4D1A715Acad5D83031E686b2a88349` |
| Agent wallet (EOA) | [`0xF8F56f404DB1cDb9E03b66F37D916183f4f32686`](https://explorer.test.mezo.org/address/0xF8F56f404DB1cDb9E03b66F37D916183f4f32686) |
| MUSD (canonical) | [`0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`](https://explorer.test.mezo.org/token/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503) |
| Permit2 (canonical) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Treasury verified on-chain: `VERSION() == "1.0.0"`, `paused() == false`,
`musd()` == canonical MUSD, `owner()` == deployer, 13,427 bytes of bytecode.

> A second token on testnet is also called "Mezo USD" / MUSD / 18 decimals —
> `0xf9BB…D0af`. It is an impostor: absent from the facilitator's registry.
> `deploy.js` verifies `name()`/`symbol()`/`decimals()` and hard-blocks it.

### Transaction trail

| Step | Tx |
|---|---|
| Deploy treasury | [`0x6292eb59…a05b`](https://explorer.test.mezo.org/tx/0x6292eb5934627453328f36b63477bd39692434f920b2a28802ad0040d173a05b) (block 16278029) |
| Register agent | [`0x36dd66c7…de28`](https://explorer.test.mezo.org/tx/0x36dd66c7dbe24e6b301dc159a2cd16d55b7c6ed84b32f72bdd15e0ecd4f7de28) |
| Seed treasury 100 MUSD | [`0x3cd35af5…33fb`](https://explorer.test.mezo.org/tx/0x3cd35af58080f8d1ad0fac0a5f2da0c874e57f9defb656eb4abf232efb8b33fb) |
| Release 2 MUSD float | [`0x08c9a2a3…40ae`](https://explorer.test.mezo.org/tx/0x08c9a2a3a6e252ed39210bf01bce202da6f3482e28dd7b96a17348ae42eb40ae) |
| Grant Permit2 allowance | [`0x8d0430e2…2dd2`](https://explorer.test.mezo.org/tx/0x8d0430e2a42bfd17cfaebfe2c42f7808c7e5b8aa87b95125f1af60e156312dd2) |
| Retire orphaned agent | [`0x2231a42d…2528`](https://explorer.test.mezo.org/tx/0x2231a42d158744666bc2974737f209a0a13d5a839dfab63f4d1f072ca45c2528) |

The agent's MUSD came from a real trove: 0.06 BTC collateral, 2,001.8 MUSD debt,
opened against `BorrowerOperations 0xCdF7…beE5` (the canonical system). Testnet
MUSD is minted by borrowing, not faucet-dispensed.

---

## Live state

| | |
|---|---|
| Treasury balance | **97.993 MUSD** (internal accounting agrees: `treasuryBalance()` == ERC-20 balance) |
| Agent float | **1.995 MUSD** (lifetime funded 4.0, lifetime recalled 1.993) — read 2026-10-24 after the relay payment below |
| Agent policy | `active` · `perCallMax` 2 · `dailyCap` **10** · `remainingToday` 10 |
| Registered agents | **5** — the fifth is `faucet-test.js`'s throwaway claimant `0xE2F0DA82…c7De` (10 MUSD, registered 2026-10-24). Retire it with `cd contract && AGENT_ADDRESS=0xE2F0DA827464e90918eF226db84D565881a8c7De node scripts/retire-agent.js` |
| Agent → Permit2 allowance | **max** (x402 can settle) |
| Agent → treasury allowance | **max** (kill switch can sweep) |
| Agent gas | ~0.00001 BTC — spent only on its two setup approvals |
| Owner gas | ~0.08998 BTC |
| Owner MUSD | **1,670.006** (1,800 borrowed − 100 seeded + 0.006 earned as seller − 10 − 10 − 10 to three faucet claims, the last one made by `faucet-test.js` on 2026-10-24) |
| Treasury paused | `false` — was paused by an `emergencyStop`, resumed by `scripts/resume.js` |
| `paymentCount` / `denialCount` | **12 / 6** (read 2026-10-24). The eight in the table below are the ones individually reconciled against the `Transfer` logs; the four since are listed under *Payments since that reconciliation*. Three of the extra denials are the fingerprints of §37 — two at `attempted: 0`, which is a price the gateway could not read, and one deliberate 999 MUSD over-cap refusal from `npm run test:relay` |

---

## Faucet — verified end to end

`server/faucet-test.js` was run against the live gateway. The endpoint spends
real operator funds, so it was written as something an attacker would try to
drain.

**15 assertions, all passing:**

| Case | Expected | Result |
|---|---|---|
| Legitimate claim, brand-new wallet | 200, MUSD sent, wallet registered | tx [`0xd5a6374d…65fc`](https://explorer.test.mezo.org/tx/0xd5a6374d44a7b0393501dcd417fd7a1232b70215cc100971ad297c86fd9d65fc), `registered: true` |
| 10 MUSD actually arrived | balance 0 → 10.0 | verified on chain |
| `isRegistered()` after the claim | `true` | verified on chain |
| Immediate re-claim | 429, cooldown, balance unchanged | `next claim at 2026-10-23T14:05:03Z` |
| **Forged** claim — sign as A, request for B | 403 naming the mismatch | `signature recovers to 0xF1BD…6532, not 0xF8F5…2686` |
| **Replayed** signature (nonce consumed) | 403 | `unknown or expired nonce` |
| **Tampered** challenge message | 403 | recovers to a third address, refused |

The throwaway test wallet `0xF1BD8718f932ca1cEd30A82Dcb024716e4416532` was then
retired on chain (`active: false`). It still holds the 10 MUSD: the faucet does
not grant a recall allowance, so `emergencyStop` cannot sweep a wallet that never
signed one. That is correct behaviour — a faucet should not be able to claw back
funds it gave away — but it does mean the 10 MUSD is spent, and the operator
balance above reflects it.

Faucet configuration as deployed: 10 MUSD per claim, 48h cooldown, 200 MUSD/day
cap, 1,000 MUSD total cap; claiming wallets are registered with `perCallMax` 5
and `dailyCap` 50.

---

## Wave 1 additions — verified end to end (2026-10-23)

Three capabilities were added after the reconciliation above, and each was
verified against the **live gateway and the live chain** rather than reasoned
about. Nothing in this section is simulated; where something is not switched on,
that is stated and the endpoints say so too.

### 1. Self-service budget changes — you sign, the protocol applies

`setAgentLimits()` stays `onlyOwner` (an agent that can raise its own ceiling is
not budget-controlled), so a user authorizes a specific change with a signature
from their **own** agent wallet and the gateway executes it with the owner key,
inside a published ceiling. Verified by driving the real HTTP endpoints with a
real signature from the deployed demo agent key, then reading the contract back:

| Case | Expected | Result |
|---|---|---|
| `GET /api/limits/challenge?action=limits&perCallMax=1.5&dailyCap=30` | nonce + server-authored message containing the values | 200, message named `1.5 MUSD` / `30 MUSD` and the protocol ceiling |
| `POST /api/limits/apply` with that signature | on-chain `AgentLimitsUpdated` | tx [`0xc4eda4c0…e22b`](https://explorer.test.mezo.org/tx/0xc4eda4c0171d983486149b5fab8bea1b3097dcb6964d6f73a7221f79a284e22b), `confirmed: true` |
| `agentStatus()` read back | `perCallMax` 1.5, `dailyCap` 30 | **verified on chain** |
| `GET /api/limits/history?address=…` | the change, attributed | `source: "self-service"`, `previous: {2.0, 10.0}`, same tx hash |
| **Someone else's signature** (random wallet signs the same message) | 403 naming the real signer | `signature is from 0x4613…7686, not from 0xF8F5…2686` |
| **Replay** of that refused nonce | 410 | `that challenge is expired or already used` — nonces are burned on mismatch, before any tx |
| **Tampered values** (a signature for 2/20 replayed against a 5/50 challenge) | refused | 403 — the recovered signer is a third, garbage address |
| Per-call above ceiling (99) | 400 | `per-call max cannot exceed the 5 MUSD ceiling` |
| Daily above ceiling (5000) | 400 | `daily cap cannot exceed the 50 MUSD ceiling` |
| Daily below per-call (1 vs 4) | 400 | `daily cap must be >= per-call max` (the contract would revert `ExceedsDailyCap`; the gateway says it first) |
| Per-call below minimum (0) | 400 | `per-call max must be at least 0.001 MUSD — below that no seller is affordable` |
| Restore the original caps | 2 / 10 back on chain | tx [`0x5a9f4697…99f7`](https://explorer.test.mezo.org/tx/0x5a9f46979e2f808587c6dd80fe16aea4e3a1ec0721a552bf044e0a1908f599f7), read back and confirmed |

The same mechanism authorizes `action=freeze` and `action=unfreeze`
(`setAgentActive`). Each action has its own message text, so a signature for one
cannot be replayed as another — asserted offline in `server/test-gateway.mjs`.

Rate limits exist because every change is an owner transaction paid in real gas:
12 per address per hour, 240 globally, 5-minute nonce TTL. Without an owner key
in `server/.env` the endpoints answer **503** and the UI says so instead of
pretending (`available: false` on `/api/limits/config`).

### 2. The relay — browser signs, gateway fetches

Most sellers send no `Access-Control-Allow-Origin`, so a browser cannot even
fetch the 402 to sign it: the same quote that worked through the gateway failed
in the browser with `Failed to fetch`. The relay moves only the HTTP hop.

Verified against **Mezo's own hosted demo**, the third-party seller that has no
CORS headers and previously could not be paid from a browser wallet:

```
POST /api/relay/probe  {"url":"https://demo.vativ.io/","agent":"0xF8F5…2686"}
→ ok:true  status:402  requiresPayment:true  ms:218
  offer   scheme "exact" · network "eip155:31611" · asset 0x1189…503 (canonical MUSD)
          amount 1000000000000000 (0.001 MUSD) · payTo 0xC337…8738 · permit2
  headers relayed back: ["content-type","payment-required"]   (filtered, not mirrored)
  policy  allowed:true  reasons:[]
```

**Then it paid it.** When this section was first written it showed the probe only
and still claimed the relay was verified end to end — it was not, and the execute
half was where two real bugs were sitting (§37). This is the run that closed it:

```
POST /api/relay/execute {"url":"https://demo.vativ.io/","agent":"0xF8F5…2686",
                         "payment":"eyJ4NDAy…",
                         "paymentHeaders":{"PAYMENT-SIGNATURE":"eyJ4NDAy…"}}
→ ok:true  paid:true  settled:true  delivered:true  status:200  via:"relay"  ms:7058
  header name chosen by the client   PAYMENT-SIGNATURE   (v2 — not X-PAYMENT)
  settlementTx  0x10d392de6d8199606983459c362aa26dd7f24f73849b2d16daf091a2428fc770
  chain proof   agent float 1.996 → 1.995 MUSD (exactly 0.001 moved)
                paymentCount 11 → 12 · receipt block 16341847 · status 1
  seller body   {"ok":true,"message":"Paid! You unlocked the Mezo x402 Quickstart."}
```

`npm run test:relay` re-runs that whole path — probe, local signature, relayed
fetch, settlement verified against the MUSD `Transfer` logs — and then four
refusals, asserting that the refusals cost nothing. It spends 0.001 MUSD per run
and needs the gateway running, so it is deliberately **not** part of `npm test`.

The SSRF guard was verified in the same run, and it is deliberately ordered
**protocol → allowlist → DNS/private-range**, so an unlisted host is refused
without ever being resolved:

| URL | Refusal |
|---|---|
| `http://169.254.169.254/latest/meta-data/` | `bad_protocol` (https only; http is allowed for the gateway's own origins alone) |
| `http://localhost:3000` | `bad_protocol` — judged before the host, so it does not masquerade as an SSRF finding |
| a public host not on `ALLOWED_ENDPOINTS`, when an allowlist is set | `not_allowlisted`, no DNS lookup performed |
| `/api/relay/execute` with a header map containing no payment header | 422 `empty payment header` — refused before anything is fetched |
| a payment that decodes but names no payer | 422 `payer_unverifiable` — **fails closed**; it used to be treated as "no payer to compare" and relayed anyway |
| a payment that decodes but has no readable amount | 422 `amount_unverifiable` — it used to be priced at **0**, which passes every cap |
| a payment header whose payer ≠ the claimed agent | 403 `payer_mismatch` |
| a payment priced above the agent's per-call max (tested at 999 MUSD) | 403 `payment refused by policy: per_call_max` |
| `/api/relay/probe` with no `agent` | 400 `agent is required — the relay enforces the caps of the wallet that will pay` |
| `/api/relay/execute` with no `agent` or no `payment` | 400 `agent and payment are required` |
| a policy evaluation reached with no agent at all | `policy.allowed:false`, reason `no_agent` — that code belongs to the policy engine, not to the relay's own argument check |
| an unregistered wallet | `policy.allowed:false`, reasons `["not_registered","permit2_not_approved"]` — the probe still returns the quote, so the UI can explain rather than fail |

Also asserted offline: `redirect: "manual"` (a redirect is an unchecked second
URL), a 512 KB body cap, a 20 s timeout, `isIpLiteral()` splitting literals from
names, and `dns.lookup(..., {all:true})` so **every** resolved address is judged.

### 3. Telegram alerts — built, and honestly off

No bot token is configured on this gateway, so this is what the live endpoints
return:

```
GET /api/telegram/config    → {"ok":true,"enabled":false,"botUsername":null,
                               "alerts":["payment","denial","limits_changed",
                                         "agent_frozen","faucet_claim","cap_warning"]}
GET /api/telegram/challenge → 503 {"error":"Telegram alerts are not configured on this gateway",
                               "hint":"Create a bot with @BotFather, set TELEGRAM_BOT_TOKEN …"}
```

The UI renders those facts — the Alerts page shows the four BotFather/env steps
and a **Re-check** button, and nothing is simulated in the meantime. What is
already implemented and covered by tests: long-poll `getUpdates` (no webhook, so
it works behind NAT), 409-conflict detection with a loud log and 60 s backoff,
signature-bound subscribe/unsubscribe/test, single-use 8-character codes with a
15-minute TTL and one live code per address, per-chat rate limiting (15/min),
HTML escaping of every interpolated value, an on-chain watcher that catches
events the gateway never saw (a payment settled straight from a browser) and
warns once per UTC day at 20% of the daily cap remaining, and fire-and-forget
delivery so an alerting outage can never fail a payment.

To switch it on: `TELEGRAM_BOT_TOKEN`, optionally `TELEGRAM_BOT_USERNAME`
(enables the one-tap `t.me/<bot>?start=<code>` link) and `TELEGRAM_WATCH_SECONDS`
in `server/.env`, then restart the gateway. The boot line changes from
`🔕 telegram alerts off` to `telegram on`.

### 4. The offline suite that caught a real bug

`npm run test:gateway` → **138 assertions, all passing**, with no chain, no bot
token and no network dependency. It is what found the SSRF guard bug in §32
below: the guard had a public-hostname *allow* case in the suite, and that case
failed on the first run. It is also what now pins the payment-header shapes in
§37 — v1 and v2, permit2 and EIP-3009, built from the payloads a real wallet
signs rather than from the shape the documentation implies.

`npm run test:browser` → **90 assertions** across two frontend suites that need
no browser: the wallet network state machine (61) and the browser half of an
x402 payment (29). The second one drives `makeRelaySigner()` and
`makeBrowserPayer()` against a fake EIP-1193 provider that records every call and
signs with a throwaway key, plus a stubbed `fetch`, so the whole paying flow —
402, signature, `PAYMENT-SIGNATURE` on the second request, resource returned —
runs offline. It is what pins §38: the assertion "signing went through the
transport" fails the moment a signer without `signTypedData` is handed to the
scheme.

---

## Payments that actually happened

**8 MUSD transfers left the agent wallet, totalling 0.008 MUSD** — verified by
scanning the canonical MUSD `Transfer` logs, which is the authoritative record.
All were paid via `permit2` on `eip155:31611`, gas-sponsored by the facilitator.

| # | Time (UTC) | Seller | Settlement tx |
|---|---|---|---|
| 1 | 10:23:53 | AgentFloat demo | [`0x4c41f22e…380a`](https://explorer.test.mezo.org/tx/0x4c41f22e4cc8da39e49f5d321ec31c0defcb8d1d7ac2c23cbac715a7e3fd380a) |
| 2 | 10:35:08 | AgentFloat demo | [`0x821a7383…ace88`](https://explorer.test.mezo.org/tx/0x821a73833be7ad88c4725ac15f6efd86378fdb08fd06a4f8150373e84dcace88) |
| 3 | 11:08:52 | AgentFloat demo | `0xf0a6dbd2…` — *see ledger artifacts below* |
| 4 | 11:09:59 | AgentFloat demo | [`0x0baf443e…a23f`](https://explorer.test.mezo.org/tx/0x0baf443ea68dcd583dddbe773380c6d0c34169da9d947732b56253a0e514a23f) |
| 5 | 11:10:43 | AgentFloat demo (via browser UI) | [`0x3913a42e…b4ad`](https://explorer.test.mezo.org/tx/0x3913a42ef8f4fa0923aabdf6b851af848d6753d94e238691956dcbe4eac7b4ad) |
| 6 | 11:16:53 | AgentFloat demo | [`0x23ce39b4…e0e7`](https://explorer.test.mezo.org/tx/0x23ce39b4d440c1888b2f8af9e3f3803a59b0633f1acee9dcbf94f4c49a98e0e7) |
| 7 | 11:18:30 | **Mezo hosted demo** (third party) | [`0x3daf35ac…9fbc`](https://explorer.test.mezo.org/tx/0x3daf35ac53568ed6f54799557614fa677c3f5a929c5caf83fc7ef1dd8b439fbc) |
| 8 | 19:32:00 | **Mezo hosted demo** (third party, post-resume) | [`0x963d92ba…5c27`](https://explorer.test.mezo.org/tx/0x963d92ba1617aad65a54f86315aa3e1a359d66839a75d7af74ca671bf71d5c27) |

Payment 7 is the most meaningful one: it paid **Mezo's own hosted x402 endpoint**
(`https://demo.vativ.io/`), not our own seller, and unlocked

```json
{"ok":true,"message":"Paid! You unlocked the Mezo x402 Quickstart."}
```

That is real interoperability with a third-party seller, not a self-loop.

Payment 8 re-proved the same path **after an emergency stop and recovery**: the
treasury had been paused on chain and the agent's float swept to zero, then
`scripts/resume.js` unpaused it (`0x944825cd…8c8a`) and released a fresh 2 MUSD
(`0x027eb27d…1a6d`). The payment returned HTTP 200 in 19.3 s with
`source: "chain"` and `delivered: true`, the agent's on-chain balance moved
2.0 → 1.999 MUSD, and the append-only ledger recorded it
(`0xd72b3e53…ee8b`, `paymentCount` 7 → 8).

Payments 1, 2, 4 and 5 returned our seller's paywalled payload, e.g.

```json
{"ok":true,"source":"AgentFloat demo seller","asset":"MUSD","signal":"peg",
 "value":1.001,"note":"Trading within 10bp of peg across Mezo venues."}
```

### Payments since that reconciliation

`paymentCount` is now **12**. All four later rows come straight from
`GET /api/chain-records` (`source: "chain"`, i.e. reconciled against the MUSD
`Transfer` logs, not against an HTTP status):

| Time (UTC) | Seller | Settlement tx | Why it matters |
|---|---|---|---|
| 2026-10-21 10:10:40 | AgentFloat demo | *(none — `0x0`)* | Artifact 1, the phantom row described below |
| 2026-10-23 12:00:35 | **Mezo hosted demo** | [`0xccf2ed12…e921`](https://explorer.test.mezo.org/tx/0xccf2ed126917098ecd7cfa1ce95892a835cdd7948c302a8dd4a905eb5b98e921) | third-party seller, Wave 1 gateway |
| 2026-10-23 13:50:06 | **Mezo hosted demo** | [`0x4b4a4975…e233`](https://explorer.test.mezo.org/tx/0x4b4a4975fd6b45b050035f1525345855f50da726bfa2c778412057875d54e233) | the **control** run in §37: `POST /api/pay` settled in seconds while the relay next to it moved nothing |
| 2026-10-24 15:16:47 | **Mezo hosted demo** | [`0x10d392de…c770`](https://explorer.test.mezo.org/tx/0x10d392de6d8199606983459c362aa26dd7f24f73849b2d16daf091a2428fc770) | **the first payment made through the relay** — browser-shaped signature, `PAYMENT-SIGNATURE` header, gateway fetch, chain-verified settlement in block 16341847 |

The last one is the row that closes §2 above: probe → local signature → relayed
fetch → `settled: true` → 0.001 MUSD out of the agent wallet (1.996 → 1.995) →
`paymentCount` 11 → 12 → receipt `status 1`.

### Refusals that actually happened

6 denials recorded on chain:

| Time (UTC) | Attempted | Reason | Note |
|---|---|---|---|
| 10:37:25 | 0.001 MUSD | `per_call_max` | cap deliberately lowered to 0.0005 via `set-limits.js`; **no MUSD moved** (balances verified unchanged), then restored to 2 |
| ~10:52 | 0.001 MUSD | `permit2_not_approved` | guard test with a bogus Permit2 address; refused before signing |
| 11:08:52 | 0.001 MUSD | `x402 settlement rejected (HTTP 402)` | **misclassified — MUSD did move.** See below |
| 2026-10-23 13:47:48 | **0** | `settlement_failed: seller returned 402` | §37 caught in the ledger: the relay forwarded `X-PAYMENT` to a v2 seller and priced the payment at 0 because it could not read `accepted.amount`. **No MUSD moved** |
| 2026-10-23 13:48:17 | **0** | `settlement_failed: seller returned 402` | the same failure one attempt later, with `paymentCount` unchanged — which is what proved the payment never reached settlement rather than failing at it |
| 2026-10-24 15:16:50 | 999 MUSD | `per_call_max` | deliberate: `npm run test:relay` submits a payment priced 999× over the agent's 2 MUSD per-call cap and asserts it is refused **and** that the balance does not move. The ledger is append-only, so the test leaves a real row behind |

---

## ⚠️ Two known artifacts in the on-chain ledger

The log is append-only by design (there is no delete function), so both remain
visible. They are disclosed here and marked in the UI rather than papered over,
because an auditable payment history is the entire point of the project.

Reconciliation of all 7 `PaymentRecorded` rows against the `Transfer` logs:
**6 genuine, 1 phantom.** Plus **1 denial that was actually a charge.**

**Artifact 1 — a phantom payment (10:10:40, tx
[`0xbcb54b8b…74c3`](https://explorer.test.mezo.org/tx/0xbcb54b8b21456543f108d428ea4adbd642526f497f6f3dadf8bda26eee9a74c3),
block 16278514).**
An attempt was rejected with HTTP 412 because the agent had no Permit2
allowance — no MUSD moved. The gateway at that time wrote `PaymentRecorded` for
*any* response, so it logged a payment that never happened. Its `settlementTx` is
`0x0`, unlike every genuine row. The dashboard renders it with a red
**`unverified`** badge and an explanatory tooltip.

**Artifact 2 — a charge logged as a refusal (11:08:52, settlement
`0xf0a6dbd2…`).**
The mirror image. The facilitator *did* settle the transfer on chain, but the
seller answered HTTP 402, so a status-only check recorded a denial for money that
had already moved. This is what prompted the chain-verification fix below.

Since that fix, every settlement has been classified correctly — including
payment 6, which hit the identical HTTP-402-after-settlement condition and was
correctly recorded as a **payment** with `charged_without_delivery`.

---

## Bugs found by deploying, and what changed

None of these were visible from reading the docs; each cost a real failed run.

**1. Permit2 allowance was never granted.** `setup-agent.js` granted the treasury
recall allowance only. x402 on Mezo settles with
`assetTransferMethod: permit2`, so the facilitator must be able to *pull* MUSD
via Permit2 — a different allowance to a different spender. Without it the quote
decodes perfectly and policy allows the payment, then settlement fails with HTTP
412. Fixed in four places: `setup-agent.js` grants both; new
`scripts/grant-permit2.js` repairs existing wallets; `/api/health` reports
`agent.permit2.ready` (shown in the UI next to the recall allowance); and the
policy engine refuses up front with `permit2_not_approved`.

**2. A failed settlement was recorded as a payment.** Artifact 1 above. The
gateway now computes `settled = status < 400 && payment-response.success !== false`
and writes `DenialRecorded` instead of `PaymentRecorded` on failure.

**3. The HTTP status is not authoritative — so neither was fix 2.** Artifact 2
above. The facilitator can settle on chain while the seller still returns 402,
which made a *status-only* check record a denial for a real charge. The gateway
now captures the block height before signing and, on any non-success response,
scans the canonical MUSD `Transfer` logs for the exact quoted amount. If MUSD
moved it records a **payment** with the real settlement tx and flags
`charged_without_delivery`; only if nothing moved does it record a denial.
Validated against the actual misclassified tx, plus negative controls for an
empty block range and a wrong amount.

**4. `tx.wait()` hangs on this RPC** — for minutes, *after* confirmation. It froze
`/api/pay` for 600s+ even though both the payment and the receipt had succeeded.
Receipt writing now races `tx.wait()` against a 20s bound (`RECEIPT_CONFIRM_MS`)
and returns the hash, known at broadcast, plus a `confirmed` flag. Standalone
scripts poll the chain for the expected state change instead.

**5. Re-running `setup-agent.js` orphaned a funded agent.** It called
`createRandom()` whenever `AGENT_PRIVATE_KEY` was missing from the *shell* env —
which it always is, since the key lives in `frontend/server/.env`. That registered
a second wallet under the same label and stranded the funded one (it had to be
retired on chain). It now reuses the key from the gateway `.env`, and skips
`setAgentLimits` entirely when the values already match.

**6. `setup-agent.js` clobbered `frontend/server/.env`,** deleting
`GATEWAY_SIGNER_PRIVATE_KEY` and silently disabling on-chain receipts. It now
merges, preserving keys it does not own, and reports which it kept.

**7. `--no-approve` could never work.** Hardhat rejects unknown params with
`HH305` before the script sees `process.argv`. Replaced by `NO_APPROVE=1`.
`recallAllowanceGranted` also reported *intent* rather than chain state; it now
reports the actual allowance.

**8. The SSRF guard blocked the gateway's own demo seller.** Loopback is rightly
refused for user-supplied URLs, but the built-in seller *is* loopback. Exact
self-origins are now exempt; `127/8`, `10/8`, `172.16/12`, `192.168/16`,
`169.254/16` and `::1` remain blocked.

**9. Vite proxied only `/api`,** so the seller path 404'd in the browser. Added a
`/paid` rule, and `/api/health` now exposes `seller.selfUrl` (the loopback URL the
*gateway* fetches) separately from `seller.browserPath` (the same-origin path a
human opens). They differ because the fetch happens server-side.

**10. The dashboard crashed on load.** `Header.jsx` evaluated
`(health && health.paused) || (health.treasury && …)` — when `health` is `null`
the first clause is falsy, so the second dereferenced null and unmounted the whole
app before the first fetch resolved. Now guarded. Also fixed a `for=` → `htmlFor=`
prop, and the float display, which rounded 1.998 to "2 MUSD" — in a budget
product the remaining float is the point, so it now shows 4dp.

**11. `agentStatus` has no `registered` field** — it calls `_requireAgent`
internally, so success itself proves registration. Also: an ethers `Result` is
read-only, so `.slice().reverse()` on one throws; use `Array.from(...)` first.

**12. `import "dotenv/config"` reads `process.cwd()`, not the script's folder.**
After the gateway moved to `server/`, starting it from anywhere else loaded *no*
env at all — the gateway came up **unarmed** (`⚠️ AGENT_PRIVATE_KEY missing`) and
served every route anyway, with no error. Now
`dotenv.config({ path: path.join(__dirname, ".env") })`, so cwd is irrelevant.
This is why `npm run gateway` from the repo root works.

**13. `EADDRINUSE` was swallowed by the `uncaughtException` handler,** which
logged "gateway API stays up" while a **stale process running older code** kept
the port. A whole debugging cycle was spent on faucet routes that "didn't exist"
— they did, in the new file, which was never the one running. The handler now
re-throws bind errors and exits non-zero with kill instructions for both Linux
(`fuser -k 4022/tcp`) and Windows (`netstat -ano | findstr :4022`, `taskkill`).

**14. Express matches middleware in registration order.** A 404 catch-all
registered *above* the faucet router mount swallowed every `/api/faucet/*`
request, while `/api/health` cheerfully reported `faucet.enabled: true`. The
catch-all now sits last, immediately before `app.listen()`.

**15. `res.json` throws on a BigInt.** `faucet.evaluate()` returned
`distributedToday` as a BigInt: `"Do not know how to serialize a BigInt"`.

**16. A statically-imported Privy bundle OOM-killed the toolchain.** esbuild's
dep pre-bundler died ("The service was stopped") and `vite build` exhausted the
heap. Both a `React.lazy(() => import("./lib/PrivyLayer.jsx"))` boundary *and*
`optimizeDeps.exclude` are required. Separately, `@apply tnum` fails in Tailwind
v4 — `@apply` accepts registered utilities only, not custom classes.

**17. EMERGENCY STOP had no CLI undo, and it does two things at once.** The
Operate page's red button calls `treasury.emergencyStop(agent)`, which sets
`paused = true` **and** sweeps the agent's whole float back in one transaction.
Recovery then has an ordering constraint that is easy to get wrong: `fundAgent`
is `whenNotPaused`, so re-funding *before* unpausing reverts. The only undo path
was an injected MetaMask wallet holding the operator key. Added
`scripts/resume.js` (plain Node + ethers, poll-based, no browser) which unpause
first, then funds, then prints both allowances. Verified live: unpause
`0x944825cd…8c8a`, re-fund `0x027eb27d…1a6d`, then payment 8 settled normally.

**18. Excluding Privy from `optimizeDeps` stripped CJS interop from its whole
subtree, and the app crashed the moment a real App ID was set.**
`@privy-io/react-auth` ships ESM but its tree contains **26 CommonJS-only files**
that a browser cannot evaluate as modules. The first is a nested `eventemitter3`
whose `index.mjs` does `import EventEmitter from './index.js'` — and `index.js` is
pure `module.exports`, zero ESM exports:

```
Uncaught SyntaxError: The requested module
'/node_modules/@privy-io/react-auth/node_modules/eventemitter3/index.js'
does not provide an export named 'default'
```

The exclusion had *looked* safe only because it was never exercised: with no
`VITE_PRIVY_APP_ID`, `main.jsx` renders `InertSessionProvider` and the chunk is
never requested. The browser stops at the first bad module, so fixing them by
hand is whack-a-mole — a crawl of the served graph found all 26 (`events`, `pino`,
`dayjs` subpaths, `blakejs`, `cross-fetch`, `@coinbase/wallet-sdk`,
`@walletconnect/window-getters`, `@reown/appkit* > qrcode`, …). They are now
listed in `CJS_INTEROP` for esbuild to pre-bundle individually, which is cheap,
and `frontend/scripts/check-browser-deps.mjs` (`npm run check:deps`) re-verifies
the graph and exits non-zero on any new landmine. Verified: **3,917 modules
crawled, 0 raw CJS remaining.** `AGENTFLOAT_PREBUNDLE_PRIVY=1` is the opt-in
"let Vite bundle the whole tree" path for machines with ≥4 GB.

**19. A wallet-provider failure took the entire app down.** No error boundary
wrapped the lazy Privy chunk, so one bad module killed the dashboard, ledger,
spend and faucet pages too — none of which need Privy. `main.jsx` now catches it
and degrades to operator-wallet mode behind a visible banner.

**20. `--host 0.0.0.0` invited a URL that breaks the app.** Vite printed
`http://192.168.1.x:5173`, and opening that gives a *non-secure context*: the
browser disables `crypto.randomUUID` and injected wallet APIs there, so Privy and
wallet extensions throw `crypto.randomUUID is not a function`. It also exposed the
dashboard — and through its `/api` proxy the agent wallet — to the whole LAN.
`npm run dev` now binds `127.0.0.1`; `npm run dev:lan` is the explicit opt-in for
tunnels and previews; `App.jsx` renders a banner when it detects a non-secure
origin.

**21. `embeddedWallets.createOnLogin` was in the wrong place and silently
ignored.** `src/lib/privy.js` set it at the top level of `embeddedWallets`. In
`@privy-io/react-auth` **3.50.0** the type is
`embeddedWallets?: { ethereum?: { createOnLogin? }, solana?: { createOnLogin? },
showWalletUIs? }` — there is no top-level `createOnLogin`, so the SDK dropped it
and fell back to its default `"off"`. No warning, no error. Every user signed in
successfully and received **no agent wallet**, which is the whole product.
`appearance.walletChainType` had the same problem: it belongs inside
`appearance?: { … }`, not at the top level. Both corrected, verified against
`node_modules/@privy-io/react-auth/dist/dts/types-*.d.ts` rather than against
blog posts. **This is why `npm run check:privy` now greps our own source for the
nesting, not just the remote config.**

**22. Google sign-in was disabled in the Privy dashboard while our client asked
for it.** `loginMethods` includes `"google"`, but the app behind
`cmvjxsrk801n40hku6ttpkbxw` had `google_oauth: false`. No code change can fix
that; it is a dashboard setting. Enabled since, together with `allowed_domains`,
which was empty and now lists `http://localhost:5173` and `http://127.0.0.1:5173`.
`smart_wallet_config.enabled` was already correctly `false` — EOAs are mandatory
because x402 authorizes with an EIP-712 permit2 signature.

**23. Vite's `warnOnce` bypasses `warn`, so the sourcemap filter did nothing.**
Excluding Privy from pre-bundling makes Vite serve ~300 raw files whose
`sourceMappingURL` points at maps not shipped in the tarball, printing
`Sourcemap for "…" points to missing source files` once per file. The first
`customLogger` attempt overrode only `logger.warn` and **filtered nothing**, with
no sign that the patch was never hit: inside `createLogger()`, `warnOnce` calls an
internal `output()` closure directly and never routes through `warn`. Patching
both methods fixed it — 77 log lines / 38 warnings became 44 lines / 0 warnings /
1 four-line notice. Lesson: when a monkey-patch appears to have no effect, read
the vendor source for how the call site is wired instead of assuming the obvious
delegation.

**24. `usePrivy().login()` returns `void`, so every login failure was silent.**
The button did nothing, the console said nothing, and the symptom was
indistinguishable from the click handler not being wired up. In 3.50.0 the
signature is `login: (options?: LoginModalOptions | MouseEvent<any, any>) => void`
— there is no promise to await and no error to catch. `useLogin({ onError })`
takes a callback that receives a documented `PrivyErrorCode`, so
`PrivyLayer.jsx` now uses that hook instead and publishes `authError` on the
session; `Navbar.jsx` renders it as a dismissible, non-modal toast (a `<dialog>`
would collide with Privy's own, per their "Multiple dialogs" note). Codes are
mapped to the fix that applies here via `explainPrivyError()` in `lib/privy.js`,
covering `invalid_origin`, `missing_or_invalid_privy_app_id`,
`disallowed_login_method`, `linked_to_another_user`, `invalid_native_app_id` and
`Wallet proxy not initialized`.

**25. `useWallets()` has its own `ready` flag, and we were ignoring it.** We read
only `usePrivy().ready`. Privy's troubleshooting docs require waiting for *both*
before touching wallets, and list the omission as a cause of
`Wallet proxy not initialized`. `agentWallet` was resolving against a possibly
empty `wallets` array, which is how the navbar sits on "creating wallet…" forever.
Now combined into `sessionReady = ready && walletsReady`, and `agentWallet`
returns `null` until `walletsReady` is true.

**26. Hand-copied files made every symptom ambiguous, so the checkers were tested
against known-good source — and two failed.** `npm run check:client` greps the
local checkout for stale patterns. Written against the assumption that the
patterns were obvious, it produced **two false positives on correct source**
(a check matching `walletKind()`'s *label* `"privy_smart_wallet"` as though it
requested a smart wallet, and one expecting `ready: walletsReady` to follow
`useWallets()` when destructuring puts it before) and **one false negative on the
exact bug it exists to catch** (detecting `login` after `usePrivy()` rather than
in the binding list). All three were only visible by running the checker against
the fixed files and then against deliberately broken ones. A pattern checker that
is not regression-tested both ways is worse than none, because it is trusted.

**27. Privy's real failure mode was `exited_auth_flow`, and `/diagnose` is what
proved it.** The report showed `provider mounts 1 / unmounts 0`, one React root,
one correctly-initialised Privy iframe, `session.ready: true`, secure context,
allowlisted origin — which eliminated StrictMode, the double root, the origin
allowlist and WebCrypto in a single page load. The only remaining signal was the
code `exited_auth_flow`: Privy's modal opened, spun, and closed *itself*, which
is Privy's own wording for a flow that ended without authenticating. That lives
inside Privy's bundle, not in this repo, and it is why the Reown connector was
integrated as a parallel session provider instead of more Privy archaeology.
`/diagnose` exists because every one of those eliminated hypotheses needed live
DOM state that no terminal, and no `check:privy`, can observe.

**28. Reown brought a second, differently-nested copy of `qrcode` — and
`check:deps` caught it before the browser did.** `CJS_INTEROP` already listed
`@reown/appkit-ui > qrcode…`, so the config looked covered. It was not:
`@walletconnect/ethereum-provider` nests its **own** `qrcode`, and a nested copy
is a separate package as far as esbuild is concerned. The crawler flagged
`@walletconnect/ethereum-provider/node_modules/qrcode/lib/browser.js` and
`…/renderer/svg-tag.js` as raw CommonJS the moment the connector was wired in;
three include entries, a cleared `.vite` cache and a restart took the graph back
to **3,939 modules, 0 landmines**. The lesson generalises: after adding *any*
SDK, re-run `check:deps` — a transitive CJS dep under a new parent path is
invisible to the existing list. `check:client` now greps `vite.config.js` for the
ethereum-provider entry so a partial copy cannot silently drop it.

**29. A falsified hypothesis, kept on purpose: `detected_wallets` was NOT the
Privy modal's killer.** `bursa`
(github.com/bammyoly/bursa) is a shipped Privy app that works, and its config
carries the explanation in a comment: the default `appearance.walletList`
includes `detected_wallets`, which enumerates **every** injected browser
extension — Phantom, Backpack, 1inch, half-initialized EVM providers — and
initialises them inside the login modal. One incompatible provider throws,
Privy tears the flow down, and `useLogin` reports `exited_auth_flow` although
the user clicked nothing. That matched the `/diagnose` evidence: one
provider mount, healthy iframe, `ready: true`, secure context, allowlisted
origin — on a machine known to carry an injected extension.

**It was wrong.** The user declined this change, did a clean uninstall and
reinstall of `@privy-io/react-auth` and `@reown/appkit`, set
`VITE_WALLET_PROVIDER=privy`, and the modal then displayed correctly —
with `detected_wallets` still at its default. So the cause was a corrupted
or half-installed `node_modules` / stale optimize cache, not wallet
auto-detection. The Bursa-derived settings were reverted except
`showWalletLoginFirst: false`, which is a UX choice rather than a fix.
Recorded anyway because the reasoning chain was sound and the evidence
was real; a falsified hypothesis with its disproof is more useful to the
next debugger than a silently deleted one. Two of bursa's keys were **not** ported, deliberately. `embeddedWallets.
createOnLogin` at the top level and `noPromptOnSignature` do not exist in
`@privy-io/react-auth` 3.50.0 — verified against
`dist/dts/types-CoijvGho.d.ts`, where `createOnLogin` lives only under
`ethereum`/`solana` and `noPromptOnSignature` is absent entirely. Bursa pins an
older Privy; both keys are silently ignored in 3.50.0. Porting them would have
shipped dead config that reads as a guarantee, so `privy.js` records why they
are absent instead.

**30. The "switch to Mezo" button did nothing, and the reason was two bugs that
each hid the other.** Reported as "sometimes the network button doesn't work".
On the Privy path it *never* worked:

- `PrivyLayer` published `chainId: MEZO_TESTNET_ID`,
  `chainOk: Boolean(agentWallet)` and
  `fixNetwork: async () => ({ wasOnChain: true })`. The reasoning was that the
  embedded wallet is created on `privyConfig.defaultChain`, so the chain cannot
  be wrong. But `chainOk` was then just "is there a wallet yet", so while the
  wallet was still provisioning the navbar offered **"wrong network (31611) —
  switch to Mezo"** — a button whose handler resolved a fake success and touched
  nothing. And the case the hardcoded values were protecting against was real:
  an operator signing in with MetaMask through the same modal gets an *external*
  wallet on whatever chain the extension happens to be on, which nothing ever
  moved.
- The failure had a second, independent cause. `AuthErrorToast` was rendered
  only inside the **signed-out** branch of `WalletArea`, so `authError` set by a
  failed switch — the one error a signed-in user can actually get — was never
  displayed. Even the paths that did work reported nothing.

Both are fixed. `chainOk` is now **tri-state** (`true` / `false` / `null` = no
wallet to ask yet), read from `wallet.chainId`, which Privy publishes in CAIP-2
(`eip155:31611`); only a measured `false` earns a button. `fixNetwork` calls
`ensureWalletChain()` in `lib/evm-network.js`, which prefers Privy's own
`wallet.switchChain()` — the **only** route for an embedded wallet, since there
is no extension to prompt and the embedded provider does not implement EIP-3085
— then confirms against a freshly requested provider, because Privy documents
that `switchChain` does not update existing provider instances. Unconfirmed or
unsupported, it falls through to `wallet_switchEthereumChain` /
`wallet_addEthereumChain`; a user rejection is surfaced and never retried. The
toast moved to shell level so it renders in every session state, and network
errors get a "try the switch again" button. `test:network` went from 29 to **61
assertions** covering the CAIP-2 parser and both switch routes, and
`check:client` greps for the hardcoded patterns so a stale `PrivyLayer.jsx`
cannot bring the dead button back.

**31. Two UI lies, both silent.** Found while integrating the dashboard redesign:

- `<button className={`btn ${v} ${s}`} {...rest}>` spreads `rest` **after** the
  base classes, so any caller passing `className` replaced them wholesale.
  `<Button className="w-full shadow-lg shadow-btc/20">` rendered an unstyled
  browser button — no padding, no border, no colour. `className` is now
  destructured out of `rest` and appended.
- `navigator.clipboard?.writeText(addr).catch(() => {})` in `AddressLink`
  "copied" the address on click. Outside a secure context `navigator.clipboard`
  is `undefined`, so on `http://192.168.1.195:5173` it copied nothing and said
  nothing, and the click also opened an unwanted explorer tab. `copyText()` now
  falls back to a hidden textarea + `execCommand` and returns a boolean; the
  address copies with a visible `copied ✓`, and the explorer moved to its own ↗.

Neither throws, neither logs, and both look like a design problem rather than a
bug — which is why they are written down.

**32. The SSRF guard blocked every real seller, and only a test caught it.**
`assertRelayable()` handed *hostnames* to `isPrivateAddress()`, whose rule is
"anything that is not an IP literal is refused". So `https://demo.vativ.io/`
returned `ssrf_blocked` and the relay would have been dead on arrival for every
third-party seller while passing every private-range case — the exact inversion
of useful. Fixed by exporting `isIpLiteral(host)`: literals are judged as
written, names go to `dns.lookup(..., {all:true})` and **every** resolved address
is judged (a name blocklist alone is bypassed by DNS rebinding). The guard order
also became protocol → allowlist → SSRF, so `http://localhost:3000` reports
`bad_protocol` instead of masquerading as an SSRF finding, and a host that is not
allowlisted is refused without a DNS lookup at all. The suite caught it only
because it contained a public-hostname *allow* case.

**33. `POST /api/pay` could not serve a user wallet.** Policy was hardwired to
`x402.account.address` — the gateway's own demo agent — so a signed-in user's
purchase was evaluated against the wrong caps, the wrong registration and the
wrong float. `evaluatePolicy()` now takes an `agent` argument (defaulting to the
demo agent), which is what lets one code path and one set of reason codes serve
both payers instead of duplicating the policy and letting the copies drift.

**34. `x402Client` cannot build an `X-PAYMENT` header.** The relay needs signing
*without* fetching, and the obvious client has no header encode/parse. Those live
on `x402HTTPClient` (`@x402/core/client`, re-exported by `@x402/core/http` and
`@x402/fetch`): `getPaymentRequiredResponse(getHeader, body?)` →
`createPaymentPayload(...)` → `encodePaymentSignatureHeader(...)`. That trio is
the browser half of the relay. `wrapFetchWithPayment()` is unusable here because
it signs *and* fetches, and those two halves must happen in different processes.
Its types are not in a `client.d.mts` — read the `exports` map; most of them sit
in a shared chunk (`dist/esm/x402Client-*.d.mts`).

**35. The Operate page told every new user the product was not for them.** It was
an operator console: every action needed the treasury-owner wallet, so a user who
had just created an agent wallet with their email saw a page of disabled controls
and no reason anywhere. Split into zone one (their own budget — available to
every signed-in user, signature-authorized, ceilinged) and zone two (owner-only,
below a divider that says whose it is; for a non-owner an *explanation* of what
those controls are and who holds the key, rather than a wall of disabled
buttons). While integrating it, Dashboard's agent-status read turned out to sit
**below** `if (!deployed) return …`, which changes the hook count between renders
and takes the page down with "Rendered more hooks than during the previous
render" the moment the deployment artifacts appear. It reads first and returns
second now, and `check:client` asserts the order.

**36. `JSON.stringify(BigInt)` throws — inside the test harness.** `parseMusd()`
returns a BigInt and the harness's `eq()` stringified both sides, so a
*comparison* crashed instead of failing cleanly and the output looked like a bug
in the module under test. Wrapped in `String(...)`. Recorded because a harness
that throws on the value it is comparing will hide the failures that matter.

**37. The relay forwarded a header no v2 seller reads, and then could not see who
was paying.** Found by paying Mezo's hosted demo through the relay: ~31 s, HTTP
502, `x402 settlement failed — no MUSD moved`, `paymentCount` unchanged — while
`POST /api/pay` for the same quote settled fine seconds earlier. Three separate
mistakes, all in code that had passed its own tests:

*The header name is part of the protocol.* The relay hardcoded `X-PAYMENT`. That
is x402 **v1**; v2 — which is what Mezo's facilitator and its hosted demo speak —
travels as `PAYMENT-SIGNATURE`. `encodePaymentSignatureHeader()` returns a *map*
precisely so the caller does not have to know, and `wrapFetchWithPayment` sets
every header in it. The relay now forwards the map (`paymentHeadersFrom()`), and
the allowlist is the two protocol names only, so a client cannot smuggle `Host`,
`Authorization` or `Cookie` through the operator's machine. A header the seller
never reads produces no error anywhere: it answers 402 again and the failure
surfaces as a settlement timeout.

*The payer and the amount are not where the code looked.* `inspectPaymentHeader()`
read `payload.payer` and `payload.paymentRequirements`. Real payloads have neither:
v2 carries the payer in `payload.permit2Authorization.from` (or
`payload.authorization.from` for EIP-3009) and the negotiated price in
`accepted.amount`; v1 wraps the same payload but keeps the requirement in an
**array**, so reading it as an object returns `undefined` for every field. The
offline suite had a fixture with `payload.payer` in it — invented from the
documentation, not captured from a wallet — and it passed. Fixtures now come from
the real thing.

*The guard failed open.* `if (decoded.payer && mismatch) deny` — with an unreadable
payer the condition is false, so the payment was relayed, and with an unreadable
amount `amountWei` fell back to `0`, which is under every cap. An unverifiable
payment is now refused: 422 `payer_unverifiable`, 422 `amount_unverifiable`, both
before anything is fetched and before any policy maths. Security checks that
depend on parsing must fail closed; the offline suite asserts both refusals, and
`npm run test:relay` asserts they cost 0 MUSD.

**38. `signer.signTypedData is not a function` — the browser could quote but never
pay.** Reported by a user on Spend → "my agent wallet" → pay. `createWalletClient({
account: address })` builds a viem **JSON-RPC account**: `{ address, type }`, data
only, with signing expected to go over the transport. That object was handed to
`registerExactEvmScheme()`, which asks for `{ address, signTypedData }` — so the
SDK called a method that did not exist. The wallet was connected, the quote was
correct, and the error named a function instead of a cause, which is why it looked
like an SDK bug. Fixed by `schemeSigner()`: the methods are bound on the *client*
(`walletClient.signTypedData({...args, account})`), used by both
`makeBrowserPayer()` and `makeRelaySigner()`. A `privateKeyToAccount` LocalAccount
already has both methods, which is exactly why the gateway never hit this and why
no server-side test could. Deliberately **not** adding `readContract` to the
browser signer: it switches the SDK onto the optional EIP-2612 sponsoring path,
which is one more thing that can fail between the user and the signature prompt.

**39. The thing you see before the page loads was a dot, and it said nothing.**
The Suspense fallback for the wallet provider was a full-screen pulsing dot with
"Loading wallet provider…". A dot that fades in and out reads as decoration, so on
a slow Privy load — and Google sign-in is slower than email while the embedded
wallet is created — the app looked hung on a blank screen. Now one shared
indicator: `lib/RingSpinner.jsx` (a turning SVG ring) plus `BootScreen`, which
keeps the information and adds the part that was missing — *which* provider is
loading, and that Google takes a few seconds longer the first time. `index.html`
carries an inline copy for the moment before React mounts, because a flash of
unstyled white is worse than a blank screen on a dark app. `Spinner` in
`components/ui.jsx` uses the same ring, so an in-page busy state and the boot
state no longer look like different products. The status `Dot` still pulses — that
one is a state indicator, not a loader.

*Amended 2026-10-25:* the words were removed. `BootScreen` is now the ring,
centred, and nothing else; `index.html`'s inline copy matches. What survives is
`role="status"` + `aria-live="polite"` + `aria-label="Loading"`, so a screen
reader still hears it — the information moved to the pages that know what they are
waiting for, because the boot screen could only ever guess which chunk was slow.
`check:client` now fails a checkout that puts copy back inside `BootScreen`.

**40. State that changes server-side has to be watched, not reloaded.** On
`/alerts`, after the user sent `/start <code>` to the bot, the card kept saying
**not connected** until the page was reloaded. The binding lands on the *gateway*
(its long-poll sees the message), so nothing in the component is told. It now
polls `/api/telegram/status` while a code is outstanding — first check after 1.5 s
because most people press Start immediately, then every 4 s — and stops the moment
it lands or the code expires, retiring the code and saying "Connected, alerts now
go to @you". One implementation detail worth keeping: the effect's dependencies
must be booleans that flip at most once. Depending on the countdown's `now`
recreated the interval every second, so it never fired. The general rule is now
applied wherever a page renders something the gateway decides.

**41. A refusal whose remedy is a terminal command is a dead end.** The policy
engine refused a payment with `permit2_not_approved` and printed
`fix with: cd contract && node scripts/grant-permit2.js`. The person reading it had
signed in with Google in a browser. They do not have a checkout, and they do not
have the wallet's private key — a Privy embedded wallet's key never exists outside
the enclave, so that script could not have worked for them even in principle. The
remedy now lives in the product: `components/ApprovalModal.jsx`, mounted on
`/spend`, `/` (next-steps rail) and `/faucet` (the first button after a successful
claim). It offers the two scopes a user actually has to choose between — **this
payment only** (approve the quoted amount) and **all future payments** (approve the
maximum, so no second prompt is ever needed) — and the refusal itself now carries
`action: "approve_permit2"` so a UI can act on it instead of printing prose. The
script still exists for an operator who holds the key, and is mentioned last.

**42. An approval is a transaction, and a brand-new wallet has no gas.** The blocked
wallet read `MUSD 10.0 · allowance 0 · BTC 0.0`. Approving Permit2 costs native BTC
(~60 000 gas at 146 wei ≈ 8.76e-12 BTC), and a wallet created by Privy has never
held any, so an "Approve" button alone fails with a Latin error. `server/gas.js` now
drips a capped dust amount from the operator key: `GET /api/gas/status|config|challenge`,
`POST /api/gas/request`, authorized by a signature over a gateway-issued nonce
(the recovered address must equal the address being funded), and bounded by a
per-address 24 h cooldown, a 0.005 BTC daily cap, a 0.02 BTC total cap, and a 0.01
BTC reserve that keeps the owner key able to pay for its own transactions. Only a
**registered agent wallet** can ask, so it is not an open BTC faucet. The popup also
links Mezo's own `https://faucet.test.mezo.org`, which costs the operator nothing.
State lives in gitignored `server/gas-state.json`.

**43. "Needs gas" was a hardcoded guess, and the guess was wrong.** The first
version dripped below its own threshold: `needsGas` was `balance < 0.0001 BTC`, but
the drip sends 0.00005 — so a wallet that had *just been dripped* was still told it
had no gas, and the popup kept showing its red box after the fix landed. The
threshold is now derived from the live cost: `gasThreshold() = max(gasPrice ×
approveGasUnits × 50, 1e-8 BTC)`, which at today's gas price is 1e-8 BTC — one drip
is 5 707 762 approvals. `/api/gas/status` reports `needsAtLeastBtc` and
`approvalsPerDrip` so the number on screen can be checked against the number
enforced, and `/api/gas/request` raises the amount it sends if the configured drip
would not clear the threshold (a drip that does not fix the problem still burns the
user's cooldown).

**44. `res.json()` threw on a BigInt — for the third time.** `/api/gas/status`
spread the wallet object into the response, and `balanceWei` is a BigInt:
`Do not know how to serialize a BigInt`. Same trap as §36 and the earlier
`/api/health` one. `server/gas.js` now exposes `publicWallet()`, a serializable view,
and keeps BigInts for internal arithmetic. The test harness was caught by the same
thing (`eq()` did `JSON.stringify` on both sides) and now renders BigInts explicitly
as `123n`, so `1n` and `1` stay unequal — which is what a test wants to see.

**45. The daily cap was not a cap on spending.** The largest bug found in this
project, and it was found by a live test of the new automation: eight purchases of
0.001 MUSD went through a 0.005 MUSD daily cap without one refusal, and the wallet
lost 0.008 MUSD. The cause is a field whose name means something else. The treasury
keeps `dayFunded` — *"MUSD released so far in dayIndex"* — and `agentStatus()`
exposes `remainingToday = dailyCap - dayFunded`. That is a cap on **funding**: how
much more float the treasury may release today, enforced on-chain in `fundAgent()`.
Nothing in the payment path touches it. The gateway was comparing each *payment*
against it, which made `daily_cap` a second per-call max — and for an agent whose
float arrived by any route other than `fundAgent()` (the faucet transfers MUSD
directly), `dayFunded` stays 0 and `remainingToday` stays equal to the whole cap
forever. The daily **spend** cap is now enforced where this architecture always said
per-payment policy lives: `server/spend.js` sums the treasury's own on-chain
receipts (`paymentsByAgent()`, newest first) for the current UTC day — taken from
the chain's block timestamp, not the host clock, because that is what the receipts
are stamped with — and `judgeDailySpend()` decides. It fails **closed**: an
unreadable receipt window is `spend_read_failed`, and a window full of today's
receipts is `truncated` (the sum is only a lower bound, so the gateway refuses
rather than guess; widen it with `DAILY_SPEND_LOOKBACK`). Every policy answer now
carries the `budget` it was judged with — `spentToday`, `leftToday`,
`projectedAfterThis`, `receiptsRead`, `truncated`, and the contract's counter under
its real name, `fundingHeadroomToday`. Five UI stats that said **"Left today"**
while showing the funding counter are relabelled, and the refusal says what it
counted: *"0.001 MUSD would take today's spend to 0.006 MUSD, over the 0.005 MUSD
daily cap — 0.005 already spent across 5 on-chain receipts"*. Verified live by
`npm run test:autopay:live`: five purchases, 0.005 MUSD, the sixth refused, denial
`0x81caa880…` on chain, `paymentCount` +5, `denialCount` +1, and the funding counter
unmoved at 0.005 the whole time.

**46. `eth_getTransactionReceipt` on `rpc.test.mezo.org` lags, and sometimes
crashes.** A mined transaction can return a null receipt for minutes — and the RPC
was also observed answering `-32603 method handler crashed` for a hash
`eth_getTransaction` reported as mined with a block number. Three test scripts
asserted a receipt immediately after settlement and failed on a chain that had done
nothing wrong. They now poll briefly and accept `getTransaction().blockNumber` as
proof, saying plainly that the receipt is lagging. The gateway survives the same
errors through its `unhandledRejection` handler, which is worth knowing: without it
a receipt lookup like that would take the process down.

**47. Mezo's hosted demo has bad streaks, not just off moments.** §"The in-process
demo seller is flaky" recommended `https://demo.vativ.io/` because our own seller
charged without delivering about half the time. On 2026-10-25 the hosted demo did
the same thing three runs in a row, then recovered. So neither endpoint is reliable
enough to be the only one in a test or a recording: `e2e-autopay.mjs` switches to
the gateway's own seller after two consecutive non-deliveries (and keeps the
abandoned runs in every money assertion, because their MUSD moved and counted
against the cap), and `WALKTHROUGH.md` says what to do if it happens on camera.
`charged_without_delivery` is still recorded as a **payment**, because the charge is
real — the run log now labels it "charged, no delivery" rather than folding it into
either success or failure.

**48. Six deployment blockers, and not one of them was visible to a unit test.**
Asked whether the gateway would work on Render with the frontend on Vercel, the
honest answer required reading `app.listen`, the CORS middleware and every client
`fetch` — none of which any existing suite touched. What was wrong: the gateway
ignored `process.env.PORT` and bound `127.0.0.1`, so a PaaS could not route to it;
every client call was relative (`/api/…`), which only works behind the Vite dev
proxy; `cors()` was wide open; `/api/pause` and `/api/unpause` were
**unauthenticated**, so a public gateway could be paused by anyone who found the
URL with one POST; the four `*-state.json` files lived beside the code, which
Render's ephemeral filesystem wipes on every deploy — making a restart a way to
claim the faucet again; and `render.yaml` carried `disk.sync: false`, an
envVar-only key. `npm run test:deploy` now boots the real gateway as a child
process in both modes and asserts over HTTP, because that is the only shape of
test that can see any of it.

**49. The CORS wildcard matched the shared apex.** `GATEWAY_ALLOWED_ORIGINS=https://*.vercel.app`
compiled `*.` to `(?:[a-z0-9-]+\.)*` — *zero* or more labels — so
`https://vercel.app` itself was accepted. That is not a theoretical bypass: any
stranger's Vercel deploy could call a gateway holding a signing key, and the
gateway would answer 200 with an echoed `Access-Control-Allow-Origin`. Only a live
`curl -H "Origin: https://vercel.app"` caught it; every unit-level assertion about
"the allowlist" passed while it was open. Fix: `+`, one-or-more. Now pinned by
`test:deploy` (subdomain-spoof `https://agentfloat.vercel.app.evil.com`, path-spoof
`https://evil.com/https://agentfloat.vercel.app`, `null`, and scheme downgrade all
403) and by a `check:client` custom check that reads the compiled expansion.
**Lesson: a wildcard in a security allowlist is a claim about a domain you do not
own, and the only way to test it is against the apex you were trying to exclude.**

**50. A white border flashed around the boot spinner.** The pre-hydration shell had
no background of its own: `<html>` and `<body>` were unstyled until `index.css`
arrived, so the browser painted its default white around the ring — top, left and
right, before any React code ran. Fixed in `index.html` with an inline
`background-color:#080a10` on **both** elements plus `color-scheme:dark`, and the
spinner's own `@keyframes` inline so it animates before the stylesheet loads. The
boot indicator remains the ring alone with no text, per the standing decision.
**Lesson: anything that must be true before the bundle loads cannot be fixed in the
bundle.**

**51. A chart with no data must not draw a flat zero line.** The first cut of the
dashboard sparkline rendered `0` for an empty series, which on a fresh deployment —
exactly what a judge sees first — reads as "this protocol is dead". That is a
different claim from "you have not paid for anything yet", and only words can make
it. `Sparkline` now refuses to draw below two buckets and renders `ChartEmpty`
instead, and `activitySummary()` returns `avgWei: null` rather than `0n` for the
same reason: an average of zero says "the average payment was free".

**52. The dashboard could have contradicted its own enforcement.** The charts bucket
receipts by day; `server/spend.js` decides which day a receipt counts toward for
the daily cap. Two implementations of "what day is this" in two processes is how a
UI ends up showing spend the policy disagrees with — and a local-time bucket would
do it for every user not in UTC+0, silently. They are now cross-checked in the same
suite: `test:charts` asserts `bucketSeries()` and `dayStartSec()` agree on 14 probe
timestamps (midnight, midday, 23:59:59, epoch edges, now). **Lesson: when a display
and an enforcement rule share a boundary, test the boundary, not each side.**

**53. A pattern check that cannot fail is decoration — and most of mine could not.**
Mutation-testing the 28 new `check:client` entries found 5 that passed against
deliberately broken code, for three reasons worth remembering:
*prefix matches* — `/\.ring-spin/` also matches `.ring-spinX`, and
`/const DAY = 86400/` also matches `const DAY = 86400 + getTimezoneOffset()*60`, so
a genuine local-time bug sailed through (fixed with `\b` and an anchored `;`);
*OR'd guarantees* — `/vector-effect|non-scaling-stroke/` survived deleting either
half, and `/minPoints|ChartEmpty/` survived deleting either component (split into
separate checks, each with its own failure message);
*comment-only mutations* — replacing the first occurrence of `role="radiogroup"`
hit a JSDoc line, and `stripComments()` removed it before the check ran, so the
mutation tested nothing (mutate code, not prose).
Also learned the hard way: `Number(...)` in a `bad` pattern missed the real loop
because the variable there is called `raw`, not `amountWei` — assert the
accumulation (`/\+= BigInt\(/`), not a guess at its operands.

**54. Closing the sign-in popup was reported as a failure, in language meant for us.**
The toast that appeared when a visitor clicked the X on the Privy modal read
"Sign-in failed / code: exited_auth_flow", then explained that wallet extensions
inject scripts which can break the iframe handshake, linked to status.privy.com and
`/diagnose`, and suggested `npm run check:client`. Two separate bugs, one visual:

*Privy uses one code for two opposite events.* `exited_auth_flow` covers both "the
person dismissed the modal" and "the flow was torn down mid-handshake" — and the
second one is real here, because a double-mounted provider strands an id-keyed
cross-window event queue (finding 27). Nothing in the code string separates them, so
the DOM does: `window.__agentfloatBridgeMounts`, `__agentfloatBridgeUnmounts` and the
Privy iframe count. Those measurements already existed — privately, inside
`Diagnose.jsx`, where a human reads them. They moved to `src/lib/privy-dom.js` and
`privyStructuralFault()` now returns a verdict plus the reasons in words. Healthy (1
mount, 0 unmounts, 1 iframe) means the person cancelled; anything else means the page
is broken and must still be reported as broken. `onError` previously disagreed with
the watchdog in the same file, whose comment already said an abandoned flow means
"nothing actually went wrong".

*Every hint was written for whoever maintains the repo.* Not just the fallback —
all of `PRIVY_ERROR_HINTS` referenced `VITE_PRIVY_APP_ID`, `frontend/.env`,
`npm run check:privy`, `loginMethods in src/lib/privy.js` and the dashboard
allowlist. Accurate, and addressed to the wrong reader. `src/lib/auth-errors.js` now
returns two strings per outcome: `user` (plain language, at most one action, never
blaming) and `dev` (the old technical text, unchanged in substance). The toast shows
`user`; `dev`, the raw code, `/diagnose` and the shell command sit behind a
"Technical details" button. Nothing was deleted to make it friendlier — it was moved
one click away, because the person who needs it is a maintainer and they know to look.
A cancellation is `tone: "neutral"`, logs at `console.info` rather than `error`, and
clears itself after 7 s; genuine failures keep the red styling and never auto-dismiss,
because a message that vanishes on a timer is one the person did not get to read.

`npm run test:auth` — 274 offline assertions, mutation-tested 15/15 — holds the line:
a dismissal is not a failure, no maintainer vocabulary reaches `title`/`user` for any
of the 19 codes in either context state, the `dev` layer still carries all twelve
technical markers, and **every tone the classifier can emit is one `TOAST_TONE` in
`Navbar.jsx` can render**. That last one reads the real map out of the component
instead of duplicating its keys, because an unmapped tone falls back to the red
styling — which would silently reintroduce the bug with no failing test anywhere else.
The insecure-context override replaces the classification rather than appending to it
(two explanations invite the reader to act on the wrong one) but exempts cancellations,
so closing a popup on a LAN IP cannot escalate back to red.
**Lesson: prose is not exempt from correctness because it is prose. The old copy was
factually true in every sentence and wrong in audience — and "true but addressed to
the wrong reader" is invisible to a test that only checks behaviour.**

**55. Two ways a new pattern check was worthless, found by mutating it.**
Adding checks for the above and mutation-testing all 24 found three survivors.
*Asserting a field is read is not asserting it is guarded:* requiring
`err.autoDismissMs` in the toast was satisfied by the `setTimeout` argument alone, so
deleting the `if (!err.autoDismissMs)` guard — which makes every real failure
disappear on a 7-second timer — passed cleanly. The check now requires the guard
string as well as the field. *A substring ban fires on your own identifiers:* banning
`.env` from the user-facing branch matched `AUTH_OUTCOME.environment`, producing a
failure indistinguishable from a real leak — and a check that cries wolf on clean code
is a check that gets ignored, which is worse than no check. It is now
`/\.env(?!ironment)/`.
Also worth recording: two of the three "survivors" were bad mutations, not weak checks
— renaming `const DEV` to `const DEV_UNUSED` and re-declaring it left every entry
intact, and prefixing a definition with `const ZZZ = 1;` did not move it. **A mutation
has to break the thing it claims to break; verify the mutated file actually differs in
the intended way before concluding the check is weak.**


---

## The in-process demo seller is flaky — use Mezo's hosted demo

Our own seller runs in the same Node process as the payer. Roughly half of
payment attempts against it return **HTTP 402 *after* the facilitator has already
settled the transfer**, so the agent is charged and receives an empty body. The
same code path against **Mezo's hosted demo settles and delivers reliably**.

The seller is mounted exactly as Mezo's quickstart specifies
(`paymentMiddleware` + `x402ResourceServer` + `ExactEvmScheme`), so the fault is
in that self-call interaction, not in our policy layer. It is not worth
deep-debugging SDK internals for demo plumbing, and it is no longer dangerous:
the chain check in fix 3 detects the charge and reports it honestly.

**So the dashboard now defaults to `https://demo.vativ.io/`.** The built-in
seller remains one click away as a preset. Defaulting to a third-party endpoint
is also the stronger demo — it proves interoperability rather than a self-loop.

---

## Not done, and not faked

**sMUSD surplus yield is mainnet-only.** The savings vault proxy `0xb4D4…51CC`
has **0 bytes of bytecode on testnet** and 1,159 on mainnet. The dashboard
renders the vault panel as *unavailable on testnet* with that reason. It is not
mocked, and no fake APR is shown.

It is also **not ERC-4626** on mainnet — every standard getter reverts. The real
interface is `deposit(uint256)` / `withdraw(uint256)` / `token()`. Yield accrues
in the exchange rate, distributes weekly, and is variable and not guaranteed.
Wave 2 builds the adapter against that interface.

**Telegram alerts are built but not switched on here.** No
`TELEGRAM_BOT_TOKEN` in `server/.env`, so `/api/telegram/challenge` answers
**503** with the BotFather hint and the Alerts page shows the setup steps. No
alert is simulated in the meantime: a notification that was never sent is worse
than none, because the user believes it was.

**Per-payment caps are still gateway-enforced, not contract-enforced.** A
contract cannot veto an x402 payment (the authorization is an EIP-712 signature
only an EOA can produce), so on-chain enforcement lands on *funding*. The
permit2-spender policy contract that closes the gap is Wave 2.

**A relayed purchase is a trusted hop.** The relay is what makes browser wallets
able to pay sellers with no CORS headers, and the signature stays in the browser —
but the gateway sees the request and the response body. It cannot sign and cannot
exceed the caps; it can read what was bought. That is why the relay is
per-purchase, labelled in the UI, and never the only path.

**Self-service ceilings live in env, not in the contract.** `USER_PER_CALL_MAX_MUSD`
/ `USER_DAILY_CAP_MUSD` / `USER_MIN_PER_CALL_MUSD` are an operator choice. Making
them on-chain (and per-agent, set at registration) is a Wave 2 change.

---

## Reproduce the demo

```bash
cd agentfloat
npm run install-all        # contract, server, frontend, root

cp frontend/.env.example frontend/.env    # add VITE_PRIVY_APP_ID for sign-in
cd ..

# gateway (127.0.0.1:4022) + dashboard (0.0.0.0:5173), one command
cd agentfloat && npm run dev
```

Then, against the running gateway:

```bash
# what would this cost, and does policy allow it?
curl -s -X POST localhost:4022/api/quote -H 'Content-Type: application/json' \
  -d '{"url":"https://demo.vativ.io/"}'

# pay it for real
curl -s -X POST localhost:4022/api/pay -H 'Content-Type: application/json' \
  -d '{"url":"https://demo.vativ.io/"}'

# the on-chain audit log
curl -s 'localhost:4022/api/chain-records?limit=10'

# --- self-service budget: challenge, then sign in the wallet, then apply -----
curl -s 'localhost:4022/api/limits/config'
curl -s 'localhost:4022/api/limits/challenge?action=limits&address=0xF8F56f404DB1cDb9E03b66F37D916183f4f32686&perCallMax=1.5&dailyCap=30'
#   → sign the returned `message` with THAT wallet (personal_sign), then:
curl -s -X POST localhost:4022/api/limits/apply -H 'Content-Type: application/json' \
  -d '{"nonce":"<from the challenge>","signature":"0x…"}'
curl -s 'localhost:4022/api/limits/history?address=0xF8F56f404DB1cDb9E03b66F37D916183f4f32686'

# --- the relay: probe a CORS-less seller, sign locally, then execute ---------
curl -s -X POST localhost:4022/api/relay/probe -H 'Content-Type: application/json' \
  -d '{"url":"https://demo.vativ.io/","agent":"0xF8F56f404DB1cDb9E03b66F37D916183f4f32686"}'
#   → the browser signs that 402 into an X-PAYMENT header, then:
curl -s -X POST localhost:4022/api/relay/execute -H 'Content-Type: application/json' \
  -d '{"url":"https://demo.vativ.io/","agent":"0xF8F5…","payment":"<X-PAYMENT header>"}'
curl -s -X POST localhost:4022/api/relay/probe -H 'Content-Type: application/json' \
  -d '{"url":"http://169.254.169.254/latest/meta-data/","agent":"0xF8F5…"}'   # → bad_protocol

# --- alerts: honest 503 until a bot token exists -----------------------------
curl -s localhost:4022/api/telegram/config
curl -s -i 'localhost:4022/api/telegram/challenge?address=0xF8F56f404DB1cDb9E03b66F37D916183f4f32686'

# --- the offline suite (no chain, no token, no network) ----------------------
npm run test:gateway        # 86 assertions
```

To watch the treasury refuse a payment, drop the cap below the price and try
again — then restore it:

```bash
cd contract
AGENT_ADDRESS=0xF8F56f404DB1cDb9E03b66F37D916183f4f32686 PER_CALL_MAX=0.0005 node scripts/set-limits.js
#   ... POST /api/pay now returns 403 per_call_max, and no MUSD moves ...
AGENT_ADDRESS=0xF8F56f404DB1cDb9E03b66F37D916183f4f32686 PER_CALL_MAX=2      node scripts/set-limits.js
```

---

## Before submission (Wave 1 closes Oct 26, 11:00)

- [x] Contract deployed and verified on testnet
- [x] Agent registered with on-chain caps and both allowances
- [x] Real MUSD x402 payments settling end to end (7 transfers, 0.007 MUSD)
- [x] Paid a **third-party** seller (Mezo's hosted demo), not just our own
- [x] Policy refusals recorded on chain
- [x] Ledger reconciled against MUSD `Transfer` logs
- [x] Gateway moved to `server/` at the repo root; all five hardcoded paths fixed
- [x] Frontend rebuilt on Tailwind v4 with nine routed pages
- [x] Faucet built and security-tested (15 assertions: legit claim, cooldown,
      forged, replayed, tampered)
- [x] Privy integration built, lazy-loaded, and verified to render
- [x] **Set `VITE_PRIVY_APP_ID`** — done, `cmvjxsrk801n40hku6ttpkbxw`
      ("Agentfloat"). Google, email and wallet login are on, smart wallets are
      off, `allowed_domains` covers both localhost origins, and
      `embeddedWallets.ethereum.createOnLogin` is `"all-users"`. Re-verify any
      time with `cd frontend && npm run check:privy`.
- [ ] **Sign in once with Google and confirm an agent wallet appears.** Reported
      symptom: on `http://localhost:5173/` the modal *opens, loads, then
      disappears*. That origin is allowlisted and is a secure context, so it is
      not `invalid_origin` and not WebCrypto. That fingerprint is
      `PrivyProvider` being torn down mid-handshake — `<React.StrictMode>` in a
      stale `src/main.jsx`, or a second `createRoot()`. **Run
      `cd frontend && npm run check:client` on the machine showing the symptom**;
      it names the stale file. If it passes, the new toast will now show the
      `PrivyErrorCode` instead of failing silently (fixes 24–25).
- [ ] Verify the browser x402 path with a real Privy login (`lib/x402-browser.js`
      is written and code-split, but cannot be exercised without a browser —
      the gateway path is the one that is proven on chain. The relay's server
      half IS proven: `/api/relay/probe` decoded Mezo's hosted demo offer and
      returned `policy.allowed:true`, and the guard refusals are asserted)
- [ ] Visually confirm the redesigned landing page and the role-based navbar
      (written and compiling; all 3,942 modules of the served graph resolve with
      0 transform errors and 0 raw-CommonJS landmines, but `playwright-cli` is
      absent here so it has never been rendered)
- [x] **Self-service budget changes verified on chain** — challenge → wallet
      signature → owner-key `setAgentLimits`, read back from `agentStatus()`
      (txs `0xc4eda4c0…e22b` and the restore `0x5a9f4697…99f7`), plus forged /
      replayed / tampered signatures and all four ceiling refusals
- [x] **The relay verified against a CORS-less third-party seller** —
      `https://demo.vativ.io/` probed at 402, offer decoded, `policy.allowed:true`,
      SSRF refusals asserted (see §Wave 1 additions)
- [x] Offline gateway suite green: `npm run test:gateway`, 86 assertions
- [ ] **Set `TELEGRAM_BOT_TOKEN` and confirm an alert arrives in Telegram.** The
      code path, the signature binding and the renderer are tested offline; what
      has never happened is a real `sendMessage` round trip. On this gateway
      `/api/telegram/challenge` correctly answers 503 until the token exists.
- [ ] Sign in as an ordinary user (no owner key) and confirm the product reads as
      theirs: faucet → caps on Operate → a relayed purchase on Spend → alerts on
      Alerts. Zone two must explain itself, not just grey out.
- [ ] Public deployment of the dashboard (currently local only; `npm run build`
      needs ~4GB RAM, which this sandbox does not have)
- [ ] Demo video / screenshots for the submission
- [ ] Repo pushed and linked in the submission form
- [ ] Decide whether to disclose the two ledger artifacts in the submission
      (recommendation: yes — they prove the audit log is real and that the
      classification is verified against the chain, not against HTTP)
