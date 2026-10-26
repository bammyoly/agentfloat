// ---------------------------------------------------------------------------
// Telegram alerts — the user's own agent, reported to their own phone.
//
// WHY THIS IS IN WAVE 1
//   A budget cap you have to stare at a dashboard to notice is half a control.
//   The point of AgentFloat is that an agent spends inside limits while nobody is
//   watching, so the moment it spends, is refused, or crosses a threshold, the
//   person who owns the wallet should hear about it where they already are.
//
// HOW A USER CONNECTS (no phone number, no OAuth, no secret)
//   1. the app asks the gateway for a subscribe code bound to THEIR agent
//      address — which requires a signature from that wallet, so nobody can bind
//      somebody else's alerts to their own Telegram;
//   2. the user opens t.me/<bot>?start=<code>;
//   3. the bot receives that /start, maps code → address, stores the chat id, and
//      confirms. Done.
//
// WHY LONG POLLING AND NOT A WEBHOOK
//   Webhooks need a public HTTPS URL. This gateway runs on a laptop at
//   127.0.0.1:4022 during a buildathon. getUpdates long polling is outbound-only,
//   so it works behind NAT with no tunnel — and exactly one process may poll, so a
//   409 is reported as "another gateway is polling", not swallowed.
//
// WHAT GETS SENT
//   Two sources, both chain-derived:
//     • inline events — the gateway saw it happen (a relayed payment, a refusal,
//       a budget change, a faucet claim), so it reports immediately;
//     • the watcher — a poll per subscribed agent that diffs on-chain counters,
//       which is what catches payments a browser settled directly, where the
//       gateway was never in the loop. It reports what the CHAIN says, not what a
//       client claimed.
//
// NOTHING IS MOCKED: with no TELEGRAM_BOT_TOKEN the feature reports itself
// unavailable and the UI shows the three setup steps instead of a fake inbox.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import crypto from "node:crypto";

const API = "https://api.telegram.org";
const CODE_TTL_MS = 15 * 60_000;
const MAX_SENT_LOG = 100;
const MAX_PER_MINUTE_PER_CHAT = 15; // Telegram's own limit is ~30; stay well under

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const short = (a, n = 4) => (a ? `${String(a).slice(0, n + 2)}…${String(a).slice(-n)}` : "—");
const musd = (wei) => {
  try {
    return Number(ethersFormat(wei)).toLocaleString(undefined, { maximumFractionDigits: 6 });
  } catch {
    return String(wei ?? "—");
  }
};
// Local formatter rather than importing ethers for one call: this module is also
// unit-tested offline, where dragging the SDK in buys nothing.
function ethersFormat(wei) {
  const v = BigInt(wei || 0);
  const s = v.toString().padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".0");
}

