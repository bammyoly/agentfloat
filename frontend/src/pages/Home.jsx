// ---------------------------------------------------------------------------
// Home — the landing page.
//
// Two jobs: explain what AgentFloat is to someone who has never seen it, and
// prove it is real. Every number on this page is read live from the deployed
// treasury and the gateway, so the marketing copy cannot claim something the
// chain contradicts. That is deliberate — this is a judging surface, and the
// "what is real / what is not" section below is the most persuasive thing on it.
//
// Motion is decorative and progressive: `Reveal` elements only hide themselves
// once lib/useReveal.jsx has installed its observer, and everything collapses to
// its end state under prefers-reduced-motion.
// ---------------------------------------------------------------------------

import React from "react";
import { Link } from "react-router-dom";

import { useAppData } from "../lib/app-data.jsx";
import { useSession } from "../lib/session.jsx";
import { Reveal } from "../lib/useReveal.jsx";
import { Badge, Button, Card, Dot, Icon, IconTile, Note } from "../components/ui.jsx";
import {
  Bell, CircleCheck, CircleSlash, Coins, Gauge, KeyRound, Landmark, Lock,
  ReceiptText, ShieldCheck, Users, Wallet, Waypoints, Zap,
} from "lucide-react";
import { fmtMusd } from "../lib/chain.js";
import { CHAIN, IS_DEPLOYED, TREASURY_ADDRESS, explorerAddress } from "../contracts/index.js";

