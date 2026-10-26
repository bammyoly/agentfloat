// ---------------------------------------------------------------------------
// Architecture — how the limits hold, and where they do not.
//
// This page exists because a judge will ask. Everything here is stated plainly,
// including the parts that are not solved.
// ---------------------------------------------------------------------------

import React from "react";
import { Network } from "lucide-react";
import { Link } from "react-router-dom";
import { useAppData } from "../lib/app-data.jsx";
import { Badge, Button, Card, Dot, Note, PageHeader, AddressLink } from "../components/ui.jsx";
import { CHAIN, TREASURY_ADDRESS, TREASURY_OWNER, IS_DEPLOYED, MUSD_ADDRESS } from "../contracts/index.js";

export default function Architecture() {
  const { health } = useAppData();

  return (
    <div className="animate-fade space-y-6 pb-10">
      <PageHeader
        icon={Network}
        eyebrow="Design"
        title="How AgentFloat holds a limit"
        sub="Three layers, each of which fails safe. The honest version, including what a compromised gateway can and cannot do."
      />

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
            The agent's only route out. It probes a seller unpaid, decodes the real{" "}
            <span className="code">PAYMENT-REQUIRED</span> header, and refuses to sign anything over
            the cap, to an unapproved endpoint, for a non-MUSD asset, on the wrong network, or while
            paused.
          </p>
          <p className="mt-3 text-[14px] leading-relaxed text-muted">
            Expressive and fast — but trusted, because it holds an agent key. Layers 1 and 3 bound the
            damage if it is compromised.
          </p>
        </Card>

        <Card title="Layer 3 · the wallet" aside={<Badge tone="info">backstop</Badge>}>
          <p className="text-[14px] leading-relaxed text-muted">
            The agent EOA's own balance. Leak the key and an attacker still only gets what is in that
            wallet — bounded by layers 1 and 2 — and <span className="code">emergencyStop</span> sweeps
            the remainder back to the treasury in one transaction.
          </p>
        </Card>
      </div>

      {/* --- who may change a cap ------------------------------------------ */}
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
              signs a gateway-written message that already contains the address, both values and a
              single-use nonce — from their own agent wallet, in Privy's TEE
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

      {/* --- the relay ----------------------------------------------------- */}
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
            <b className="text-text">Sign, locally</b> — the browser rebuilds the response and asks the
            x402 client for a permit2 payload. The Privy prompt appears here, in the user's browser.
            The gateway never sees a key and cannot produce this signature.
          </Num>
          <Num n={3}>
            <b className="text-text">Execute</b> — <span className="code">POST /api/relay/execute</span>{" "}
            re-checks the URL, checks the payment header's payer against the claimed agent
            (<span className="code">403 payer_mismatch</span> otherwise), fetches with{" "}
            <span className="code">X-PAYMENT</span>, then proves settlement from the canonical MUSD{" "}
            <span className="code">Transfer</span> logs and records it on chain.
          </Num>
        </ol>
        <div className="mt-4 space-y-3">
          <Note tone="warn">
            <b className="text-text">What this costs.</b> The gateway now sees the request and the
            response body in plaintext, which it did not before: a relayed hop is a privacy hop, and it
            is why the relay is opt-in per purchase, labelled in the UI, and never the only path. A
            seller that does send CORS headers can still be paid directly from the browser.
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

      {/* --- alerts -------------------------------------------------------- */}
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
          refusals, budget changes, freezes, faucet claims and a once-a-day "20% of your daily cap is
          left" warning are pushed to Telegram.
        </p>
        <ul className="mt-3 space-y-1.5 text-[14px] text-muted">
          <Bullet>
            <b className="text-text">No webhook.</b> The gateway usually runs on a laptop behind NAT
            with no public URL, so it long-polls <span className="code">getUpdates</span>. A 409 from
            Telegram means a second poller — logged loudly and backed off for 60 s rather than
            fought over.
          </Bullet>
          <Bullet>
            <b className="text-text">Binding is signature-authorized.</b> Otherwise anyone who knows an
            address could receive — or silence — somebody else's spending alerts.
          </Bullet>
          <Bullet>
            <b className="text-text">Stored: one chat id per address</b>, in{" "}
            <span className="code">server/telegram-state.json</span>, gitignored. No key, no message
            history beyond the last send attempts, which the Alerts page shows so a silent failure is
            visible.
          </Bullet>
          <Bullet>
            <b className="text-text">Best-effort by design.</b> A blocked bot or a Telegram outage must
            never fail a payment or a budget change, so every notify is fire-and-forget.
          </Bullet>
          <Bullet>
            <b className="text-text">The watcher reads the chain</b>, not the gateway's memory, so an
            event the gateway never saw — a payment settled straight from a browser — still produces an
            alert.
          </Bullet>
        </ul>
        <Note tone="warn" className="mt-4">
          With no <span className="code">TELEGRAM_BOT_TOKEN</span> every alert endpoint answers 503 and
          the UI shows the BotFather setup steps. Nothing is simulated: a notification that is not
          really sent is worse than none, because the user believes it was.
        </Note>
      </Card>

      {/* --- why an EOA ---------------------------------------------------- */}
      <Card title="Why the agent wallet must be an EOA">
        <p className="text-[14px] leading-relaxed text-muted">
          x402 on Mezo settles with <span className="code">assetTransferMethod: permit2</span>, which
          is an <b className="text-text">EIP-712 signature</b>. Only an externally-owned account can
          produce one. A contract wallet cannot sign it — it can only validate a signature someone else
          made, via ERC-1271, which the x402 client does not use.
        </p>
        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          That single constraint shapes the whole design. It is why enforcement lands on{" "}
          <i>funding</i> (the treasury) rather than on individual payments, and it is why Privy is
          configured to keep embedded wallets as plain EOAs:
        </p>
        <ul className="mt-3 space-y-1.5 text-[14px] text-muted">
          <Bullet>no ERC-4337 smart wallets</Bullet>
          <Bullet>
            no Privy gas sponsorship — it delegates the wallet via EIP-7702, giving the address
            contract code and forcing ERC-1271 signature mode
          </Bullet>
        </ul>
        <Note tone="warn" className="mt-4">
          <b>The gap this leaves.</b> A contract cannot veto an individual x402 payment, so per-payment
          caps live in the trusted gateway. Closing that gap — a permit2-spender policy contract the
          agent signs permits to, so caps hold even if the gateway is compromised — is the Wave 2
          upgrade.
        </Note>
      </Card>

      {/* --- two allowances ------------------------------------------------ */}
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
                  every payment is rejected with HTTP 412; the quote looks perfect and policy allows it,
                  but no MUSD moves
                </td>
              </tr>
              <tr>
                <td className="td text-text">MUSD → treasury</td>
                <td className="td font-mono text-[12.5px] text-muted">{TREASURY_ADDRESS ? short(TREASURY_ADDRESS) : "—"}</td>
                <td className="td text-muted">lets the owner <b className="text-text">recall</b> unspent float</td>
                <td className="td text-muted">emergencyStop pauses but cannot sweep</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Note className="mt-4">
          The first one cost a real failed run: it was missing, and the failure surfaced as an opaque
          HTTP 412 long after the quote had decoded correctly. The gateway now checks it in{" "}
          <span className="code">/api/health</span> and refuses up front with{" "}
          <span className="code">permit2_not_approved</span>.
        </Note>
      </Card>

      {/* --- ledger integrity --------------------------------------------- */}
      <Card title="Ledger integrity: the chain is the source of truth">
        <p className="text-[14px] leading-relaxed text-muted">
          The audit log is the product, so a false entry in it is the worst bug AgentFloat could have.
          Two were found by actually deploying, in opposite directions:
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
            transfer on chain while the seller still answered HTTP 402 — so a status-only check logged a
            denial for money that had already moved. The gateway now captures the block height before
            signing and, on any non-success response, scans the canonical MUSD{" "}
            <span className="code">Transfer</span> logs for the exact amount. If MUSD moved it records a
            payment flagged <span className="code">charged_without_delivery</span>; only if nothing
            moved does it record a denial.
          </Note>
        </div>
        <p className="mt-4 text-[14px] leading-relaxed text-muted">
          The log is append-only — there is no delete function, by design — so the two rows written
          before those fixes are still there. They are badged{" "}
          <Badge tone="bad">unverified</Badge> in the ledger and disclosed in{" "}
          <span className="code">LIVE-DEPLOYMENT.md</span> rather than filtered out.
        </p>
      </Card>

      {/* --- key handling -------------------------------------------------- */}
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
                <td className="td text-muted">your browser wallet</td>
                <td className="td text-muted">policy changes, releases, pause</td>
                <td className="td text-muted">full control of the treasury</td>
              </tr>
              <tr>
                <td className="td text-text">Gateway signer</td>
                <td className="td font-mono text-[12.5px] text-muted">server/.env</td>
                <td className="td text-muted">writing receipts on chain</td>
                <td className="td text-muted">can forge ledger entries — not move funds</td>
              </tr>
              <tr>
                <td className="td text-text">Demo agent</td>
                <td className="td font-mono text-[12.5px] text-muted">server/.env</td>
                <td className="td text-muted">signing x402 payments</td>
                <td className="td text-muted">bounded by its own balance and the caps</td>
              </tr>
              <tr>
                <td className="td text-text">User agent (Privy)</td>
                <td className="td text-muted">Privy's TEE — never in our bundle or server</td>
                <td className="td text-muted">signing x402 payments in the browser</td>
                <td className="td text-muted">bounded by the wallet's own balance</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Note className="mt-4">
          No private key is ever given to a model, and no agent key ever reaches the browser. The React
          app talks to the gateway over relative URLs; Vite proxies them to 127.0.0.1, and the gateway
          binds loopback only.
        </Note>
      </Card>

      {/* --- limitations --------------------------------------------------- */}
      <Card title="Honest limitations">
        <ol className="space-y-3 text-[14px] leading-relaxed text-muted">
          <Num n={1}>
            <b className="text-text">The gateway is trusted.</b> It holds the demo agent key, so
            per-payment enforcement is only as strong as that process. Layers 1 and 3 still hold if it
            is compromised.
          </Num>
          <Num n={2}>
            <b className="text-text">Pause cannot unsign what is already funded.</b> Pausing stops
            further releases; an agent holding float can still spend it.{" "}
            <span className="code">emergencyStop</span> is the actual stop, and its sweep requires the
            recall allowance.
          </Num>
          <Num n={3}>
            <b className="text-text">The faucet spends real operator funds.</b> It airdrops from the
            owner wallet, so global caps bound total and daily outflow. In production it should be a
            separate wallet with a hard budget, not the treasury owner.
          </Num>
          <Num n={4}>
            <b className="text-text">No sMUSD yield on testnet.</b> The savings vault proxy holds 0
            bytes of bytecode here. The UI says "unavailable on testnet" instead of mocking an APR.
          </Num>
          <Num n={5}>
            <b className="text-text">Daily caps reset at 00:00 UTC</b> from{" "}
            <span className="code">block.timestamp</span>, not your local day.
          </Num>
          <Num n={6}>
            <b className="text-text">A relayed purchase is a trusted hop.</b> The relay exists because
            most sellers send no <span className="code">Access-Control-Allow-Origin</span>, and it
            fixes that — but the gateway then sees the request and the response body. It cannot sign
            (the signature stays in the browser), it cannot exceed the caps (they are on chain), and it
            is guarded against SSRF; it can still read what you bought. That is why it is per-purchase,
            labelled, and never the only path.
          </Num>
          <Num n={7}>
            <b className="text-text">Alerts are best-effort.</b> A Telegram outage, a blocked bot or a
            chat rate limit means a missed notification, never a failed payment. The delivery log on
            the Alerts page is the mitigation: silence is recorded, not swallowed.
          </Num>
          <Num n={8}>
            <b className="text-text">Self-service caps are ceilinged, not sovereign.</b> A user may
            lower their own limits freely and raise them only up to the published ceiling. That is the
            point — but it does mean the ceiling is an operator choice, expressed in{" "}
            <span className="code">USER_*_MUSD</span> environment variables rather than in the contract.
          </Num>
        </ol>
      </Card>

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
            <dt className="text-dim">gateway</dt>
            <dd>
              {health && !health.unreachable
                ? <Badge tone="ok"><Dot tone="ok" /> online · x402 {health.x402Ready ? "armed" : "not armed"}</Badge>
                : <Badge tone="bad"><Dot tone="bad" pulse /> offline</Badge>}
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
            <Link to="/spend"><Button size="sm" variant="primary">Make a payment</Button></Link>
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