/** Render one event as a Telegram HTML message. Exported for the offline tests. */
export function renderEvent(ev = {}) {
  const kind = ev.kind || "info";
  const lines = [];
  switch (kind) {
    case "payment":
      lines.push(`💸 <b>Agent paid ${escapeHtml(musd(ev.amount))} MUSD</b>`);
      if (ev.payee) lines.push(`to <code>${escapeHtml(short(ev.payee, 6))}</code>`);
      if (ev.endpoint) lines.push(`for ${escapeHtml(ev.endpoint)}`);
      if (ev.remainingToday !== undefined && ev.dailyCap) {
        lines.push(`Left today: ${escapeHtml(musd(ev.remainingToday))} of ${escapeHtml(musd(ev.dailyCap))} MUSD`);
      }
      if (ev.txHash) lines.push(`<a href="${escapeHtml(ev.explorerTx || "")}">settlement tx</a>`);
      break;
    case "denial":
      lines.push(`⛔ <b>Payment refused</b>`);
      lines.push(`${escapeHtml(ev.reason || "policy")} — attempted ${escapeHtml(musd(ev.attempted))} MUSD`);
      if (ev.endpoint) lines.push(`for ${escapeHtml(ev.endpoint)}`);
      lines.push("Nothing was signed and nothing was spent.");
      break;
    case "limits_changed": {
      const c = ev.change || {};
      lines.push(`🎚 <b>Budget updated</b>`);
      lines.push(`per-call ${escapeHtml(c.perCallMaxMusd ?? "?")} MUSD · daily ${escapeHtml(c.dailyCapMusd ?? "?")} MUSD`);
      if (c.previous) {
        lines.push(`was per-call ${escapeHtml(Number(c.previous.perCallMaxMusd).toFixed(3))} · daily ${escapeHtml(Number(c.previous.dailyCapMusd).toFixed(2))}`);
      }
      if (c.txHash) lines.push(`tx <code>${escapeHtml(c.txHash.slice(0, 18))}…</code>`);
      break;
    }
    case "agent_frozen":
      lines.push(`🧊 <b>Agent frozen</b> — the treasury will refuse its payments until you unfreeze.`);
      break;
    case "agent_unfrozen":
      lines.push(`✅ <b>Agent re-enabled</b> — payments are allowed again.`);
      break;
    case "faucet_claim":
      lines.push(`🚰 <b>Faucet claim landed</b> — ${escapeHtml(musd(ev.amount))} MUSD is in your agent wallet.`);
      lines.push("Spend it from the Spend page; the caps are already set on chain.");
      break;
    case "gas_drip":
      lines.push(`⛽ <b>Gas sent</b> — ${escapeHtml(String(ev.amountBtc ?? "0"))} BTC to your agent wallet.`);
      lines.push("That is enough to send the Permit2 approval that lets x402 payments settle.");
      if (ev.txHash) lines.push(`tx <code>${escapeHtml(String(ev.txHash).slice(0, 18))}…</code>`);
      break;
    case "cap_warning":
      lines.push(`⚠️ <b>${escapeHtml(ev.pct ?? 0)}% of today's cap used</b>`);
      lines.push(`${escapeHtml(musd(ev.remainingToday))} MUSD left of ${escapeHtml(musd(ev.dailyCap))} today.`);
      break;
    case "test":
      lines.push(`🔔 <b>Test alert</b> — AgentFloat can reach this chat.`);
      lines.push(`agent <code>${escapeHtml(short(ev.address, 6))}</code>`);
      break;
    default:
      lines.push(`ℹ️ ${escapeHtml(ev.title || kind)}`);
      if (ev.detail) lines.push(escapeHtml(ev.detail));
  }
  lines.push("", `<i>AgentFloat · Mezo testnet</i>`);
  return lines.join("\n");
}

