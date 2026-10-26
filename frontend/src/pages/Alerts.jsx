// ---------------------------------------------------------------------------
// Alerts — Telegram notifications, bound to YOUR agent wallet by signature.
//
// WHY THIS PAGE EXISTS AT ALL
//   A budget-controlled wallet is only useful if the owner hears about it. A
//   payment that settles while you are not looking at a dashboard is the exact
//   case where a cap matters most, and a refusal (denial) is the case where you
//   most need to know your limit was too low. So both go to your phone.
//
// WHY A SIGNATURE, NOT A FORM
//   Binding a Telegram chat to an agent address means that chat receives
//   spending alerts for someone's wallet — and, if binding were unauthenticated,
//   could also be used to *silence* them. So the binding is authorized the same
//   way a budget change is: the gateway writes the message, your agent wallet
//   signs it, the gateway recovers the signer and refuses on mismatch. The same
//   applies to the test alert and to disconnecting.
//
// HOW THE CHAT IS FOUND
//   No webhook, because the gateway usually runs on a laptop behind NAT with no
//   public URL. It long-polls getUpdates instead, and the binding is completed
//   from the Telegram side: subscribe returns a single-use code (8 characters,
//   15 minutes, one live code per address) plus a t.me link that carries it in
//   ?start=. Open the link, press Start, the bot reads the code, binds your
//   chat to the address, and deletes the code. /stop unbinds; /status reports.
//
// WHAT IS STORED
//   A chat id and the address it belongs to, in server/telegram-state.json,
//   which is gitignored. No wallet key, no message history beyond the last
//   handful of send attempts (shown at the bottom of this page so a silent
//   failure is visible rather than mysterious).
//
// NOTHING IS MOCKED
//   If TELEGRAM_BOT_TOKEN is absent the endpoints answer 503 and this page shows
//   the BotFather setup steps instead of pretending. An operator step, labelled
//   as one.
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { useSession } from "../lib/session.jsx";
import { useAppData } from "../lib/app-data.jsx";
import {
  AddressLink, Badge, Button, Card, Dot, Note, PageHeader, useCopied,
} from "../components/ui.jsx";
import { Link } from "react-router-dom";
import {
  telegramConfig, telegramChallenge, telegramSubscribe, telegramUnsubscribe, telegramTest, telegramStatus,
} from "../lib/gateway.js";

/** What arrives in Telegram, in the words a user would use. */
const ALERTS = [
  { kind: "payment", label: "A payment settled", detail: "Seller, amount, tx hash and your remaining float — the moment it happens." },
  { kind: "denial", label: "A payment was refused", detail: "Which cap stopped it (per-call, daily, float, frozen) so you can raise the right one." },
  { kind: "limits_changed", label: "Your budget changed", detail: "Old and new caps, plus the tx that applied them. You will recognise your own change; anything you did not sign, you will not." },
  { kind: "agent_frozen", label: "Your agent was frozen", detail: "Nobody can spend from a frozen wallet until it is unfrozen." },
  { kind: "faucet_claim", label: "Testnet float claimed", detail: "Confirms the faucet registered your wallet and with which caps." },
  { kind: "cap_warning", label: "Daily cap nearly spent", detail: "One warning per UTC day, at 20% of the cap remaining — before you hit the wall." },
];

export default function Alerts() {
  const session = useSession();
  const { health } = useAppData();

  if (!session.configured || !session.user) {
    return (
      <div className="animate-fade space-y-8 pb-10">
        <PageHeader
          icon={Bell}
          eyebrow="notifications"
          title="Telegram alerts"
          sub="Payments, refusals and budget changes, pushed to your phone — bound to your own agent wallet."
        />
        <Card title="Your alerts" aside={<Badge tone="neutral">sign-in required</Badge>}>
          <p className="text-[14px] leading-relaxed text-muted">
            Alerts are bound to an agent wallet, and the binding is authorized by a signature from that wallet. Sign in
            with Google or email to create yours, then connect Telegram from this page.
          </p>
          {session.configured && (
            <div className="mt-4">
              <Button variant="primary" onClick={session.login} disabled={session.authenticating}>
                {session.authenticating ? "Opening…" : "Sign in"}
              </Button>
            </div>
          )}
        </Card>
        <WhatYouGet />
      </div>
    );
  }

  return <Connected session={session} gatewayOnline={Boolean(health && !health.unreachable)} />;
}

