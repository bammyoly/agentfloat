// ---------------------------------------------------------------------------
// Architecture — Wave 2.
//
// Three defense layers, native Mezo composition (BorrowerOperations + sMUSD),
// and session-authenticated payments with strict quote binding. Everything
// stated plainly, including what a compromised gateway can and cannot do.
// ---------------------------------------------------------------------------

import React from "react";
import { Network } from "lucide-react";
import { Link } from "react-router-dom";
import { useAppData } from "../lib/app-data.jsx";
import { Badge, Button, Card, Dot, Note, PageHeader, AddressLink } from "../components/ui.jsx";
import {
  CHAIN, TREASURY_ADDRESS, TREASURY_OWNER, IS_DEPLOYED, MUSD_ADDRESS, SAVINGS_VAULT,
} from "../contracts/index.js";

export default function Architecture() {
  const { health } = useAppData();
  const vaultAddress = SAVINGS_VAULT?.address || health?.chain?.savingsVault?.address || null;

  return (
    <div className="animate-fade space-y-6 pb-10">
      <PageHeader
        icon={Network}
        eyebrow="Design · Wave 2"
        title="How AgentFloat holds a limit — and earns yield while it waits"
        sub="Three defense layers, each failing safe. Native Mezo composition: BTC-collateralised MUSD in, sMUSD yield while idle, x402 settlement out. Session-authenticated, strictly quote-bound."
      />

      {/* ──────────────── 3-LAYER DEFENSE ──────────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Layer 1 · the treasury" aside={<Badge tone="ok">on chain</Badge>}>
          <p className="text-[14px] leading-relaxed text-muted">
            <span className="text-text">AgentFloatTreasury</span> holds the budget and releases float
            to agent wallets under a per-call maximum and a per-UTC-day cap. Both are enforced in the
            contract, not in the gateway, so they hold even if everything else is compromised.
          </p>
          <p className="mt-3 text-[14px] leading-relaxed text-muted">
            An agent can never spend more than has passed through{" "}
            <span className="code">fundAgent</span>. That is the hard limit.
          </p>
        </Card>

        <Card title="Layer 2 · the gateway" aside={<Badge tone="warn">trusted</Badge>}>
          <p className="text-[14px] leading-relaxed text-muted">
            The agent's only route out. It verifies the session token, rate-limits, probes the seller
            unpaid, decodes the real <span className="code">PAYMENT-REQUIRED</span> header, and
            refuses to sign anything that breaks quote binding, exceeds the cap, hits an unapproved
            endpoint, pays a non-MUSD asset, lands on the wrong network, or arrives while paused.
          </p>
          <p className="mt-3 text-[14px] leading-relaxed text-muted">
            Expressive and fast — but trusted, because it decrypts an agent key per-request. Layers 1
            and 3 bound the damage if it is compromised.
          </p>
        </Card>

        <Card title="Layer 3 · the wallet" aside={<Badge tone="info">backstop</Badge>}>
          <p className="text-[14px] leading-relaxed text-muted">
            The agent EOA's own balance. Leak the key and an attacker still only gets what is in that
            wallet — bounded by layers 1 and 2 — and the retrieve route sweeps unspent MUSD back to
            the session-verified primary owner only, never to an attacker-supplied address.
          </p>
        </Card>
      </div>

      {/* ──────────────── WAVE 2 SECURITY FIX ──────────────── */}
      <Card
        title="/api/pay, Wave 2 — the High finding, fixed in six steps"
        aside={<Badge tone="ok"><Dot tone="ok" /> Wave 2 hardening</Badge>}
      >
        <p className="text-[14px] leading-relaxed text-muted">
          Wave 1's <span className="code">/api/pay</span> was unauthenticated and signed whatever quote
          came back from the seller probe — a per-call cap bypass up to the full daily float. Wave 2
          rebuilt the route around session authentication and strict quote binding. Every request now
          passes through six independent gates before the gateway signs anything.
        </p>
        <ol className="mt-4 space-y-2.5 text-[14px] leading-relaxed text-muted">
          <Num n={1}>
            <b className="text-text">Session auth.</b>{" "}
            <span className="code">requireSession</span> middleware demands an{" "}
            <span className="code">X-Session-Token</span> header issued by{" "}
            <span className="code">/api/session/login</span> after an EIP-191 signature from the
            primary wallet. No token, no signing — not even a probe.
          </Num>
          <Num n={2}>
            <b className="text-text">Rate limit.</b> 10 requests per minute per session. A runaway
            agent cannot drain the daily cap in a hot loop before a human can intervene.
          </Num>
          <Num n={3}>
            <b className="text-text">Quote probe &amp; parse.</b> The gateway fetches the URL unpaid,
            decodes <span className="code">PAYMENT-REQUIRED</span>, and extracts{" "}
            <span className="code">{"{amount, asset, payTo, network, nonce}"}</span>.
          </Num>
          <Num n={4}>
            <b className="text-text">payTo whitelist.</b> With{" "}
            <span className="code">TREASURY_ADDRESS</span> set, only that exact recipient is
            accepted. A seller that quotes a different <span className="code">payTo</span> is refused
            before any signing.
          </Num>
          <Num n={5}>
            <b className="text-text">Nonce replay guard.</b> MongoDB-backed, 1-hour TTL. The same
            quote nonce cannot be paid twice — a replayed API response cannot double-charge.
          </Num>
          <Num n={6}>
            <b className="text-text">Strict quote binding.</b> The gateway signs the x402 payload
            against the <i>probed</i> quote, not against anything in the request body. After
            settlement it compares the facilitator's reported amount back against the probed one;
            a mismatch is logged with{" "}
            <span className="code">warning: "quote_mismatch"</span> and the HTTP response surfaces
            both values side by side.
          </Num>
        </ol>
        <Note tone="ok" className="mt-4">
          <b className="text-text">Then and only then</b> the on-chain policy engine runs: treasury
          caps, Permit2 allowance, endpoint allowlist, SSRF guard, insufficient-float check. If any
          of them refuse the gateway records a <span className="code">PolicyDenied</span> event on
          chain and pushes a Telegram alert. If they allow, it ensures JIT liquidity from sMUSD,
          signs, settles, and writes a verified receipt.
        </Note>
      </Card>

      {/* ──────────────── NATIVE MEZO COMPOSITION ──────────────── */}
      <Card
        title="Native Mezo composition — no operator faucet, no mocked yield"
        aside={<Badge tone="btc">Wave 2 composition</Badge>}
      >
        <p className="text-[14px] leading-relaxed text-muted">
          Wave 1 funded agents from an operator wallet — real money, but still a centralised drip. Wave
          2 removes the operator entirely from the user funding path and composes directly with the
          Mezo stack: collateral, debt, and yield all run through contracts the chain owns, with the
          treasury only as a policy wrapper around the agent wallet.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-line-soft bg-ink-dim/50 p-4">
            <div className="text-[12.5px] uppercase tracking-[0.14em] text-dim">BorrowerOperations</div>
            <div className="mt-1 text-[14px] text-text">native BTC → MUSD</div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-dim">
              The Earn page deposits BTC collateral to Mezo's{" "}
              <span className="code">BorrowerOperations.openTrove()</span> at a user-chosen safety
              ratio ≥ 110% MCR; MUSD is minted directly to the connected wallet with transparent fee
              accounting (borrowing fee + 200 MUSD gas comp, refunded on close).
            </p>
          </div>
          <div className="rounded-xl border border-line-soft bg-ink-dim/50 p-4">
            <div className="text-[12.5px] uppercase tracking-[0.14em] text-dim">sMUSD Savings Rate</div>
            <div className="mt-1 text-[14px] text-text">idle float earns</div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-dim">
              A background sweep loop (every 5 min, threshold 50 MUSD) deposits idle agent MUSD into
              Mezo's sMUSD vault. JIT{" "}
              <span className="code">ensureLiquidity()</span> withdraws the exact delta before{" "}
              <span className="code">/api/pay</span> settles — payments never fail because the float
              is earning.
            </p>
          </div>
          <div className="rounded-xl border border-line-soft bg-ink-dim/50 p-4">
            <div className="text-[12.5px] uppercase tracking-[0.14em] text-dim">Retrieve path</div>
            <div className="mt-1 text-[14px] text-text">owner-locked exit</div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-dim">
              <span className="code">POST /api/agent/retrieve</span> pulls unspent MUSD from the
              agent back to the primary wallet. The destination is read from{" "}
              <span className="code">req.session.primaryAddress</span> — never the request body — so
              a stolen session cookie can still only move funds to their rightful owner.
            </p>
          </div>
        </div>
        <Note className="mt-4">
          <b className="text-text">Revenue model.</b> The vault takes a 15% performance share on sMUSD
          yield (the protocol fee bps is readable on chain), plus a ~0.05% micro-fee on x402 settle
          volume. No subsidy, no faucet dependency — the business model composes with the Mezo stack
          the same way the product does.
        </Note>
      </Card>

      {/* ──────────────── WHO MAY CHANGE A CAP ──────────────── */}
      <Card
        title="Who may change a cap"
        aside={<Badge tone="btc">authority</Badge>}
      >
        <p className="text-[14px] leading-relaxed text-muted">
          <span className="code">setAgentLimits()</span> is{" "}
          <span className="code">onlyOwner</span>, and that is deliberate. An agent that can raise its
          own ceiling is not budget-controlled: a prompt-injected or merely buggy agent would lift its
          own limit and the "hard cap" would become a suggestion. So the authority to <i>choose</i> a
          number and the authority to <i>enforce</i> the envelope are separated.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-line-soft bg-ink-dim/50 p-4">
            <div className="text-[12.5px] uppercase tracking-[0.14em] text-dim">the user</div>
            <div className="mt-1 text-[14px] text-text">authorizes one specific change</div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-dim">
              signs a gateway-written EIP-191 message containing the address, both values and a
              single-use nonce — from the primary wallet via Reown AppKit (MetaMask, WalletConnect,
              Coinbase Wallet)
            </p>
          </div>
          <div className="rounded-xl border border-line-soft bg-ink-dim/50 p-4">
            <div className="text-[12.5px] uppercase tracking-[0.14em] text-dim">the protocol</div>
            <div className="mt-1 text-[14px] text-text">caps the envelope</div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-dim">
              per-call ≤ 5 MUSD, daily ≤ 50 MUSD, daily ≥ per-call, 12 changes per address per hour —
              because each one is an owner transaction paid in real gas
            </p>
          </div>
          <div className="rounded-xl border border-line-soft bg-ink-dim/50 p-4">
            <div className="text-[12.5px] uppercase tracking-[0.14em] text-dim">the owner key</div>
            <div className="mt-1 text-[14px] text-text">executes it on chain</div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-dim">
              recovers the signer, burns the nonce <i>before</i> the transaction, and refuses on any
              mismatch — so a replay cannot double-apply and a stolen signature cannot be retargeted
            </p>
          </div>
        </div>
        <Note className="mt-4">
          Nothing in the second request is trusted but the signature: the values applied are exactly
          the values that were signed. The same shape authorizes a Telegram binding, a freeze and an
          unfreeze — one mechanism, four actions, each with its own message text, so a signature for
          one cannot be replayed as another.
        </Note>
      </Card>

      {/* ──────────────── RELAY ──────────────── */}
      <Card
        title="Browser signs, gateway fetches"
        aside={
          health?.relay?.enabled
            ? <Badge tone="ok"><Dot tone="ok" /> relay enabled</Badge>
            : <Badge tone="warn">relay off</Badge>
        }
      >
        <p className="text-[14px] leading-relaxed text-muted">
          Sellers answer a paid request from a server, and almost none of them send{" "}
          <span className="code">Access-Control-Allow-Origin</span>. A browser that fetches the 402
          itself therefore dies with <span className="code">Failed to fetch</span> — before it ever
          gets to sign. That is not a bug in the app or in x402; it is CORS doing its job.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          So the two halves are separated, and only the half that needs no trust is relayed:
        </p>
        <ol className="mt-3 space-y-3 text-[14px] leading-relaxed text-muted">
          <Num n={1}>
            <b className="text-text">Probe</b> — <span className="code">POST /api/relay/probe</span>{" "}
            fetches the URL unpaid and returns the filtered 402 headers, the body, the decoded offer
            and the policy verdict for this agent.
          </Num>
          <Num n={2}>
            <b className="text-text">Sign, server-side</b> — the agent's encrypted private key is
            decrypted in-memory within the authenticated session context and signs the permit2
            payload. The key never reaches the browser; the primary wallet already authorised the
            session with EIP-191.
          </Num>
          <Num n={3}>
            <b className="text-text">Execute</b> — <span className="code">POST /api/relay/execute</span>{" "}
            re-checks the URL, checks the payment header's payer against the session agent
            (<span className="code">403 payer_mismatch</span> otherwise), fetches with{" "}
            <span className="code">X-PAYMENT</span>, then proves settlement from the canonical MUSD{" "}
            <span className="code">Transfer</span> logs and records it on chain.
          </Num>
        </ol>
        <div className="mt-4 space-y-3">
          <Note tone="warn">
            <b className="text-text">What this costs.</b> The gateway sees the request and the
            response body in plaintext: a relayed hop is a privacy hop, and it is why the relay is
            opt-in per purchase, labelled in the UI, and never the only path. A seller that does send
            CORS headers can still be paid directly.
          </Note>
          <Note>
            <b className="text-text">What guards it.</b> A public relay endpoint is an SSRF hole
            without them, so: https only (http for the gateway's own origins alone), an optional
            allowlist checked <i>before</i> any DNS lookup, every resolved address tested against
            private and link-local ranges (hostnames are resolved — a name blocklist is bypassed by
            DNS rebinding), <span className="code">redirect: "manual"</span> because a redirect is an
            unchecked second URL, a 512 KB body cap and a 20 s timeout. Judged in that order, so an
            unlisted host is refused without ever resolving it.
          </Note>
        </div>
      </Card>

      {/* ──────────────── ALERTS ──────────────── */}
      <Card
        title="Alerts are a data flow, not a feature bolt-on"
        aside={
          health?.telegram?.enabled
            ? <Badge tone="ok"><Dot tone="ok" /> bot connected</Badge>
            : <Badge tone="neutral"><Dot tone="warn" /> no bot token</Badge>
        }
      >
        <p className="text-[14px] leading-relaxed text-muted">
          A cap you have to watch a dashboard to see working is not much of a cap. So payments,
          refusals, budget changes, freezes, sMUSD deposits and withdrawals, and a once-a-day "20% of
          your daily cap is left" warning are pushed to Telegram.
        </p>
        <ul className="mt-3 space-y-1.5 text-[14px] text-muted">
          <Bullet>
            <b className="text-text">No webhook.</b> The gateway long-polls{" "}
            <span className="code">getUpdates</span>, so it runs behind NAT without a public URL. A
            409 from Telegram means a second poller — logged loudly and backed off for 60 s rather
            than fought over.
          </Bullet>
          <Bullet>
            <b className="text-text">Binding is signature-authorized.</b> Otherwise anyone who knows
            an address could receive — or silence — somebody else's spending alerts.
          </Bullet>
          <Bullet>
            <b className="text-text">Stored: one chat id per address</b>, in MongoDB alongside the
            session store. No key, no message history beyond the last send attempts, which the Alerts
            page shows so a silent failure is visible.
          </Bullet>
          <Bullet>
            <b className="text-text">Best-effort by design.</b> A blocked bot or a Telegram outage
            must never fail a payment or a budget change, so every notify is fire-and-forget.
          </Bullet>
          <Bullet>
            <b className="text-text">The watcher reads the chain</b>, not the gateway's memory, so an
            event the gateway never saw — a payment settled straight from a browser — still produces
            an alert.
          </Bullet>
        </ul>
        <Note tone="warn" className="mt-4">
          With no <span className="code">TELEGRAM_BOT_TOKEN</span> every alert endpoint answers 503
          and the UI shows the BotFather setup steps. Nothing is simulated: a notification that is
          not really sent is worse than none, because the user believes it was.
        </Note>
      </Card>

      {/* ──────────────── WHY AN EOA ──────────────── */}
      <Card title="Why the agent wallet must be an EOA">
        <p className="text-[14px] leading-relaxed text-muted">
          x402 on Mezo settles with <span className="code">assetTransferMethod: permit2</span>, which
          is an <b className="text-text">EIP-712 signature</b>. Only an externally-owned account can
          produce one. A contract wallet cannot sign it — it can only validate a signature someone
          else made, via ERC-1271, which standard x402 facilitators do not process.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          That single constraint shapes the whole design. Agent wallets are plain EOAs,{" "}
          <b className="text-text">AES-256-GCM encrypted at rest in MongoDB</b>, and decrypted in
          server memory only during an authenticated session. No ERC-4337 smart wallets, no
          EIP-7702 delegation, no browser-side key material.
        </p>
        <Note className="mt-4">
          <b className="text-text">The gateway is the trust boundary.</b> It holds the decryption key
          in process memory and therefore can sign on any registered agent's behalf while running.
          Layers 1 and 3 — on-chain caps and the agent's own wallet balance — survive the gateway;
          the Wave 2 session auth, rate limit and quote binding all exist to shrink the window in
          which a compromised gateway could do anything useful.
        </Note>
      </Card>

      {/* ──────────────── TWO ALLOWANCES ──────────────── */}
      <Card title="Two allowances, easy to confuse, both required">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr>
                <th className="th">Allowance</th>
                <th className="th">Spender</th>
                <th className="th">Purpose</th>
                <th className="th">If missing</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="td text-text">MUSD → Permit2</td>
                <td className="td font-mono text-[12.5px] text-muted">0x0000…8BA3</td>
                <td className="td text-muted">lets the facilitator <b className="text-text">pull</b> each payment</td>
                <td className="td text-muted">
                  every payment is rejected with HTTP 412; the quote looks perfect and policy allows
                  it, but no MUSD moves
                </td>
              </tr>
              <tr>
                <td className="td text-text">MUSD → treasury</td>
                <td className="td font-mono text-[12.5px] text-muted">{TREASURY_ADDRESS ? short(TREASURY_ADDRESS) : "—"}</td>
                <td className="td text-muted">lets the owner <b className="text-text">recall</b> unspent float</td>
                <td className="td text-muted">emergencyStop pauses but cannot sweep</td>
              </tr>
              <tr>
                <td className="td text-text">MUSD → sMUSD vault</td>
                <td className="td font-mono text-[12.5px] text-muted">{vaultAddress ? short(vaultAddress) : "0x6f46…8e16"}</td>
                <td className="td text-muted">lets the sweep loop <b className="text-text">deposit</b> idle float for yield</td>
                <td className="td text-muted">idle float stops earning; JIT withdraw falls back to the agent's existing balance</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Note className="mt-4">
          The Permit2 allowance cost a real failed run: it was missing, and the failure surfaced as
          an opaque HTTP 412 long after the quote had decoded correctly. The gateway now checks it in{" "}
          <span className="code">/api/health</span> and refuses up front with{" "}
          <span className="code">permit2_not_approved</span>. The "Enable payments" button on the
          Spend page executes the one-time approve server-side from the decrypted agent key.
        </Note>
      </Card>

      {/* ──────────────── LEDGER INTEGRITY ──────────────── */}
      <Card title="Ledger integrity: the chain is the source of truth">
        <p className="text-[14px] leading-relaxed text-muted">
          The audit log is the product, so a false entry in it is the worst bug AgentFloat could
          have. Two were found by actually deploying, in opposite directions:
        </p>
        <div className="mt-4 space-y-3">
          <Note tone="bad">
            <b>A payment that never happened.</b> The gateway recorded{" "}
            <span className="code">PaymentRecorded</span> for any response, including a 412 rejection
            where no MUSD moved. It now requires{" "}
            <span className="code">status &lt; 400</span> and{" "}
            <span className="code">payment-response.success !== false</span>.
          </Note>
          <Note tone="bad">
            <b>A charge recorded as a refusal.</b> The facilitator has been observed settling the
            transfer on chain while the seller still answered HTTP 402 — so a status-only check
            logged a denial for money that had already moved. The gateway now captures the block
            height before signing and, on any non-success response, scans the canonical MUSD{" "}
            <span className="code">Transfer</span> logs for the exact amount. If MUSD moved it
            records a payment flagged <span className="code">charged_without_delivery</span>; only if
            nothing moved does it record a denial.
          </Note>
        </div>
        <p className="mt-4 text-[14px] leading-relaxed text-muted">
          Wave 2 added a third check: the <b>quote binding</b> warning. After settlement the
          facilitator's reported amount is compared against the probed quote amount; a mismatch is
          flagged <span className="code">warning: "quote_mismatch"</span> on the receipt and surfaced
          side-by-side in the response. The log is append-only — there is no delete function, by
          design — so pre-fix rows are still there, badged{" "}
          <Badge tone="bad">unverified</Badge> in the ledger and disclosed in{" "}
          <span className="code">LIVE-DEPLOYMENT.md</span> rather than filtered out.
        </p>
      </Card>

      {/* ──────────────── KEY HANDLING ──────────────── */}
      <Card title="Key handling">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr>
                <th className="th">Key</th>
                <th className="th">Where it lives</th>
                <th className="th">Used for</th>
                <th className="th">Exposure if leaked</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="td text-text">Owner</td>
                <td className="td text-muted">your browser wallet (Reown AppKit)</td>
                <td className="td text-muted">policy changes, releases, pause</td>
                <td className="td text-muted">full control of the treasury</td>
              </tr>
              <tr>
                <td className="td text-text">Gateway signer</td>
                <td className="td font-mono text-[12.5px] text-muted">server env</td>
                <td className="td text-muted">writing receipts on chain</td>
                <td className="td text-muted">can forge ledger entries — not move funds</td>
              </tr>
              <tr>
                <td className="td text-text">Agent key (per user)</td>
                <td className="td text-muted">MongoDB, AES-256-GCM encrypted</td>
                <td className="td text-muted">signing x402 payments and Permit2 approvals</td>
                <td className="td text-muted">bounded by that wallet's balance and on-chain caps</td>
              </tr>
              <tr>
                <td className="td text-text">Session token</td>
                <td className="td text-muted">browser, HTTP-only header</td>
                <td className="td text-muted">authenticating subsequent API calls</td>
                <td className="td text-muted">spending bounded by rate limit, caps, and session TTL</td>
              </tr>
              <tr>
                <td className="td text-text">Primary wallet</td>
                <td className="td text-muted">user's wallet (MetaMask / WalletConnect / Coinbase)</td>
                <td className="td text-muted">EIP-191 session login, EIP-191 budget changes, BTC/MUSD transfers</td>
                <td className="td text-muted">full control of the user's own funds</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Note className="mt-4">
          No private key is ever given to a model. Agent keys are generated server-side and
          encrypted at rest; they are decrypted in process memory only for the lifetime of one
          authenticated request. The React app talks to the gateway over either relative URLs
          proxied by Vercel, or a configured <span className="code">VITE_GATEWAY_URL</span>; keys
          never touch the bundle.
        </Note>
      </Card>

      {/* ──────────────── LIMITATIONS ──────────────── */}
      <Card title="Honest limitations">
        <ol className="space-y-3 text-[14px] leading-relaxed text-muted">
          <Num n={1}>
            <b className="text-text">The gateway is trusted.</b> It decrypts agent keys in memory, so
            per-payment enforcement is only as strong as that process. Layers 1 and 3 still hold if
            it is compromised; Wave 2's session auth, rate limit and quote binding shrink the window
            but do not eliminate it.
          </Num>
          <Num n={2}>
            <b className="text-text">Pause cannot unsign what is already funded.</b> Pausing stops
            further releases; an agent holding float can still spend it.{" "}
            <span className="code">emergencyStop</span> is the actual stop, and its sweep requires
            the recall allowance.
          </Num>
          <Num n={3}>
            <b className="text-text">sMUSD withdrawals need a working RPC.</b> JIT{" "}
            <span className="code">ensureLiquidity()</span> refuses the payment with a clear 503 if
            the vault is unreachable, rather than signing against a stale balance. Users can always
            fall back to a direct MUSD transfer from the Earn page.
          </Num>
          <Num n={4}>
            <b className="text-text">Daily caps reset at 00:00 UTC</b> from{" "}
            <span className="code">block.timestamp</span>, not your local day.
          </Num>
          <Num n={5}>
            <b className="text-text">A relayed purchase is a trusted hop.</b> The relay exists
            because most sellers send no <span className="code">Access-Control-Allow-Origin</span>,
            and it fixes that — but the gateway then sees the request and the response body. It
            cannot exceed the caps (they are on chain), and it is guarded against SSRF; it can still
            read what you bought.
          </Num>
          <Num n={6}>
            <b className="text-text">Alerts are best-effort.</b> A Telegram outage, a blocked bot or
            a chat rate limit means a missed notification, never a failed payment. The delivery log
            on the Alerts page is the mitigation: silence is recorded, not swallowed.
          </Num>
          <Num n={7}>
            <b className="text-text">Self-service caps are ceilinged, not sovereign.</b> A user may
            lower their own limits freely and raise them only up to the published ceiling. That is
            the point — but it does mean the ceiling is an operator choice, expressed in{" "}
            <span className="code">USER_*_MUSD</span> environment variables rather than in the
            contract.
          </Num>
          <Num n={8}>
            <b className="text-text">Collateralised borrowing has liquidation risk.</b> The Earn
            page shows the exact BTC price at which the trove liquidates and the % buffer, but a
            fast downside move can still liquidate a trove before the user can top up. MCR is 110%,
            CCR is 150%; the UI defaults to a 200% safety ratio.
          </Num>
        </ol>
      </Card>

      {/* ──────────────── THIS DEPLOYMENT ──────────────── */}
      {IS_DEPLOYED && (
        <Card title="This deployment">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13.5px]">
            <dt className="text-dim">network</dt>
            <dd className="text-muted">{CHAIN.name} · <span className="font-mono">{CHAIN.caip2}</span></dd>
            <dt className="text-dim">treasury</dt>
            <dd><AddressLink address={TREASURY_ADDRESS} chars={8} /></dd>
            <dt className="text-dim">owner</dt>
            <dd><AddressLink address={TREASURY_OWNER} chars={8} /></dd>
            <dt className="text-dim">MUSD</dt>
            <dd><AddressLink address={MUSD_ADDRESS} chars={8} /></dd>
            <dt className="text-dim">sMUSD vault</dt>
            <dd>
              {vaultAddress
                ? <AddressLink address={vaultAddress} chars={8} />
                : <span className="text-dim">—</span>}
            </dd>
            <dt className="text-dim">gateway</dt>
            <dd>
              {health && !health.unreachable
                ? <Badge tone="ok"><Dot tone="ok" /> online · x402 {health.x402Ready ? "armed" : "not armed"}</Badge>
                : <Badge tone="bad"><Dot tone="bad" pulse /> offline</Badge>}
            </dd>
            <dt className="text-dim">session auth</dt>
            <dd>
              {health?.session?.enabled
                ? <Badge tone="ok"><Dot tone="ok" /> multi-user agent wallets</Badge>
                : <Badge tone="warn">single-agent mode (no MongoDB)</Badge>}
            </dd>
            <dt className="text-dim">savings sweep</dt>
            <dd>
              {health?.savings?.enabled !== false
                ? <Badge tone="ok"><Dot tone="ok" /> every {Math.round((health?.savings?.intervalMs || 300000) / 60000)} min · threshold {health?.savings?.thresholdMusd ?? 50} MUSD</Badge>
                : <Badge tone="warn">disabled</Badge>}
            </dd>
            <dt className="text-dim">relay</dt>
            <dd>
              {health?.relay?.enabled
                ? <Badge tone="ok"><Dot tone="ok" /> enabled · {health.relay.allowlist?.length ? "allowlist enforced" : "no allowlist (any public https)"}</Badge>
                : <Badge tone="warn">disabled</Badge>}
            </dd>
            <dt className="text-dim">alerts</dt>
            <dd>
              {health?.telegram?.enabled
                ? <Badge tone="ok"><Dot tone="ok" /> {health.telegram.botUsername ? `@${health.telegram.botUsername}` : "bot connected"}</Badge>
                : <Badge tone="neutral"><Dot tone="warn" /> no bot token — setup steps on the Alerts page</Badge>}
            </dd>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/dashboard"><Button size="sm">Dashboard</Button></Link>
            <Link to="/earn"><Button size="sm" variant="primary">Open a trove</Button></Link>
            <Link to="/spend"><Button size="sm">Make a payment</Button></Link>
            <Link to="/ledger"><Button size="sm">Ledger</Button></Link>
            <Link to="/alerts"><Button size="sm">Alerts</Button></Link>
            <Link to="/operate"><Button size="sm">Change a cap</Button></Link>
          </div>
        </Card>
      )}
    </div>
  );
}

function Bullet({ children }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-btc" />
      <span>{children}</span>
    </li>
  );
}

function Num({ n, children }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line bg-ink-soft text-[12px] text-btc">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

function short(addr, n = 6) {
  if (!addr) return "—";
  return `${addr.slice(0, n + 2)}…${addr.slice(-n)}`;
}