export function createTelegram({ token, botUsername, stateFile, log = () => {} }) {
  const enabled = Boolean(token && token.includes(":"));
  let running = false;
  let offset = 0;
  let pollTimer = null;
  let watchTimer = null;
  const buckets = new Map(); // chatId → timestamps of recent sends

  function load() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return { pending: {}, subs: {}, sent: [], ...s };
    } catch {
      return { pending: {}, subs: {}, sent: [] };
    }
  }
  function save(s) {
    try {
      s.pending = Object.fromEntries(
        Object.entries(s.pending || {}).filter(([, v]) => Date.now() - v.createdAt < CODE_TTL_MS)
      );
      s.sent = (s.sent || []).slice(0, MAX_SENT_LOG);
      fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
    } catch (e) {
      log(`  ⚠️  telegram state not persisted: ${e.message}`);
    }
  }

  async function api(method, params = {}) {
    if (!enabled) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(35_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(data.description || `${method} failed (${res.status})`);
      err.code = data.error_code;
      throw err;
    }
    return data.result;
  }

  function allowSend(chatId) {
    const now = Date.now();
    const bucket = (buckets.get(chatId) || []).filter((t) => now - t < 60_000);
    if (bucket.length >= MAX_PER_MINUTE_PER_CHAT) {
      buckets.set(chatId, bucket);
      return false;
    }
    bucket.push(now);
    buckets.set(chatId, bucket);
    return true;
  }

  function recordSend(s, address, kind, ok, error) {
    s.sent.unshift({ at: new Date().toISOString(), address, kind, ok, error: error || null });
    return s;
  }

  /** Send one event to whoever owns this agent address. Never throws. */
  async function notify(address, event) {
    if (!enabled || !address) return { sent: false, reason: enabled ? "no address" : "telegram not configured" };
    const s = load();
    const sub = s.subs[String(address).toLowerCase()];
    if (!sub?.chatId) return { sent: false, reason: "not subscribed" };
    if (!allowSend(sub.chatId)) {
      save(recordSend(s, address, event.kind, false, "rate limited"));
      return { sent: false, reason: "rate limited" };
    }
    try {
      await api("sendMessage", {
        chat_id: sub.chatId,
        text: renderEvent(event),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      save(recordSend(s, address, event.kind, true));
      return { sent: true };
    } catch (e) {
      // A blocked bot, a deleted chat or a Telegram outage must never break a
      // payment or a budget change. Log it, record it, carry on.
      log(`  ⚠️  telegram send failed (${event.kind}): ${e.message}`);
      save(recordSend(s, address, event.kind, false, e.message));
      return { sent: false, reason: e.message };
    }
  }

  /** A single-use code bound to an agent address, plus the t.me link. */
  function createCode(address) {
    if (!enabled) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not set" };
    const code = crypto.randomBytes(5).toString("base64url").replace(/[-_]/g, "").slice(0, 8).toUpperCase();
    const s = load();
    // One live code per address: a new code replaces the old, so a leaked link
    // cannot be used after the user regenerates it.
    for (const [k, v] of Object.entries(s.pending)) {
      if (v.address?.toLowerCase() === String(address).toLowerCase()) delete s.pending[k];
    }
    s.pending[code] = { address: String(address), createdAt: Date.now() };
    save(s);
    return {
      ok: true,
      code,
      link: botUsername ? `https://t.me/${botUsername.replace(/^@/, "")}?start=${code}` : null,
      botUsername: botUsername || null,
      expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    };
  }

  function status(address) {
    const s = load();
    const key = String(address || "").toLowerCase();
    const sub = s.subs[key];
    const pendingCode = Object.entries(s.pending).find(([, v]) => v.address?.toLowerCase() === key)?.[0] || null;
    return {
      ok: true,
      enabled,
      subscribed: Boolean(sub?.chatId),
      chatUsername: sub?.username || null,
      since: sub?.since || null,
      pendingCode,
      recent: s.sent.filter((x) => x.address?.toLowerCase() === key).slice(0, 10),
    };
  }

  function unsubscribe(address) {
    const s = load();
    const key = String(address || "").toLowerCase();
    const had = Boolean(s.subs[key]);
    delete s.subs[key];
    save(s);
    return { ok: true, removed: had };
  }

  // --- the /start handler ---------------------------------------------------
  async function handleMessage(msg) {
    const text = String(msg?.text || "").trim();
    const chatId = msg?.chat?.id;
    const username = msg?.from?.username || msg?.chat?.username || null;
    if (!chatId) return;

    const s = load();

    if (/^\/start(\s+(\S+))?$/i.test(text)) {
      const code = (text.match(/^\/start\s+(\S+)$/i)?.[1] || "").toUpperCase();
      const pending = code ? s.pending[code] : null;
      if (!pending) {
        await api("sendMessage", {
          chat_id: chatId,
          text:
            "Welcome to AgentFloat alerts.\n\n" +
            "Open the <b>Alerts</b> page in the app while signed in and press " +
            "<i>Connect Telegram</i>, then use the link it gives you — it carries a code that " +
            "binds this chat to your agent wallet.",
          parse_mode: "HTML",
        }).catch(() => {});
        return;
      }
      delete s.pending[code];
      s.subs[pending.address.toLowerCase()] = {
        chatId,
        username,
        since: new Date().toISOString(),
        snapshot: null,
        warnedDay: null,
      };
      save(s);
      log(`  🔔 telegram bound ${short(pending.address, 4)} → chat ${chatId}`);
      await api("sendMessage", {
        chat_id: chatId,
        text:
          `✅ Connected.\n\nAlerts for agent <code>${escapeHtml(pending.address)}</code> will arrive here: ` +
          "payments, refusals, budget changes, faucet claims and a warning as your daily cap runs out.\n\n" +
          "Send /stop to disconnect.",
        parse_mode: "HTML",
      }).catch(() => {});
      return;
    }

    if (/^\/stop$/i.test(text)) {
      const mine = Object.entries(s.subs).find(([, v]) => v.chatId === chatId);
      if (mine) {
        delete s.subs[mine[0]];
        save(s);
        await api("sendMessage", { chat_id: chatId, text: "Disconnected. Re-connect any time from the Alerts page." }).catch(() => {});
      }
      return;
    }

    if (/^\/status$/i.test(text)) {
      const mine = Object.entries(s.subs).find(([, v]) => v.chatId === chatId);
      await api("sendMessage", {
        chat_id: chatId,
        text: mine
          ? `Watching agent <code>${escapeHtml(mine[0])}</code> since ${escapeHtml(mine[1].since)}.`
          : "This chat is not bound to an agent. Use the link from the Alerts page.",
        parse_mode: "HTML",
      }).catch(() => {});
    }
  }

  async function pollOnce() {
    if (!enabled || !running) return;
    try {
      const updates = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
      for (const u of updates || []) {
        offset = Math.max(offset, u.update_id + 1);
        await handleMessage(u.message).catch((e) => log(`  ⚠️  telegram handler: ${e.message}`));
      }
      if (running) pollTimer = setTimeout(pollOnce, 300);
    } catch (e) {
      // 409 = another process is polling with this token (a second gateway).
      // That is a configuration error worth shouting about, not a transient one.
      const conflict = e.code === 409;
      log(`  ⚠️  telegram polling ${conflict ? "CONFLICT (409): another gateway is using this bot token" : "error"}: ${e.message}`);
      if (running) pollTimer = setTimeout(pollOnce, conflict ? 60_000 : 8_000);
    }
  }

  /**
   * The watcher: catch what the gateway did not see. A browser-settled payment
   * never passes through this process, but it does pass through the chain, so
   * diff the on-chain counters for each subscribed agent.
   *
   * @param opts.getSnapshot async (address) => { payments, denials,
   *   remainingToday, dailyCap, walletBalance, lifetimeFunded, active }
   *   — counters only, so a tick costs ONE rpc call per subscriber.
   * @param opts.getDetail async (address) => { lastPayment, lastDenial } — called
   *   ONLY when a counter moved, because the interesting detail (the last payment
   *   row, the denial reason) costs extra reads that would otherwise be wasted on
   *   every tick for every subscriber.
   */
  function startWatcher({ getSnapshot, getDetail = null, intervalMs = 20_000 } = {}) {
    if (!enabled) return;
    const tick = async () => {
      if (!running) return;
      const s = load();
      const entries = Object.entries(s.subs || {});
      for (const [address, sub] of entries) {
        try {
          const snap = await getSnapshot(address);
          if (!snap) continue;
          const prev = sub.snapshot;
          sub.snapshot = snap;

          if (prev) {
            const paid = BigInt(snap.payments || 0) > BigInt(prev.payments || 0);
            const denied = BigInt(snap.denials || 0) > BigInt(prev.denials || 0);
            const funded = BigInt(snap.lifetimeFunded || 0) > BigInt(prev.lifetimeFunded || 0);

            if (paid || denied || funded) {
              const detail = getDetail ? await getDetail(address).catch(() => null) : null;
              if (paid) {
                await notify(address, {
                  kind: "payment",
                  ...(detail?.lastPayment || {}),
                  remainingToday: snap.remainingToday,
                  dailyCap: snap.dailyCap,
                });
              }
              if (denied && detail?.lastDenial) {
                await notify(address, { kind: "denial", ...detail.lastDenial });
              }
              if (funded && !paid) {
                // Float arrived without a payment: a faucet claim or an operator
                // release. Worth telling the user their wallet was funded.
                await notify(address, {
                  kind: "faucet_claim",
                  amount: (BigInt(snap.lifetimeFunded || 0) - BigInt(prev.lifetimeFunded || 0)).toString(),
                });
              }
            }
            if (prev.active && !snap.active) await notify(address, { kind: "agent_frozen" });
            if (!prev.active && snap.active) await notify(address, { kind: "agent_unfrozen" });
          }

          // One threshold warning per UTC day, so a busy agent is not spammed.
          const daily = BigInt(snap.dailyCap || 0);
          const left = BigInt(snap.remainingToday || 0);
          const day = new Date().toISOString().slice(0, 10);
          if (daily > 0n && left * 5n < daily && sub.warnedDay !== day) {
            sub.warnedDay = day;
            await notify(address, {
              kind: "cap_warning",
              pct: Number(((daily - left) * 100n) / daily),
              remainingToday: left.toString(),
              dailyCap: daily.toString(),
            });
          }
          save(s);
        } catch (e) {
          log(`  ⚠️  telegram watcher for ${short(address, 4)}: ${e.message}`);
        }
      }
      if (running) watchTimer = setTimeout(tick, intervalMs);
    };
    watchTimer = setTimeout(tick, intervalMs);
  }

  function start() {
    if (!enabled) {
      log("  🔕 telegram alerts off — set TELEGRAM_BOT_TOKEN in server/.env to enable");
      return;
    }
    running = true;
    pollOnce();
    log(`  🔔 telegram alerts on${botUsername ? ` (@${botUsername.replace(/^@/, "")})` : " — set TELEGRAM_BOT_USERNAME for one-click subscribe links"}`);
  }

  function stop() {
    running = false;
    clearTimeout(pollTimer);
    clearTimeout(watchTimer);
  }

  return {
    enabled,
    start,
    stop,
    startWatcher,
    notify,
    createCode,
    status,
    unsubscribe,
    renderEvent,
    config: () => ({
      ok: true,
      enabled,
      botUsername: botUsername || null,
      alerts: ["payment", "denial", "limits_changed", "agent_frozen", "faucet_claim", "gas_drip", "cap_warning"],
      note: enabled
        ? "Connect with a one-time code from the Alerts page."
        : "Create a bot with @BotFather, put the token in server/.env as TELEGRAM_BOT_TOKEN, and restart the gateway.",
    }),
  };
}