function Connected({ session, gatewayOnline }) {
  const address = session.agentAddress;
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);
  const [stage, setStage] = useState(null);
  const [msg, setMsg] = useState(null);
  const [code, setCode] = useState(null); // { code, link, botUsername, expiresAt }
  const [now, setNow] = useState(Date.now());
  const [copied, copy] = useCopied(1600);

  // Derived once, above the hooks, because the polling effect below depends on
  // them — a `const` declared after a useEffect is a reference error in its
  // dependency array, not a stale value.
  const enabled = config?.enabled ?? false;
  const subscribed = Boolean(status?.subscribed);
  const secondsLeft = code?.expiresAt ? Math.max(0, Math.round((new Date(code.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = Boolean(code) && secondsLeft <= 0;

  const loadStatus = useCallback(() => {
    if (!address) return;
    telegramStatus(address).then((r) => { if (r.ok) setStatus(r); });
  }, [address]);

  useEffect(() => {
    telegramConfig().then((r) => setConfig(r));
    loadStatus();
  }, [loadStatus]);

  // A live countdown, because the code genuinely expires and a stale link that
  // silently does nothing is worse than a clock you can see.
  useEffect(() => {
    if (!code?.expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [code?.expiresAt]);

  // Watch for the binding to land while a code is outstanding.
  //
  // The binding happens on the GATEWAY, not in this component: the user sends
  // /start <code> to the bot, the gateway's long-poll picks the message up, and
  // the pending code becomes a subscription. Nothing here is told that happened,
  // so the card used to keep saying "not connected" until the page was reloaded —
  // after the user had already done exactly what we asked of them.
  //
  // Poll only while there is something to wait for: first check quickly, because
  // most people press Start within a second or two of the link opening, then every
  // 4 s. Stop as soon as it lands or the code expires. The dependencies are
  // booleans that each flip at most once, so the 1 s countdown does not tear the
  // interval down every tick.
  useEffect(() => {
    if (!code?.code || subscribed || expired) return;
    const quick = setTimeout(loadStatus, 1500);
    const id = setInterval(loadStatus, 4000);
    return () => { clearTimeout(quick); clearInterval(id); };
  }, [code?.code, subscribed, expired, loadStatus]);

  // When it lands, retire the code and say so — otherwise the countdown keeps
  // ticking against a code that no longer means anything, and the user has to
  // work out for themselves that the badge up top just turned green.
  useEffect(() => {
    if (!subscribed || !code) return;
    const who = status?.chatUsername ? `@${String(status.chatUsername).replace(/^@/, "")}` : "your Telegram chat";
    setCode(null);
    setMsg({ ok: true, label: "Connected", hint: `Alerts now go to ${who}. Send yourself a test alert to check it arrives.` });
  }, [subscribed, code, status?.chatUsername]);

  /** challenge → wallet signature → the action itself. One path for all three. */
  async function run(action, label, fn) {
    setBusy(label); setMsg(null); setStage("asking the gateway for a challenge…");
    try {
      const ch = await telegramChallenge(address, action);
      if (!ch.ok) throw Object.assign(new Error(ch.error || "challenge failed"), { hint: ch.hint });
      setStage("waiting for your signature — check the wallet prompt…");
      const signature = await session.signMessage(ch.message);
      setStage("sending…");
      const r = await fn(signature, ch.nonce);
      if (!r.ok) throw Object.assign(new Error(r.error || `${label} failed`), { hint: r.hint });
      return r;
    } catch (e) {
      const text = String(e?.shortMessage || e?.message || e);
      setMsg({
        ok: false,
        label,
        error: /user (rejected|denied)|4001/i.test(text)
          ? "You declined the signature, so nothing changed. Ask again when ready."
          : text,
        hint: e?.hint || null,
      });
      return null;
    } finally {
      setBusy(null); setStage(null);
    }
  }

  async function connect() {
    const r = await run("subscribe", "Connect Telegram", async (signature, nonce) => {
      const out = await telegramSubscribe({ nonce, signature });
      if (out.ok) {
        setCode({ code: out.code, link: out.link, botUsername: out.botUsername, expiresAt: out.expiresAt });
        setMsg({ ok: true, label: "Code issued", hint: "Open the link below and press Start — that binds your chat to this wallet." });
      }
      return out;
    });
    if (r) loadStatus();
  }

  async function resend() {
    setCode(null);
    await connect();
  }

  async function sendTest() {
    const r = await run("test", "Test alert", async (signature, nonce) => telegramTest({ nonce, signature }));
    if (r) {
      setMsg(r.sent
        ? { ok: true, label: "Test alert sent", hint: "Check your Telegram chat — it should have arrived." }
        : { ok: false, label: "Test alert not sent", error: r.reason || "the gateway could not deliver it", hint: null });
      loadStatus();
    }
  }

  async function disconnect() {
    const r = await run("unsubscribe", "Disconnect", async (signature, nonce) => telegramUnsubscribe({ nonce, signature }));
    if (r) {
      setCode(null);
      setMsg({ ok: r.removed, label: "Disconnected", error: r.removed ? null : "there was no active binding to remove", hint: null });
      loadStatus();
    }
  }

  if (!gatewayOnline) {
    return (
      <div className="animate-fade space-y-8 pb-10">
        <PageHeader icon={Bell} eyebrow="notifications" title="Telegram alerts"
          sub="Payments, refusals and budget changes, pushed to your phone." />
        <Card icon={Bell} title="Your alerts" aside={<Badge tone="bad"><Dot tone="bad" /> gateway offline</Badge>}>
          <Note tone="bad">
            The gateway that holds the bot connection is not answering. Start it in a second terminal with{" "}
            <span className="code">npm run gateway</span> from the project root, then reload this page.
          </Note>
        </Card>
      </div>
    );
  }

  if (!address) {
    return (
      <div className="animate-fade space-y-8 pb-10">
        <PageHeader icon={Bell} eyebrow="notifications" title="Telegram alerts"
          sub="Payments, refusals and budget changes, pushed to your phone." />
        <Card icon={Bell} title="Your alerts" aside={<Badge tone="warn"><Dot tone="warn" pulse /> creating wallet</Badge>}>
          <p className="text-[14px] leading-relaxed text-muted">
            Privy is provisioning your agent wallet. Alerts bind to that wallet, so this page activates the moment it
            exists.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="animate-fade space-y-8 pb-10">
      <PageHeader
        icon={Bell}
        eyebrow="notifications"
        title="Telegram alerts"
        sub="Payments, refusals and budget changes for your own agent wallet — pushed to Telegram the moment they happen."
        aside={
          subscribed
            ? <Badge tone="ok"><Dot tone="ok" /> connected</Badge>
            : enabled
              ? <Badge tone="warn"><Dot tone="warn" /> not connected</Badge>
              : <Badge tone="neutral"><Dot tone="warn" /> bot not configured</Badge>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card
            title="Your alerts"
            aside={
              <div className="rounded border border-line-soft bg-ink-dim px-2.5 py-1 font-mono text-[13.5px] text-muted">
                <AddressLink address={address} chars={8} />
              </div>
            }
          >
            {!enabled && <SetupSteps config={config} onRecheck={() => { telegramConfig().then(setConfig); loadStatus(); }} />}

            {enabled && !subscribed && !code && (
              <>
                <p className="text-[14px] leading-relaxed text-muted">
                  Connect the Telegram account you want alerts on. You will sign one message from your agent wallet —
                  the bot never sees a key, and nothing is sent until the binding is complete.
                </p>
                <div className="mt-4">
                  <Button variant="primary" onClick={connect} disabled={busy !== null}>
                    {busy === "Connect Telegram" ? stage || "working…" : "Connect Telegram"}
                  </Button>
                </div>
              </>
            )}

            {enabled && code && !subscribed && (
              <div className="space-y-4">
                <p className="text-[14px] leading-relaxed text-muted">
                  <b className="text-text">Step 2 of 2.</b> Open your bot in Telegram and send the code — or use the
                  link, which sends it for you. The bot binds that chat to this wallet and burns the code.
                </p>

                {code.link ? (
                  <a
                    href={code.link}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-primary w-full justify-center text-[14px]"
                  >
                    Open {code.botUsername ? `@${code.botUsername.replace(/^@/, "")}` : "your bot"} in Telegram →
                  </a>
                ) : (
                  <Note tone="warn">
                    No <span className="code">TELEGRAM_BOT_USERNAME</span> on the gateway, so there is no direct link.
                    Open your bot in Telegram and send the code by hand below.
                  </Note>
                )}

                <div className="rounded-xl border border-line-soft bg-ink-dim p-4 text-center">
                  <div className="text-[12.5px] uppercase tracking-[0.14em] text-dim">
                    send this to the bot {code.botUsername ? `@${code.botUsername.replace(/^@/, "")}` : ""}
                  </div>
                  <div className="mt-2 flex items-center justify-center gap-3">
                    <span className="font-mono text-[26px] font-semibold tracking-[0.18em] text-btc">
                      {expired ? "EXPIRED" : code.code}
                    </span>
                    {!expired && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => copy(code.code)}
                        title="Copy the code"
                      >
                        {copied ? "copied" : "copy"}
                      </button>
                    )}
                  </div>
                  <div className="mt-1.5 text-[12.5px] text-dim">
                    {expired
                      ? "This code has expired — issue a new one. Codes are single-use and last 15 minutes."
                      : `expires in ${Math.floor(secondsLeft / 60)}m ${String(secondsLeft % 60).padStart(2, "0")}s · single use`}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {expired && <Button variant="primary" onClick={resend} disabled={busy !== null}>Issue a new code</Button>}
                  <Button onClick={loadStatus} disabled={busy !== null}>I already sent it — re-check</Button>
                  <Button variant="ghost" size="sm" onClick={() => setCode(null)} disabled={busy !== null}>cancel</Button>
                </div>

                {status?.pendingCode && status.pendingCode !== code.code && (
                  <Note tone="warn">
                    The gateway still has an earlier code pending for this wallet
                    (<span className="code">{status.pendingCode}</span>). Only the newest one is live — a replaced code
                    cannot be redeemed, which is why regenerating here is safe if a link leaks.
                  </Note>
                )}
              </div>
            )}

            {enabled && subscribed && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4 rounded-xl border border-line-soft bg-ink-dim/50 p-4 sm:grid-cols-3">
                  <div>
                    <div className="stat-label">Chat</div>
                    <div className="mt-0.5 font-mono text-[14px] text-text">
                      {status?.chatUsername ? `@${status.chatUsername}` : "private chat"}
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">Connected since</div>
                    <div className="mt-0.5 text-[14px] text-text">
                      {status?.since ? new Date(status.since).toLocaleString() : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">Alerts sent</div>
                    <div className="mt-0.5 text-[14px] text-text tnum">
                      {(status?.recent || []).filter((r) => r.ok).length}
                      <span className="ml-1 text-[12.5px] text-dim">of {(status?.recent || []).length} recent</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" onClick={sendTest} disabled={busy !== null}>
                    {busy === "Test alert" ? stage || "working…" : "Send a test alert"}
                  </Button>
                  <Button variant="danger" onClick={disconnect} disabled={busy !== null}>
                    {busy === "Disconnect" ? stage || "working…" : "Disconnect"}
                  </Button>
                  <span className="self-center text-[12.5px] text-dim">
                    or send <span className="code">/stop</span> to the bot — same result, no signature
                  </span>
                </div>

                <Note>
                  Disconnecting stops alerts; it does not change your caps, your float or your registration. Nothing
                  else in the protocol depends on this binding.
                </Note>
              </div>
            )}

            {msg && (
              <Note tone={msg.ok ? "ok" : "bad"} className="mt-4">
                <b>{msg.label}{msg.ok ? "" : " failed"}.</b>{" "}
                {msg.ok ? msg.hint : msg.error}
                {!msg.ok && msg.hint && <span className="text-dim"> — {msg.hint}</span>}
              </Note>
            )}
          </Card>

          {enabled && (status?.recent || []).length > 0 && (
            <Card title="Recent sends" aside={<Badge tone="neutral">last 10</Badge>}>
              <ul className="space-y-1.5">
                {status.recent.map((r, i) => (
                  <li key={`${r.at}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-dim">
                    <span className="tnum">{new Date(r.at).toLocaleString()}</span>
                    <Badge tone={r.ok ? "ok" : "bad"}>{r.kind.replace(/_/g, " ")}</Badge>
                    <span className={r.ok ? "" : "text-warn"}>{r.ok ? "delivered" : r.error || "not delivered"}</span>
                  </li>
                ))}
              </ul>
              <Note className="mt-4">
                This is the delivery log, not a payment history — it exists so a silent failure is visible. A
                <span className="code">rate limited</span> entry means more than 15 alerts in a minute for one chat.
                The authoritative ledger is on the <Link className="text-info underline decoration-line underline-offset-2 hover:decoration-info" to="/ledger">Ledger</Link> page and on chain.
              </Note>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <WhatYouGet />
          <Card title="How the binding works">
            <ol className="space-y-2.5 text-[13.5px] leading-relaxed text-muted">
              <li><b className="text-text">1.</b> The gateway writes a message naming this address and a fresh nonce.</li>
              <li><b className="text-text">2.</b> You sign it with your agent wallet — a Privy prompt; the key never leaves the enclave.</li>
              <li><b className="text-text">3.</b> The gateway recovers the signer and refuses unless it is this wallet. Only then does it issue a code.</li>
              <li><b className="text-text">4.</b> You send the code to the bot; the bot binds that chat and deletes the code.</li>
            </ol>
            <Note className="mt-4">
              The gateway long-polls Telegram instead of exposing a webhook, so this works from a laptop behind NAT with
              no public URL. Stored: one chat id per address, in
              <span className="code">server/telegram-state.json</span>, gitignored.
            </Note>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Operator-side setup, shown only when the bot token is genuinely absent. */
function SetupSteps({ config, onRecheck }) {
  return (
    <div className="space-y-4">
      <Note tone="warn">
        <b className="text-text">No bot is connected to this gateway.</b> Alerts are not simulated while that is true —
        this is a one-time operator step, and every alert kind on the right is what you get once it is done.
      </Note>
      <ol className="space-y-3 text-[13.5px] leading-relaxed text-muted">
        <li>
          <b className="text-text">1. Create the bot.</b> In Telegram, open{" "}
          <a className="text-info underline decoration-line underline-offset-2 hover:decoration-info"
             href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>{" "}
          → <span className="code">/newbot</span> → pick a name and a username ending in{" "}
          <span className="code">bot</span> → copy the HTTP API token.
        </li>
        <li>
          <b className="text-text">2. Add it to the gateway env.</b> In{" "}
          <span className="code">server/.env</span>:
          <pre className="mt-2 overflow-x-auto rounded border border-line-soft bg-ink-dim p-3 font-mono text-[12.5px] text-muted">
{`TELEGRAM_BOT_TOKEN=123456789:AA...your token...
TELEGRAM_BOT_USERNAME=agentfloat_alerts_bot
TELEGRAM_WATCH_SECONDS=300`}
          </pre>
          <span className="mt-1 block text-[12.5px] text-dim">
            <span className="code">TELEGRAM_BOT_USERNAME</span> is optional but enables the one-tap
            <span className="code">t.me/&lt;bot&gt;?start=&lt;code&gt;</span> link. <span className="code">WATCH_SECONDS</span> is the
            on-chain watcher that catches events the gateway never saw (a payment settled directly from a browser).
          </span>
        </li>
        <li>
          <b className="text-text">3. Restart the gateway.</b> <span className="code">npm run gateway</span> from the
          project root. The boot line should read <span className="code">telegram on</span> rather than{" "}
          <span className="code">telegram alerts off</span>.
        </li>
        <li>
          <b className="text-text">4. Come back here</b> and press <span className="code">Connect Telegram</span>.
        </li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onRecheck}>Re-check the gateway</Button>
        <span className="text-[12.5px] text-dim">{config?.note || "No bot token configured."}</span>
      </div>
      {!config?.botUsername && config?.enabled && (
        <span className="block text-[12.5px] text-dim">
          Token found but no username set — binding still works, you will just paste the code by hand.
        </span>
      )}
    </div>
  );
}

function WhatYouGet() {
  return (
    <Card title="What you get" aside={<Badge tone="neutral">{ALERTS.length} kinds</Badge>}>
      <ul className="space-y-3">
        {ALERTS.map((a) => (
          <li key={a.kind} className="border-b border-line-soft pb-3 last:border-0 last:pb-0">
            <div className="text-[14px] font-medium text-text">{a.label}</div>
            <div className="mt-0.5 text-[12.5px] leading-relaxed text-dim">{a.detail}</div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
