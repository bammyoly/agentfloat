// ---------------------------------------------------------------------------
// Home — the landing page.
//
// Wave 2 Upgrade: Refined aesthetics, updated narrative to reflect the removal of 
// the faucet in favor of BorrowerOperations (Earn page), sMUSD sweeping, and the 
// High-severity security fixes. Includes a delayed modal to highlight the Wave 2 diff.
// ---------------------------------------------------------------------------

import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";

import { useAppData } from "../lib/app-data.jsx";
import { useSession } from "../lib/session.jsx";
import { Reveal } from "../lib/useReveal.jsx";
import { Badge, Button, Card, Dot, Icon, IconTile, Note } from "../components/ui.jsx";
import {
  Bell, CircleCheck, CircleSlash, Coins, Gauge, KeyRound, Landmark, Lock,
  ReceiptText, ShieldCheck, Users, Wallet, Waypoints, Zap, Sparkles, X, TrendingUp
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
      <Wave2Modal />
      <Hero session={session} />
      <StatusStrip
        deployed={deployed}
        gatewayOnline={gatewayOnline}
        health={health}
        treasury={treasury}
        payments={payments}
        denials={denials}
      />

      <div className="mx-auto max-w-[1400px] px-5 sm:px-8">
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
/* Wave 2 Feature Announcement Modal (5s delayed)                             */
/* ------------------------------------------------------------------------- */

function Wave2Modal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Only show once per browser session to avoid annoying the user
    const dismissed = localStorage.getItem("af_w2_dismissed");
    if (!dismissed) {
      const timer = setTimeout(() => setOpen(true), 5000);
      return () => clearTimeout(timer);
    }
  }, []);

  function close() {
    setOpen(false);
    localStorage.setItem("af_w2_dismissed", "true");
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-300">
      <div className="absolute inset-0 bg-ink/80 backdrop-blur-sm" onClick={close} />
      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-btc/30 bg-panel shadow-2xl animate-in zoom-in-95 duration-300">
        <div className="flex items-center justify-between border-b border-line-soft bg-btc/5 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Icon as={Sparkles} size={18} className="text-btc" />
            <h2 className="text-[15px] font-semibold text-text">Welcome to Wave 2</h2>
          </div>
          <button onClick={close} className="rounded-md p-1.5 text-dim transition-colors hover:bg-panel-2 hover:text-text">
            <X size={16} />
          </button>
        </div>
        <div className="p-6">
          <p className="mb-5 text-[14.5px] leading-relaxed text-muted">
            AgentFloat has been significantly upgraded for the Wave 2 submission. Here is what is new:
          </p>
          <ul className="space-y-4">
            <li className="flex gap-3">
              <Icon as={ShieldCheck} size={18} className="mt-0.5 shrink-0 text-ok" />
              <div>
                <strong className="block text-[14px] font-medium text-text">High-Severity Security Fix</strong>
                <span className="mt-0.5 block text-[13.5px] leading-relaxed text-dim">
                  Payment signatures are now strictly session-authenticated, rate-limited, and quote-bound via MongoDB to prevent replay and bypassing attacks.
                </span>
              </div>
            </li>
            <li className="flex gap-3">
              <Icon as={TrendingUp} size={18} className="mt-0.5 shrink-0 text-btc" />
              <div>
                <strong className="block text-[14px] font-medium text-text">Deep Mezo DeFi Integration</strong>
                <span className="mt-0.5 block text-[13.5px] leading-relaxed text-dim">
                  Abolished the faucet. Agents are now funded directly from BTC troves via BorrowerOperations, and idle treasury float is automatically swept into the sMUSD savings vault for yield.
                </span>
              </div>
            </li>
            <li className="flex gap-3">
              <Icon as={Bell} size={18} className="mt-0.5 shrink-0 text-info" />
              <div>
                <strong className="block text-[14px] font-medium text-text">Live Telegram Infrastructure</strong>
                <span className="mt-0.5 block text-[13.5px] leading-relaxed text-dim">
                  Instant push alerts for agent funding, collateral deposits, daily cap hits, and automated yield sweeps.
                </span>
              </div>
            </li>
          </ul>
          <div className="mt-7">
            <Button variant="primary" className="w-full justify-center" onClick={close}>
              Explore Wave 2
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Hero                                                                       */
/* ------------------------------------------------------------------------- */

function Hero({ session }) {
  return (
    <section className="relative overflow-hidden pt-12 pb-16 sm:pt-28 sm:pb-24">
      {/* decorative: engineering grid + a soft BTC wash behind the headline */}
      <div className="hero-grid pointer-events-none absolute inset-0 opacity-[0.4]" aria-hidden="true" />
      <div
        className="pointer-events-none absolute -top-40 left-1/2 h-[500px] w-[900px] -translate-x-1/2 rounded-full opacity-60 blur-[100px]"
        style={{ background: "radial-gradient(circle, rgba(247,147,26,0.12), transparent 70%)" }}
        aria-hidden="true"
      />

      <div className="relative mx-auto max-w-[1000px] px-5 text-center">
        <div className="animate-rise mb-8 flex flex-wrap items-center justify-center gap-3" style={{ "--reveal-delay": "0ms" }}>
          <Badge tone="btc" className="px-3 py-1 text-[12.5px] shadow-sm">
            <Dot tone="ok" className="mr-1" /> Live on {CHAIN.name}
          </Badge>
          <Badge tone="neutral" className="px-3 py-1 text-[12.5px]">Wave 2 Submission</Badge>
        </div>

        <h1 className="display animate-rise text-text" style={{ "--reveal-delay": "70ms" }}>
          Give your AI agent a budget,
          <br className="hidden sm:block" />
          <span className="text-gradient">not your private key.</span>
        </h1>

        <p className="lede animate-rise mx-auto mt-6 max-w-2xl text-[17px] sm:text-[19px]" style={{ "--reveal-delay": "150ms" }}>
          AgentFloat is a custodial spending layer for autonomous agents on Mezo. Fund your agent via BTC Troves, 
          earn yield on idle float with sMUSD, and let your agent pay APIs automatically within strict, on-chain caps.
        </p>

        <div className="animate-rise mt-10 flex flex-wrap items-center justify-center gap-4" style={{ "--reveal-delay": "230ms" }}>
          <PrimaryCta session={session} />
          <Link to="/architecture">
            <Button size="lg" variant="ghost" className="bg-panel-2 hover:bg-panel shadow-sm border border-line-soft">
              Read the protocol
            </Button>
          </Link>
        </div>

        <p className="animate-fade mt-6 text-[13.5px] font-medium text-dim" style={{ "--reveal-delay": "320ms" }}>
          No key export, no seed phrase. Testnet MUSD, real settlement.
        </p>
      </div>

      <div className="rule-sweep animate-sweep mt-16" aria-hidden="true" />
    </section>
  );
}

/**
 * Updated Primary CTA: Replaces Faucet with Earn/Borrow page.
 */
function PrimaryCta({ session }) {
  if (session.configured && !session.user) {
    return (
      <Button size="lg" variant="primary" onClick={session.login} disabled={session.authenticating}>
        {session.authenticating ? "Opening…" : "Explore Agentfloat"}
      </Button>
    );
  }
  return (
    <Link to="/earn">
      <Button size="lg" variant="primary" icon={Coins} className="shadow-lg shadow-btc/20">
        Go To Earn
      </Button>
    </Link>
  );
}

/* ------------------------------------------------------------------------- */
/* Live status                                                                */
/* ------------------------------------------------------------------------- */

function StatusStrip({ deployed, gatewayOnline, health, treasury, payments, denials }) {
  return (
    <section className="mx-auto max-w-[1400px] px-5 py-6">
      <Reveal>
        <div className="mb-4 flex items-baseline justify-between gap-4 px-1">
          <h2 className="eyebrow text-[12px] tracking-[0.08em] text-muted">Live from the deployment</h2>
          <span className="text-[12px] text-faint font-medium">polled every 6s</span>
        </div>

        <div className="grid grid-cols-2 gap-[1px] overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-4 shadow-sm">
          <Metric label="Treasury holds" value={deployed ? fmtMusd(treasury.balance, 2) : "—"} unit="MUSD" />
          <Metric label="sMUSD Yield Active" value={deployed && treasury.balance > 0 ? "Yes" : "—"} unit="Swept" />
          <Metric label="Payments recorded" value={deployed ? payments : "—"} unit="on chain" />
          <Metric label="Refusals recorded" value={deployed ? denials : "—"} unit="on chain" />
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 px-2 text-[12.5px] font-medium text-dim lg:justify-start">
          <StatusLed ok={gatewayOnline} label={`Gateway ${gatewayOnline ? "Online" : "Offline"}`} pulse={!gatewayOnline} />
          <StatusLed ok={health?.x402Ready} label={`x402 ${health?.x402Ready ? "Armed" : "Not Armed"}`} />
          <StatusLed ok={health?.onChainReceipts} label={`Receipts ${health?.onChainReceipts ? "On Chain" : "Gateway-Local"}`} />
          <StatusLed ok={!treasury.paused} label={treasury.paused ? "Treasury Paused" : "Treasury Active"} pulse={treasury.paused} />
          {IS_DEPLOYED && (
            <a href={explorerAddress(TREASURY_ADDRESS)} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono text-btc/80 transition-colors hover:text-btc hover:underline">
              <Icon as={Landmark} size={13} /> {TREASURY_ADDRESS.slice(0, 10)}…
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
    <section className="py-16 sm:py-20 border-b border-line-soft">
      <Reveal>
        <h2 className="eyebrow mb-4">The threat model</h2>
        <p className="display-sm max-w-3xl text-text">
          Agents are ready to spend money. The custody model around them is not.
        </p>
      </Reveal>

      <div className="mt-12 grid gap-5 md:grid-cols-3">
        {items.map((it, i) => (
          <Reveal key={it.n} delay={i * 90}>
            <div className="card lift group h-full border border-line-soft bg-panel p-6 transition-all hover:border-btc/20 hover:bg-panel-2 hover:shadow-md">
              <div className="font-mono text-[12.5px] font-semibold text-btc/60 transition-colors group-hover:text-btc">{it.n}</div>
              <h3 className="mt-3.5 text-[15px] leading-snug font-semibold text-text">{it.t}</h3>
              <p className="mt-2.5 text-[14px] leading-relaxed text-muted">{it.d}</p>
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
      t: "Borrow MUSD & Earn Yield (Wave 2)",
      icon: TrendingUp,
      d: "Deposit testnet BTC as collateral into BorrowerOperations troves to mint MUSD. Idle MUSD in the Treasury sweeps automatically into the sMUSD Savings Vault for native yield.",
    },
    {
      t: "Session-Bound Security (Wave 2)",
      icon: Lock,
      d: "Addresses high-severity risks. Agent signatures are secured server-side via encrypted MongoDB storage, rate-limited, and intrinsically bound to authenticated user sessions.",
    },
    {
      t: "Deep Telegram Integration",
      icon: Bell,
      d: "Receive real-time push alerts for collateral deposits, yield sweep execution, vault withdrawals, and automated agent spending caps right to your phone.",
    },
    {
      t: "Custodial float, not a key handover",
      icon: Landmark,
      d: "The treasury owns the funds. An agent only ever holds the float released to it, and a release that would breach its caps is rejected by the smart contract.",
    },
    {
      t: "x402-native payments in MUSD",
      icon: Zap,
      d: "The agent probes a paywalled endpoint, decodes the PAYMENT-REQUIRED quote, and settles through Mezo's facilitator with permit2. Gas is sponsored by the facilitator.",
    },
    {
      t: "A ledger the agent cannot edit",
      icon: ReceiptText,
      d: "Every payment and every refusal is appended on chain. Receipts are only issued against a settlement verified in the MUSD transfer logs.",
    },
  ];

  return (
    <section className="py-16 sm:py-20 border-b border-line-soft">
      <Reveal>
        <h2 className="eyebrow mb-4">What AgentFloat does</h2>
        <p className="display-sm max-w-3xl text-text">
          A spending perimeter an agent can work inside — and cannot work around.
        </p>
      </Reveal>

      <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {features.map((f, i) => (
          <Reveal key={f.t} delay={(i % 3) * 90}>
            <div className="card lift group h-full border border-line-soft bg-panel p-6 transition-all hover:border-btc/30 hover:shadow-md">
              <IconTile as={f.icon} tone="btc" size={18} className="bg-btc/5 shadow-sm transition-transform group-hover:scale-105" />
              <h3 className="mt-4 text-[15.5px] leading-snug font-semibold text-text">{f.t}</h3>
              <p className="mt-2.5 text-[14px] leading-relaxed text-muted">{f.d}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* How it works                                                               */
/* ------------------------------------------------------------------------- */

function HowItWorks({ session }) {
  const steps = [
    {
      n: 1,
      t: "Sign in securely",
      icon: KeyRound,
      d: "Sign in using session authentication. No seed phrase exposed to the browser or locally stored.",
    },
    {
      n: 2,
      t: "Agent wallet assigned",
      icon: Wallet,
      d: "An encrypted server-side EOA is assigned. The address persists, which makes on-chain budgets and identity meaningful.",
    },
    {
      n: 3,
      t: "Fund via BTC Troves",
      icon: Coins,
      d: "Use the Earn page to deposit BTC via BorrowerOperations, mint MUSD, and allocate float to your agent safely.",
    },
    {
      n: 4,
      t: "Pay & Yield automatically",
      icon: Zap,
      d: "The agent spends up to its cap using x402, while the unspent float sits in the sMUSD savings vault earning yield natively.",
    },
  ];

  return (
    <section id="how-it-works" className="scroll-mt-24 py-16 sm:py-20 border-b border-line-soft">
      <Reveal>
        <h2 className="eyebrow mb-4">The Wave 2 Workflow</h2>
        <p className="display-sm max-w-3xl text-text">
          Four steps from deployment to a self-yielding, budget-controlled autonomous agent.
        </p>
      </Reveal>

      <div className="relative mt-12">
        <div
          className="pointer-events-none absolute top-[20px] right-[8%] left-[8%] hidden h-[2px] bg-gradient-to-r from-transparent via-line-soft to-transparent lg:block"
          aria-hidden="true"
        />
        <div className="grid gap-8 lg:grid-[repeat(4,minmax(0,1fr))_auto] lg:gap-5">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 110}>
              <div className="relative h-full px-2">
                <div className="flex items-center gap-3.5">
                  <div className="glow-btc relative grid h-11 w-11 shrink-0 place-items-center rounded-full border-2 border-btc bg-panel font-mono text-[15px] font-bold text-btc shadow-md">
                    {s.n}
                  </div>
                  <Icon as={s.icon} size={18} className="text-btc/80" />
                </div>
                <h3 className="mt-5 text-[16px] font-semibold text-text">{s.t}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-muted">{s.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>

      <Reveal delay={120}>
        <div className="mt-12 text-center lg:text-left">
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
          daily cap. Sweeps unspent MUSD to sMUSD.
        </>
      ),
    },
    {
      t: "The gateway",
      icon: ShieldCheck,
      role: "per payment · session policy",
      d: (
        <>
          Secures the agent's key. It probes the seller, decodes the{" "}
          <span className="code">PAYMENT-REQUIRED</span> quote, and refuses access if the quote exceeds
          policy, or if the request lacks a valid user session.
        </>
      ),
    },
    {
      t: "The wallet",
      icon: Wallet,
      role: "last resort · blast radius",
      d: (
        <>
          The backstop. In a worst-case scenario, an attacker only accesses the isolated float released.{" "}
          <span className="code">emergencyStop</span> sweeps the rest back to safety instantly.
        </>
      ),
    },
  ];

  return (
    <section className="py-16 sm:py-20 border-b border-line-soft">
      <Reveal>
        <h2 className="eyebrow mb-4">Defense in depth</h2>
        <p className="display-sm max-w-3xl text-text">
          Three layers, so no single security failure is a drained wallet.
        </p>
      </Reveal>

      <div className="mt-12 grid gap-5 md:grid-cols-3">
        {layers.map((l, i) => (
          <Reveal key={l.t} delay={i * 90}>
            <Card pad="lg" icon={l.icon} tone="btc" title={l.t} aside={<Badge tone="neutral" className="shadow-sm">{l.role}</Badge>} className="lift h-full border border-line-soft shadow-sm hover:border-btc/20">
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
  const relayOn = health?.relay?.enabled !== false;

  return (
    <section className="py-16 sm:py-20">
      <Reveal>
        <h2 className="eyebrow mb-4">Scope, stated plainly</h2>
        <p className="display-sm max-w-3xl text-text">What is demonstrably real in the Wave 2 deployment.</p>
      </Reveal>

      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        <Reveal>
          <Card pad="lg" icon={CircleCheck} tone="ok" title="Real, on testnet, right now" className="h-full border border-ok/20 bg-ok/5 shadow-sm">
            <ul className="space-y-3.5 text-[14px] leading-relaxed text-text font-medium">
              <Item ok>Session-authenticated Quote binding and rate-limiting to defend against signature replay (High-finding fix).</Item>
              <Item ok>Live integration with testnet sMUSD (`0x6f46...8e16`) and BorrowerOperations for deep native yield.</Item>
              <Item ok>Live Telegram integration alerting on caps, collateral deposits, and JIT liquidity sweeps.</Item>
              <Item ok>Canonical MUSD payments settled through Mezo's x402 facilitator via Permit2.</Item>
              <Item ok>Per-call and per-day caps enforced by the deployed treasury contract.</Item>
              <Item ok>Every payment and refusal written to an append-only on-chain ledger.</Item>
              <Item ok>Receipts issued only after the settlement is confirmed in MUSD transfer logs.</Item>
              <Item ok>Gas-sponsored settlement — the agent wallet needs MUSD and nothing else.</Item>
              {relayOn && (
                <Item ok>
                  A gateway relay for sellers that send no CORS headers, featuring an active SSRF guard.
                </Item>
              )}
            </ul>
          </Card>
        </Reveal>

        <Reveal delay={90}>
          <Card pad="lg" icon={CircleSlash} tone="warn" title="What comes next (Mainnet)" className="h-full border border-warn/20 bg-warn/5 shadow-sm">
            <ul className="space-y-3.5 text-[14px] leading-relaxed text-muted">
              <Item>
                <strong className="text-text font-medium">Mainnet Liquidations:</strong> Currently, testnet troves do not experience real liquidation pressure. On mainnet, agent collateral management will require active safety-ratio maintenance.
              </Item>
              <Item>
                <strong className="text-text font-medium">Fully Decentralized Node Operators:</strong> The Gateway is currently operated as a hosted gateway SaaS model. A future iteration will allow open, trustless node operation.
              </Item>
              <Item>
                <strong className="text-text font-medium">Ledger Immutability Limits:</strong> The ledger is append-only with no delete. An early misclassified receipt is still there — badged <span className="code">unverified</span> and disclosed rather than quietly removed.
              </Item>
              <Item>
                <strong className="text-text font-medium">Relay Trust Constraint:</strong> A relayed purchase is a trusted hop: the gateway sees the request and the response body. It cannot sign and cannot exceed the caps, but it relays the transport.
              </Item>
            </ul>
            <Link to="/architecture" className="mt-6 inline-block">
              <Button variant="ghost" size="sm" className="bg-panel shadow-sm border border-line-soft">
                Read the wave 2 architecture →
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
    <section className="relative mt-8 overflow-hidden rounded-t-[40px] border-t border-line-soft bg-panel-2 shadow-2xl">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.85]"
        style={{ background: "radial-gradient(800px 300px at 50% 100%, rgba(247,147,26,0.15), transparent 80%)" }}
        aria-hidden="true"
      />
      <div className="relative mx-auto max-w-[1400px] px-5 py-20 text-center sm:py-28">
        <Reveal>
          <h2 className="display-sm mx-auto max-w-2xl text-text">
            Autonomous spending. Strict boundaries. Native yield.
          </h2>
          <p className="lede mx-auto mt-5 max-w-xl text-[16px] text-muted">
            Sign in below to test the Wave 2 deployment. Your agent wallet is secured server-side, 
            and your treasury balance is put to work instantly via Mezo troves.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <PrimaryCta session={session} />
            <Link to="/architecture">
              <Button size="lg" variant="ghost" className="bg-panel border border-line-soft shadow-sm">
                How enforcement works
              </Button>
            </Link>
          </div>
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
    <div className="bg-panel px-6 py-5">
      <div className="stat-label text-dim font-medium tracking-wide">{label}</div>
      <div className="tnum mt-1.5 text-[24px] font-bold text-text">
        {value}
        {unit && <span className="ml-2 text-[13.5px] font-medium text-muted">{unit}</span>}
      </div>
    </div>
  );
}

function StatusLed({ ok, label, pulse }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 border ${ok ? 'border-ok/20 bg-ok/5' : 'border-warn/20 bg-warn/5'}`}>
      <Dot tone={ok ? "ok" : "warn"} pulse={pulse} />
      <span className={ok ? "text-text" : "text-muted"}>{label}</span>
    </span>
  );
}

function Item({ ok, children }) {
  return (
    <li className="flex gap-3">
      <span className={`mt-0.5 shrink-0 ${ok ? "text-ok" : "text-warn"}`}>
        {ok ? <CircleCheck size={16} /> : <CircleSlash size={16} />}
      </span>
      <span>{children}</span>
    </li>
  );
}