export default function Home() {
  const { health, chainRecords, deployed, gatewayOnline } = useAppData();
  const session = useSession();

  const treasury = health?.treasury || {};
  const payments = chainRecords?.payments?.length ?? 0;
  const denials = chainRecords?.denials?.length ?? 0;

  return (
    <div className="-my-7">
      <Hero session={session} />
      <StatusStrip
        deployed={deployed}
        gatewayOnline={gatewayOnline}
        health={health}
        treasury={treasury}
        payments={payments}
        denials={denials}
      />

      <div className="mx-auto max-w-[1400px] px-5">
        <Problem />
        <Solutions />
        <HowItWorks session={session} />
        <Layers />
        <Honesty health={health} />
      </div>

      <ClosingCta session={session} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Hero                                                                       */
/* ------------------------------------------------------------------------- */

function Hero({ session }) {
  return (
    <section className="relative overflow-hidden">
      {/* decorative: engineering grid + a soft BTC wash behind the headline */}
      <div className="hero-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <div
        className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[820px] -translate-x-1/2 rounded-full opacity-60 blur-3xl"
        style={{ background: "radial-gradient(circle, rgba(247,147,26,0.16), transparent 65%)" }}
        aria-hidden="true"
      />

      <div className="relative mx-auto max-w-[1400px] px-5 pt-16 pb-14 sm:pt-24 sm:pb-20">
        <div className="animate-rise mb-6 flex flex-wrap items-center gap-2" style={{ "--reveal-delay": "0ms" }}>
          <Badge tone="btc">
            <Dot tone="ok" /> live on {CHAIN.name}
          </Badge>
          <Badge tone="neutral">x402 · MUSD · permit2</Badge>
          <Badge tone="neutral">gas sponsored by the facilitator</Badge>
        </div>

        <h1 className="display animate-rise max-w-4xl text-text" style={{ "--reveal-delay": "70ms" }}>
          Give your AI agent a budget,
          <br />
          <span className="text-gradient">not your private key.</span>
        </h1>

        <p className="lede animate-rise mt-6 max-w-2xl" style={{ "--reveal-delay": "150ms" }}>
          AgentFloat is a custodial spending layer for autonomous agents on Mezo. A treasury holds
          the funds and releases float under limits enforced on chain. The agent pays for APIs with
          x402 in MUSD, every settlement is written to an append-only ledger, and one transaction
          can sweep the wallet dry and stop it cold.
        </p>

        <div className="animate-rise mt-9 flex flex-wrap items-center gap-3" style={{ "--reveal-delay": "230ms" }}>
          <PrimaryCta session={session} />
          <Link to="/architecture">
            <Button>Read the protocol</Button>
          </Link>
        </div>

        <p className="animate-fade mt-5 text-[13.5px] text-dim" style={{ "--reveal-delay": "320ms" }}>
          No key export, no seed phrase, no deposit. Testnet MUSD, real settlement.
        </p>
      </div>

      <div className="rule-sweep animate-sweep" aria-hidden="true" />
    </section>
  );
}

/**
 * The hero's primary action depends on session state, because sending a signed-out
 * visitor to a guarded route would just bounce them back here.
 */
function PrimaryCta({ session }) {
  if (session.configured && !session.user) {
    return (
      <Button variant="primary" onClick={session.login} disabled={session.authenticating}>
        {session.authenticating ? "Opening…" : "Sign in and get 10 MUSD"}
      </Button>
    );
  }
  if (session.user) {
    return (
      <Link to="/faucet">
        <Button variant="primary">Claim your 10 MUSD</Button>
      </Link>
    );
  }
  // Privy not configured: operator-wallet mode, routes are unguarded.
  return (
    <Link to="/faucet">
      <Button variant="primary">Get 10 MUSD</Button>
    </Link>
  );
}

/* ------------------------------------------------------------------------- */
/* Live status                                                                */
/* ------------------------------------------------------------------------- */

function StatusStrip({ deployed, gatewayOnline, health, treasury, payments, denials }) {
  return (
    <section className="mx-auto max-w-[1400px] px-5 py-12">
      <Reveal>
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 className="eyebrow">Live from the deployment</h2>
          <span className="text-[12.5px] text-dim">polled every 6s</span>
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-line bg-line lg:grid-cols-4">
          <Metric label="Treasury holds" value={deployed ? fmtMusd(treasury.balance, 2) : "—"} unit="MUSD" />
          <Metric label="Released to agents" value={deployed ? fmtMusd(treasury.totalFunded, 2) : "—"} unit="MUSD" />
          <Metric label="Payments recorded" value={deployed ? payments : "—"} unit="on chain" />
          <Metric label="Refusals recorded" value={deployed ? denials : "—"} unit="on chain" />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-dim">
          <StatusLed ok={gatewayOnline} label={`gateway ${gatewayOnline ? "online" : "offline"}`} pulse={!gatewayOnline} />
          <StatusLed ok={health?.x402Ready} label={`x402 ${health?.x402Ready ? "armed" : "not armed"}`} />
          <StatusLed ok={health?.onChainReceipts} label={`receipts ${health?.onChainReceipts ? "on chain" : "gateway-local"}`} />
          <StatusLed ok={!treasury.paused} label={treasury.paused ? "treasury paused" : "treasury active"} pulse={treasury.paused} />
          {IS_DEPLOYED && (
            <a
              href={explorerAddress(TREASURY_ADDRESS)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-info hover:underline"
            >
              treasury {TREASURY_ADDRESS.slice(0, 10)}…
            </a>
          )}
        </div>
      </Reveal>
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* Problem                                                                    */
/* ------------------------------------------------------------------------- */

function Problem() {
  const items = [
    {
      n: "01",
      t: "A key in an agent's context is a key in the model's context",
      d: "Prompt injection, a compromised tool, or a leaked log line and the wallet is drained. There is no amount of prompting that makes an unrestricted key safe.",
    },
    {
      n: "02",
      t: "Spending has no ceiling",
      d: "An agent in a retry loop can call a paid API ten thousand times. Nothing in the payment rail itself cares how often, or how much in total.",
    },
    {
      n: "03",
      t: "Nobody can audit what it bought",
      d: "Off-chain logs are written by the same process that spent the money. When the numbers disagree, there is no third party to appeal to.",
    },
  ];

  return (
    <section className="py-14">
      <Reveal>
        <h2 className="eyebrow mb-4">The problem</h2>
        <p className="display-sm max-w-3xl text-text">
          Agents are ready to spend money. The custody model around them is not.
        </p>
      </Reveal>

      <div className="mt-9 grid gap-4 md:grid-cols-3">
        {items.map((it, i) => (
          <Reveal key={it.n} delay={i * 90}>
            <div className="card lift h-full p-5">
              <div className="font-mono text-[12.5px] text-btc/70">{it.n}</div>
              <h3 className="mt-2.5 text-[14.5px] leading-snug font-semibold text-text">{it.t}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">{it.d}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* Solutions                                                                  */
/* ------------------------------------------------------------------------- */

function Solutions() {
  const features = [
    {
      t: "Custodial float, not a key handover",
      icon: Landmark,
      d: "The treasury owns the funds. An agent only ever holds the float released to it, and a release that would breach its caps is rejected by the contract — not by a server that could be bypassed.",
    },
    {
      t: "x402-native payments in MUSD",
      icon: Zap,
      d: "The agent probes a paywalled endpoint, decodes the real PAYMENT-REQUIRED quote, and settles through Mezo's facilitator with permit2. Gas is sponsored, so the wallet needs MUSD and nothing else.",
    },
    {
      t: "A ledger the agent cannot edit",
      icon: ReceiptText,
      d: "Every payment and every refusal is appended on chain. Receipts are only issued against a settlement verified in the MUSD transfer logs — an HTTP status alone is never trusted.",
    },
    {
      t: "One transaction to stop it",
      icon: Lock,
      d: "emergencyStop pauses the treasury and sweeps the agent's remaining float back in a single call. Pausing alone is not enough; the sweep is what actually ends the exposure.",
    },
    {
      t: "A wallet per identity",
      icon: Users,
      d: "Sign in with Google or email and Privy creates an embedded EOA bound to that identity. Return tomorrow and you get the same address and the same balance — no key export, ever.",
    },
    {
      t: "Policy that fails loudly",
      icon: ShieldCheck,
      d: "Over the per-call max, past the daily cap, wrong asset, unapproved endpoint, paused, or missing permit2 allowance: each refusal returns a specific code and is recorded on chain.",
    },
    {
      t: "Your caps are yours to set",
      icon: Gauge,
      d: "Change your own per-call max and daily cap from your own wallet. You sign an authorization; the protocol applies it on chain inside a published ceiling — an agent still cannot raise its own limit.",
    },
    {
      t: "Pay any seller, CORS or not",
      icon: Waypoints,
      d: "Most paid APIs send no Access-Control-Allow-Origin, so a browser cannot even fetch the 402. The gateway relays only the HTTP hop: your signature stays in your wallet, the caps stay on chain.",
    },
    {
      t: "Alerts when it matters",
      icon: Bell,
      d: "Payments, refusals, cap changes and a once-a-day low-budget warning pushed to Telegram. Bound to your wallet by signature, so nobody else can attach to — or silence — your alerts.",
    },
  ];

  return (
    <section className="py-14">
      <Reveal>
        <h2 className="eyebrow mb-4">What AgentFloat does</h2>
        <p className="display-sm max-w-3xl text-text">
          A spending perimeter an agent can work inside — and cannot work around.
        </p>
      </Reveal>

      <div className="mt-9 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {features.map((f, i) => (
          <Reveal key={f.t} delay={(i % 3) * 90}>
            <div className="card lift h-full p-5">
              {/* Icon first: nine dense cards of prose are a wall, and the icon is
                  what lets a skimming reader find the one they came for. */}
              <IconTile as={f.icon} tone="btc" size={18} />
              <h3 className="mt-3.5 text-[15.5px] leading-snug font-semibold text-text">{f.t}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">{f.d}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* How it works — the navbar's anchor target                                  */
/* ------------------------------------------------------------------------- */

function HowItWorks({ session }) {
  const steps = [
    {
      n: 1,
      t: "Sign in",
      icon: KeyRound,
      d: "Google or email through Privy. No wallet to install, no seed phrase to store, no private key exposed to the browser or to us.",
    },
    {
      n: 2,
      t: "Get an agent wallet",
      icon: Wallet,
      d: "An embedded EOA is created on first login and reattached on every login after. The address is yours and it persists, which is what makes an on-chain budget meaningful.",
    },
    {
      n: 3,
      t: "Claim float",
      icon: Coins,
      d: "The faucet releases 10 testnet MUSD once every 48 hours and registers the wallet with a per-call maximum and a daily cap. That is the whole balance the agent can ever touch.",
    },
    {
      n: 4,
      t: "Pay, and get refused when you should",
      icon: Zap,
      d: "Point it at any x402 endpoint. The gateway checks policy before signing, settles in MUSD, then confirms the transfer on chain before it writes a receipt.",
    },
  ];

  return (
    <section id="how-it-works" className="scroll-mt-20 py-14">
      <Reveal>
        <h2 className="eyebrow mb-4">How it works</h2>
        <p className="display-sm max-w-3xl text-text">
          Four steps from an email account to an on-chain spending policy.
        </p>
      </Reveal>

      <div className="relative mt-10">
        {/* connecting rule, hidden on mobile where the cards stack */}
        <div
          className="pointer-events-none absolute top-[18px] right-[6%] left-[6%] hidden h-px bg-gradient-to-r from-transparent via-line to-transparent lg:block"
          aria-hidden="true"
        />
        <div className="grid gap-5 lg:grid-cols-4">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 110}>
              <div className="relative h-full">
                {/* The number is kept AND the icon added: the number carries the
                    order (which is the information in a four-step flow) and the
                    icon carries the kind of thing the step is. */}
                <div className="flex items-center gap-3">
                  <div className="glow-btc grid h-10 w-10 shrink-0 place-items-center rounded-full border border-btc/40 bg-panel font-mono text-[15px] text-btc">
                    {s.n}
                  </div>
                  <Icon as={s.icon} size={18} className="text-btc/70" />
                </div>
                <h3 className="mt-4 text-[15.5px] font-semibold text-text">{s.t}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-muted">{s.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>

      <Reveal delay={120}>
        <div className="mt-9">
          <PrimaryCta session={session} />
        </div>
      </Reveal>
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* Why the limit holds — the three enforcement layers                         */
/* ------------------------------------------------------------------------- */

function Layers() {
  const layers = [
    {
      t: "The treasury",
      icon: Landmark,
      role: "on chain · authoritative",
      d: (
        <>
          Holds the budget. <span className="text-text">Only the owner</span> can release float, and
          every release is rejected on chain if it exceeds the agent's per-call max or its remaining
          daily cap. An agent can never hold more than it has been given.
        </>
      ),
    },
    {
      t: "The gateway",
      icon: ShieldCheck,
      role: "per payment · policy",
      d: (
        <>
          The agent's only route out. It probes the seller unpaid, decodes the real{" "}
          <span className="code">PAYMENT-REQUIRED</span> quote, and refuses to sign anything over the
          cap, to an unapproved endpoint, for a non-MUSD asset, or while paused.
        </>
      ),
    },
    {
      t: "The wallet",
      icon: Wallet,
      role: "last resort · blast radius",
      d: (
        <>
          The backstop. Leak the key and an attacker still only gets what is in that wallet — bounded
          by the two layers above — and <span className="code">emergencyStop</span> sweeps the rest
          back to the treasury in one transaction.
        </>
      ),
    },
  ];

  return (
    <section className="py-14">
      <Reveal>
        <h2 className="eyebrow mb-4">Why the limit actually holds</h2>
        <p className="display-sm max-w-3xl text-text">
          Three layers, so no single failure is a drained wallet.
        </p>
      </Reveal>

      <div className="mt-9 grid gap-4 md:grid-cols-3">
        {layers.map((l, i) => (
          <Reveal key={l.t} delay={i * 90}>
            <Card icon={l.icon} tone="btc" title={l.t} aside={<Badge tone="neutral">{l.role}</Badge>} className="lift h-full">
              <p className="text-[14px] leading-relaxed text-muted">{l.d}</p>
            </Card>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* Honesty — the section that matters most to a judge                         */
/* ------------------------------------------------------------------------- */

function Honesty({ health }) {
  // Read, not asserted: this section is the most persuasive thing on the page
  // precisely because it only claims what this gateway can demonstrate right now.
  const capsSelfService = Boolean(health?.limits?.ok);
  const relayOn = health?.relay?.enabled !== false;
  const alertsOn = Boolean(health?.telegram?.enabled);
  return (
    <section className="py-14">
      <Reveal>
        <h2 className="eyebrow mb-4">Scope, stated plainly</h2>
        <p className="display-sm max-w-3xl text-text">What is real on testnet, and what is not done.</p>
      </Reveal>

      <div className="mt-9 grid gap-4 lg:grid-cols-2">
        <Reveal>
          <Card icon={CircleCheck} tone="ok" title="Real, on testnet, right now" className="h-full">
            <ul className="space-y-2.5 text-[14px] leading-relaxed text-muted">
              <Item ok>Canonical MUSD payments settled through Mezo's x402 facilitator</Item>
              <Item ok>Per-call and per-day caps enforced by the deployed treasury contract</Item>
              <Item ok>Every payment and refusal written to an append-only on-chain ledger</Item>
              <Item ok>Receipts issued only after the settlement is confirmed in MUSD transfer logs</Item>
              <Item ok>Gas-sponsored settlement — the agent wallet needs MUSD and nothing else</Item>
              <Item ok>A working refusal: lower the cap below the price and the contract says no</Item>
              {capsSelfService && (
                <Item ok>
                  Self-service budget changes — sign from your own agent wallet, applied on chain by
                  the owner key, inside a ceiling of 5 MUSD per call and 50 MUSD a day
                </Item>
              )}
              {relayOn && (
                <Item ok>
                  A gateway relay for sellers that send no CORS headers, with an SSRF guard that
                  resolves hostnames and refuses private ranges, link-local and metadata addresses
                </Item>
              )}
              {alertsOn && (
                <Item ok>
                  Telegram alerts bound by wallet signature — long-poll, so no webhook and no public
                  URL are needed
                </Item>
              )}
            </ul>
          </Card>
        </Reveal>

        <Reveal delay={90}>
          <Card icon={CircleSlash} tone="warn" title="Not done, and not faked" className="h-full">
            <ul className="space-y-2.5 text-[14px] leading-relaxed text-muted">
              <Item>
                sMUSD surplus yield — the savings vault is mainnet-only, so the UI says "unavailable
                on testnet" rather than showing a made-up APR
              </Item>
              <Item>
                Per-payment caps are gateway-enforced, not contract-enforced. A contract cannot veto
                an x402 payment, because the authorization is an EIP-712 signature that only an EOA
                can produce — so on-chain enforcement lands on <em>funding</em> instead. A
                permit2-spender contract closes that gap in Wave 2.
              </Item>
              <Item>
                The ledger is append-only with no delete, so an early misclassified receipt is still
                there — badged <span className="code">unverified</span> and disclosed rather than
                quietly removed
              </Item>
              {!alertsOn && (
                <Item>
                  Telegram alerts are built but not switched on <em>here</em>: no{" "}
                  <span className="code">TELEGRAM_BOT_TOKEN</span> on this gateway, so every alert
                  endpoint answers 503 and the Alerts page shows the BotFather setup steps. Nothing
                  is simulated in the meantime — a notification that was never sent is worse than none
                </Item>
              )}
              <Item>
                A relayed purchase is a trusted hop: the gateway sees the request and the response
                body. It cannot sign and cannot exceed the caps, but it can read what you bought — so
                the relay is per-purchase, labelled, and never the only path
              </Item>
            </ul>
            <Link to="/architecture" className="mt-5 inline-block">
              <Button variant="ghost" size="sm">
                Read the full architecture →
              </Button>
            </Link>
          </Card>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* Closing CTA                                                                */
/* ------------------------------------------------------------------------- */

function ClosingCta({ session }) {
  return (
    <section className="relative mt-6 overflow-hidden border-t border-line">
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: "radial-gradient(700px 260px at 50% 120%, rgba(247,147,26,0.13), transparent 70%)" }}
        aria-hidden="true"
      />
      <div className="relative mx-auto max-w-[1400px] px-5 py-16 text-center sm:py-20">
        <Reveal>
          <h2 className="display-sm mx-auto max-w-2xl text-text">
            Ten testnet MUSD, an agent wallet, and a budget it cannot exceed.
          </h2>
          <p className="lede mx-auto mt-4 max-w-xl">
            Sign in with Google or email. The wallet is created once and reattached every time you
            come back, so your balance and your ledger follow your identity.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <PrimaryCta session={session} />
            <Link to="/architecture">
              <Button variant="ghost">How enforcement works</Button>
            </Link>
          </div>
          {!session.configured && (
            <Note tone="warn" className="mx-auto mt-7 max-w-xl text-left">
              <b>Sign-in is disabled in this build.</b> Set{" "}
              <span className="code">VITE_PRIVY_APP_ID</span> in{" "}
              <span className="code">frontend/.env</span> to let users create an agent wallet with
              Google or email. Until then the faucet and per-user wallets stay off and the app runs
              in operator-wallet mode.
            </Note>
          )}
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* Small pieces                                                               */
/* ------------------------------------------------------------------------- */

function Metric({ label, value, unit }) {
  return (
    <div className="bg-panel px-5 py-4">
      <div className="stat-label">{label}</div>
      <div className="tnum mt-1 text-[22px] font-semibold text-text">
        {value}
        {unit && <span className="ml-1.5 text-[13px] font-normal text-dim">{unit}</span>}
      </div>
    </div>
  );
}

function StatusLed({ ok, label, pulse }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Dot tone={ok ? "ok" : "warn"} pulse={pulse} />
      {label}
    </span>
  );
}

function Item({ ok, children }) {
  return (
    <li className="flex gap-2.5">
      <span className={`mt-0.5 shrink-0 ${ok ? "text-ok" : "text-warn"}`}>{ok ? "✓" : "◦"}</span>
      <span>{children}</span>
    </li>
  );
}
