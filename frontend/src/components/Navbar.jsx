// ---------------------------------------------------------------------------
// Navbar.
//
// The links change with the session, because the two audiences want different
// things:
//
//   signed out — Home, How it works, Protocol. A visitor is still deciding what
//                this is; product routes would be dead ends behind a login.
//   signed in  — Dashboard, Faucet, Spend, Ledger, Alerts, Operate. They have an
//                agent wallet now and are here to use it.
//
// Each link carries an icon as well as a word. Nine pages of text-only nav is a
// list to read; an icon makes the active page findable in peripheral vision,
// which is what a navbar is actually for. The icons are aria-hidden — the label
// is right there, so announcing both would just be noise.
//
// The brand always links home, so a signed-in user can still reach the marketing
// surface, and /architecture stays publicly routable either way.
//
// RIGHT SIDE, SIGNED IN: an identity chip. It shows the same two lines it always
// did (who you are, and your agent address) but it is a button that opens a menu
// holding the things you actually want from a wallet chip — the FULL agent
// address, click to copy, with confirmation; the connected external wallet when
// there is one; the network you are on; and Sign out. Sign out lives in the menu
// because a bare "Sign out" next to an address invites misclicks on the one
// destructive action in the navbar, and because copying an address needs room the
// header does not have.
//
// THE NETWORK BUTTON is deliberately OUTSIDE the menu as well: a wallet on the
// wrong chain is a blocking condition, and hiding the fix behind a click is how
// people conclude the button "doesn't work". It only renders on a measured wrong
// chain (session.chainOk === false), never on "unknown" — offering a switch for a
// wallet that has not been read yet produces a button that appears to do nothing.
// ---------------------------------------------------------------------------

import React, { useEffect, useRef, useState } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import {
  Activity, AlertTriangle, Bell, Check, ChevronDown, Copy, ExternalLink,
  Faucet, Gauge, Home, Info, LayoutDashboard, LogOut, Menu, Network, PlugZap,
  RefreshCw, Server, TriangleAlert, Wallet, Waypoints, X,
} from "lucide-react";
import { useSession } from "../lib/session.jsx";
import { Badge, Button, Dot, Icon, IconTile, copyText } from "./ui.jsx";
import { short } from "../lib/chain.js";
import { CHAIN, explorerAddress } from "../contracts/index.js";
import { MEZO_TESTNET_ID } from "../lib/evm-network.js";

// "How it works" is a section of the landing page, not a route of its own.
const PUBLIC_LINKS = [
  { to: "/", label: "Home", end: true, icon: Home },
  { to: "/#how-it-works", label: "How it works", icon: Waypoints },
  { to: "/architecture", label: "Protocol", icon: Network },
];

const APP_LINKS = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/faucet", label: "Faucet", icon: Faucet },
  { to: "/spend", label: "Spend", icon: PlugZap },
  { to: "/ledger", label: "Ledger", icon: Activity },
  { to: "/alerts", label: "Alerts", icon: Bell },
  { to: "/operate", label: "Operate", icon: Gauge },
];

export default function Navbar({ health }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const gwUp = Boolean(health) && !health.unreachable;

  const signedIn = Boolean(session.user);
  const links = signedIn ? APP_LINKS : PUBLIC_LINKS;

  // A hash link to the page we are already on does not re-render the target,
  // so scroll explicitly. Otherwise let the route change close the menu.
  const onNavigate = () => setOpen(false);

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-ink/88 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-4 px-5">
          {/* brand */}
          <Link
            to="/"
            onClick={onNavigate}
            className="flex shrink-0 items-center gap-2.5 rounded-md transition-opacity hover:opacity-90"
            title="AgentFloat — home"
          >
            <span className="grid h-8 w-8 place-items-center rounded-[10px] border border-btc/45 bg-btc/12 text-btc">
              <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="text-[16px] font-semibold tracking-tight text-text">AgentFloat</span>
          </Link>

          {/* links — desktop */}
          <nav className="ml-2 hidden items-center gap-1 lg:flex" aria-label="Main">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                onClick={onNavigate}
                className={({ isActive }) =>
                  `nav-link inline-flex items-center gap-2 ${isActive && location.hash === "" ? "nav-link-active" : ""}`
                }
              >
                <Icon as={l.icon} size={15} className="opacity-75" />
                {l.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex-1" />

          {/* status */}
          <div className="hidden items-center gap-2 md:flex">
            <Badge
              tone={gwUp ? "ok" : "bad"}
              icon={gwUp ? Server : AlertTriangle}
              title={
                gwUp
                  ? `gateway reachable${health?.deployment?.public ? ` (public, on ${health.deployment.host}:${health.deployment.port})` : " on this machine"}`
                  : "gateway not running — start it with npm run dev"
              }
            >
              <Dot tone={gwUp ? "ok" : "bad"} pulse={!gwUp} />
              {gwUp ? "gateway online" : "gateway offline"}
            </Badge>
            <Badge tone="btc" icon={Network} title={`chain id ${CHAIN.id}`}>{CHAIN.name}</Badge>
          </div>

          {/* wallet */}
          <div className="hidden sm:block">
            <WalletArea session={session} />
          </div>

          {/* mobile toggle */}
          <button
            className="btn btn-sm btn-ghost cursor-pointer border border-line lg:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close navigation" : "Open navigation"}
          >
            <Icon as={open ? X : Menu} size={16} />
          </button>
        </div>

        {/* small screens: links + wallet on a second row */}
        {open && (
          <div id="mobile-nav" className="border-t border-line-soft bg-ink-soft/60 px-4 py-3.5 lg:hidden">
            <nav className="flex flex-col gap-1" aria-label="Main">
              {links.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    `nav-link inline-flex items-center gap-2.5 py-2.5 text-[15px] ${isActive && location.hash === "" ? "nav-link-active" : ""}`
                  }
                >
                  <Icon as={l.icon} size={16} className="opacity-75" />
                  {l.label}
                </NavLink>
              ))}
            </nav>
            <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-3.5">
              <div className="flex items-center gap-2">
                <Badge tone={gwUp ? "ok" : "bad"} icon={gwUp ? Server : AlertTriangle}>
                  <Dot tone={gwUp ? "ok" : "bad"} pulse={!gwUp} />
                  {gwUp ? "online" : "offline"}
                </Badge>
                <Badge tone="btc" icon={Network}>{CHAIN.name}</Badge>
              </div>
              <WalletArea session={session} />
            </div>
          </div>
        )}
      </header>

      {/* Rendered once, at the shell level, in EVERY session state.
          It used to live inside the signed-out branch, which meant a failed
          NETWORK SWITCH — the one error a signed-in user can actually get —
          set session.authError and displayed nothing at all. The button looked
          dead because its only feedback channel was unreachable. */}
      <AuthErrorToast session={session} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Identity area
// ---------------------------------------------------------------------------

/**
 * Best available human label. `connectedWallet` is a boolean on the
 * injected/Reown session shape, so it must be mapped to words — rendering it
 * directly printed nothing at all, and the chip looked empty.
 */
function identityLabel(user) {
  return (
    user?.email?.address ||
    user?.google?.email ||
    (user?.connectedWallet ? "connected wallet" : null) ||
    (user?.id ? `${String(user.id).slice(0, 10)}…` : null) ||
    "signed in"
  );
}

function WalletArea({ session }) {
  // No App ID: say so rather than rendering a button that cannot work.
  if (!session.configured) {
    return (
      <Badge tone="warn" icon={AlertTriangle} title="Set VITE_PRIVY_APP_ID in frontend/.env to enable Google/email sign-in">
        <Dot tone="warn" /> Privy not configured
      </Badge>
    );
  }

  if (!session.ready) {
    return (
      <span className="flex items-center gap-2 text-[13px] text-dim">
        <Icon as={RefreshCw} size={13} className="ring-spin" />
        loading session…
      </span>
    );
  }

  if (!session.user) {
    return (
      <button
        className="btn btn-primary cursor-pointer"
        onClick={session.login}
        disabled={session.authenticating}
        title="Sign in with Google or email — this creates your agent wallet"
      >
        {session.authenticating
          ? <><Icon as={RefreshCw} size={15} className="ring-spin" /> Opening…</>
          : <><Icon as={Wallet} size={15} /> Sign in</>}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <NetworkButton session={session} />
      {session.isOperator && (
        <Badge tone="btc" icon={Gauge} title="The wallet you connected is the on-chain treasury owner">
          operator
        </Badge>
      )}
      <UserMenu session={session} />
    </div>
  );
}

/**
 * Wrong-chain fix, shown whenever the chain is measured to be wrong.
 *
 * AgentFloat only exists on Mezo testnet, so a wallet on another chain is
 * connected but useless. The switch itself lives in lib/evm-network.js
 * (ensureWalletChain → Privy's switchChain for an embedded wallet, EIP-3085
 * switch/add for an injected one) and every failure is reported through
 * session.authError, which the toast below renders.
 */
function NetworkButton({ session }) {
  if (session.chainOk !== false) return null;
  const caption = session.chainId ? `switch to Mezo (on ${session.chainId})` : "switch to Mezo";
  return (
    <button
      className="btn btn-sm cursor-pointer border-warn/45 bg-warn/10 text-warn hover:border-warn hover:bg-warn/20"
      onClick={() => { session.fixNetwork().catch(() => {}); }}
      disabled={session.networkBusy}
      title={`This wallet is on chain ${session.chainId ?? "an unknown network"}. Click to move it to ${CHAIN.name} (${MEZO_TESTNET_ID}), adding the network first if the wallet does not know it.`}
    >
      {session.networkBusy
        ? <Icon as={RefreshCw} size={14} className="ring-spin" />
        : <Icon as={AlertTriangle} size={14} />}
      <span className="hidden md:inline">wrong network — {caption}</span>
      <span className="md:hidden">wrong network</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// User menu — identity, copyable agent address, network, sign out
// ---------------------------------------------------------------------------

function UserMenu({ session }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(null); // "agent" | "external"
  const wrap = useRef(null);
  const timer = useRef(null);
  const location = useLocation();

  const label = identityLabel(session.user);
  const agentAddress = session.agentAddress || null;
  const external = session.externalWallets?.[0] || null;
  const kind = session.agentWallet?.walletClientType === "privy" ? "embedded EOA" : "external EOA";

  // Close on outside click, Escape, and navigation. A menu that survives a route
  // change floats over the next page with no way to tell it belongs to the last.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => { setOpen(false); }, [location.pathname]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (which, value) => {
    const ok = await copyText(value);
    if (!ok) return;
    setCopied(which);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1800);
  };

  const onSignOut = async () => {
    setOpen(false);
    setCopied(null);
    await session.logout();
  };

  const netTone = session.chainOk === true ? "ok" : session.chainOk === false ? "bad" : "warn";
  const netLabel =
    session.chainOk === true
      ? `${CHAIN.name} · ${MEZO_TESTNET_ID}`
      : session.chainOk === false
        ? `wrong network · chain ${session.chainId || "unknown"}`
        : "checking network…";

  return (
    <div className="relative" ref={wrap}>
      {/* The chip keeps showing what it always showed — who you are, and your
          agent address — so nothing is lost by moving Sign out into the menu. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Your agent wallet — click to copy the address or sign out"
        className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-2 py-1.5 transition-colors ${
          open ? "border-line bg-panel-2" : "border-transparent hover:border-line hover:bg-panel-2"
        }`}
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-btc/45 bg-btc/12 text-[13px] font-semibold text-btc">
          {label.charAt(0).toUpperCase()}
        </span>
        <span className="hidden text-left leading-tight md:block">
          <span className="block max-w-[140px] truncate text-[13px] font-medium text-text">{label}</span>
          <span className="block font-mono text-[11.5px] text-dim">
            {agentAddress ? short(agentAddress, 4) : "creating wallet…"}
          </span>
        </span>
        <Icon as={ChevronDown} size={14} className={`text-dim transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Your agent wallet"
          className="absolute right-0 z-50 mt-2 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        >
          {/* identity */}
          <div className="flex items-start justify-between gap-3 px-4 py-3.5">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-dim">signed in as</div>
              <div className="mt-1 truncate text-[14.5px] font-medium text-text" title={label}>
                {label}
              </div>
            </div>
            <Badge tone="info" icon={Wallet} title="How the agent wallet is held">
              {kind}
            </Badge>
          </div>

          {/* the agent wallet — the thing people actually want to copy */}
          <div className="border-t border-line-soft px-4 py-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-dim">your agent wallet</span>
              {session.isOperator && <Badge tone="btc">operator</Badge>}
            </div>

            {agentAddress ? (
              <>
                {/* Whole row is the copy target: that is the interaction asked
                    for, and a separate icon alone would be missed. */}
                <button
                  type="button"
                  onClick={() => copy("agent", agentAddress)}
                  title="Copy the full address"
                  className="mt-2.5 flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-lg border border-line-soft bg-ink-dim px-3 py-2.5 text-left transition-colors hover:border-faint"
                >
                  <span className="min-w-0 break-all font-mono text-[12.5px] leading-snug text-text">
                    {agentAddress}
                  </span>
                  <span className={`shrink-0 ${copied === "agent" ? "text-ok" : "text-dim"}`}>
                    <Icon as={copied === "agent" ? Check : Copy} size={14} />
                  </span>
                </button>
                <div className="mt-2 flex items-center justify-between gap-2 text-[12.5px]">
                  <span className="text-dim">
                    {copied === "agent" ? "on your clipboard" : "click to copy"}
                  </span>
                  <a
                    href={explorerAddress(agentAddress)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-info hover:underline"
                  >
                    explorer <Icon as={ExternalLink} size={12} />
                  </a>
                </div>
              </>
            ) : (
              <div className="mt-2.5 rounded-lg border border-warn/30 bg-warn-dim/50 px-3 py-2.5">
                <div className="flex items-center gap-2 text-[13.5px] font-medium text-warn">
                  <Icon as={RefreshCw} size={14} className="ring-spin" /> creating wallet…
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
                  Privy provisions it right after sign-in. Google takes a little longer than email
                  because of the OAuth round-trip; it is created once and reattached on every later
                  login.
                </p>
              </div>
            )}
          </div>

          {/* a connected external wallet, when there is one */}
          {external?.address && external.address !== agentAddress && (
            <div className="border-t border-line-soft px-4 py-3.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-dim">connected wallet</div>
              <button
                type="button"
                onClick={() => copy("external", external.address)}
                title="Copy the full address"
                className="mt-2.5 flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-lg border border-line-soft bg-ink-dim px-3 py-2.5 text-left transition-colors hover:border-faint"
              >
                <span className="min-w-0 break-all font-mono text-[12.5px] leading-snug text-muted">
                  {external.address}
                </span>
                <span className={`shrink-0 ${copied === "external" ? "text-ok" : "text-dim"}`}>
                  <Icon as={copied === "external" ? Check : Copy} size={14} />
                </span>
              </button>
            </div>
          )}

          {/* network */}
          <div className="flex items-center justify-between gap-2 border-t border-line-soft px-4 py-3">
            <span className="flex min-w-0 items-center gap-2 text-[13px] text-muted">
              <Dot tone={netTone} pulse={netTone !== "ok"} />
              <span className="truncate">{netLabel}</span>
            </span>
            {session.chainOk === false && (
              <button
                className="btn btn-sm cursor-pointer shrink-0"
                onClick={() => { session.fixNetwork().catch(() => {}); }}
                disabled={session.networkBusy}
                title={`Switch this wallet to ${CHAIN.name} (${MEZO_TESTNET_ID})`}
              >
                <Icon as={session.networkBusy ? RefreshCw : Network} size={13} className={session.networkBusy ? "ring-spin" : ""} />
                {session.networkBusy ? "switching…" : "Switch"}
              </button>
            )}
          </div>

          {/* sign out */}
          <div className="border-t border-line px-3 py-3.5">
            <button
              className="btn btn-danger w-full cursor-pointer"
              onClick={onSignOut}
              title="Sign out of Privy. Your agent wallet and its balance stay on chain, and the same login gets them back."
            >
              <Icon as={LogOut} size={15} />
              Sign out
            </button>
            <p className="mt-2.5 px-1 text-[12px] leading-relaxed text-dim">
              Signing out does not touch your wallet or its balance — the same login reattaches the
              same address.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Why a toast and not a modal: Privy's own login UI is a <dialog>, and stacking
 * a second dialog on top of it is exactly the collision Privy documents under
 * "Multiple dialogs". A fixed, non-modal panel cannot fight the login UI for
 * focus or the top layer, and it survives navigation, so an error raised from the
 * Home page button is still visible on the dashboard.
 *
 * Rendered from the navbar because the navbar is in the shell on every route,
 * and five different pages have a sign-in button. One place beats five. It also
 * carries NETWORK errors, which only exist once somebody is signed in.
 */
// ---------------------------------------------------------------------------
// The sign-in toast.
//
// WHAT CHANGED AND WHY
//   Closing the Privy popup used to produce this: a red "Sign-in failed" alert,
//   Privy's raw code, a paragraph about wallet extensions breaking an iframe
//   handshake, a link to /diagnose and a shell command. Every word of it was true
//   and every word of it was aimed at whoever maintains this repo — shown to a
//   person who had simply changed their mind about signing in.
//
//   Two fixes, in the order that matters:
//
//   1. A dismissal is not a failure. lib/auth-errors.js classifies the code and
//      lib/privy-dom.js supplies the evidence (provider mount counts, iframe
//      count), because Privy reports "you closed it" and "it broke" with the same
//      string. This toast only renders what it is given; it does not decide.
//   2. Two layers of copy. `err.user` is the sentence for the person using the
//      app — plain language, at most one action, never blaming them. `err.dev` is
//      the old technical text, unchanged and still reachable behind "Technical
//      details". Nothing was deleted to make the app friendlier; it was moved
//      behind a disclosure, because the person who needs it is a maintainer and
//      they know to look.
//
//   The visual tone follows the classification for the same reason: colour is the
//   first thing read, and a red border on a deliberate cancel teaches people that
//   red here means nothing.
// ---------------------------------------------------------------------------
const TOAST_TONE = {
  neutral: { ring: "border-line bg-panel", icon: Info, tile: "neutral", text: "text-text" },
  warn:    { ring: "border-warn/45 bg-warn-dim", icon: AlertTriangle, tile: "warn", text: "text-warn" },
  bad:     { ring: "border-bad/45 bg-bad-dim", icon: AlertTriangle, tile: "bad", text: "text-bad" },
};

function AuthErrorToast({ session }) {
  const err = session.authError;
  const [showDev, setShowDev] = useState(false);

  // clearAuthError is an inline arrow in the session memo, so its identity changes
  // on every recompute — and this navbar re-renders on the 6-second app-data poll.
  // Depending on it directly would restart the auto-dismiss timer on every poll and
  // the toast would never leave. Holding it in a ref lets the effect depend on the
  // error alone, which is the only thing that should restart the clock.
  const dismissRef = useRef(session.clearAuthError);
  dismissRef.current = session.clearAuthError;

  // LOG LEVEL COMES FROM THE CLASSIFIER, AND ALWAYS HAS.
  // Still an effect keyed on the error object rather than the render body, because
  // the 6-second poll would otherwise reprint one failure four or five times with
  // an identical timestamp — and a repeated identical log reads as a repeating
  // failure. What is new: a dismissal logs at info, not error. Filing "someone
  // clicked the X" under console.error is why a cancel looked like a crash.
  useEffect(() => {
    if (!err) return;
    const line = `[AgentFloat] sign-in: ${err.code}`;
    if (err.log === "info") console.info(line, err);
    else console.error(line, err);
  }, [err]);

  // Auto-dismiss only when the classifier asked for it. Genuine failures leave
  // autoDismissMs unset on purpose: those should still be on screen when the
  // person comes back from dealing with them.
  useEffect(() => {
    if (!err || !err.autoDismissMs) return undefined;
    const t = setTimeout(() => dismissRef.current(), err.autoDismissMs);
    return () => clearTimeout(t);
  }, [err]);

  // A new failure starts with its details closed — the previous one's explanation
  // is never the next one's, and leaving it open reads as carried-over blame.
  useEffect(() => { setShowDev(false); }, [err]);

  // Every hook is above this. A hook below an early return changes the hook count
  // between renders, which is a hard React error rather than a visual one.
  if (!err) return null;

  const tone = TOAST_TONE[err.tone] || TOAST_TONE.bad;
  const isNetwork = err.kind === "network";
  const Heading = tone.icon;
  const hasDev = Boolean(err.dev || err.code || err.detail);

  return (
    <div
      role={err.tone === "neutral" ? "status" : "alert"}
      aria-live={err.tone === "neutral" ? "polite" : "assertive"}
      className={`animate-rise fixed right-4 bottom-4 z-[9998] max-w-[440px] rounded-xl border p-4 shadow-2xl ${tone.ring}`}
      style={{ backdropFilter: "blur(6px)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className={`flex items-center gap-2.5 text-[14.5px] font-semibold ${tone.text}`}>
          <IconTile as={Heading} tone={tone.tile} size={16} />
          {err.title || "Sign-in didn't complete"}
        </div>
        <button
          onClick={() => dismissRef.current()}
          className="cursor-pointer rounded p-1 text-dim transition-colors hover:text-text"
          aria-label="Dismiss this message"
        >
          <Icon as={X} size={15} />
        </button>
      </div>

      {/* The sentence for the person using the app. Falls back to the raw code only
          if a caller ever sets an error without going through the classifier, which
          should not happen — but a blank message would read as "nothing went wrong". */}
      <div className="mt-2.5 text-[14px] leading-relaxed text-muted">
        {err.user || err.hint || err.code}
      </div>

      {/* A wrong-network rejection is the one outcome the person can fix from here,
          so the retry stays inline rather than making them find the navbar button
          that produced it. */}
      {isNetwork && (
        <Button
          size="sm"
          className="mt-3"
          onClick={() => { dismissRef.current(); session.fixNetwork().catch(() => {}); }}
          disabled={session.networkBusy}
          icon={session.networkBusy ? RefreshCw : Network}
        >
          {session.networkBusy ? "switching…" : "Try the switch again"}
        </Button>
      )}

      {/* MAINTAINER LAYER. Closed by default, one click away, and complete: the
          technical explanation, Privy's raw code, the DOM-probe evidence and the
          two commands. This is where /diagnose and `npm run check:client` belong —
          they are real tools, they are just not instructions for a person who was
          trying to sign in. */}
      {hasDev && (
        <div className="mt-3 border-t border-line-soft pt-2.5">
          <button
            onClick={() => setShowDev((v) => !v)}
            aria-expanded={showDev}
            className="flex cursor-pointer items-center gap-1.5 text-[12.5px] font-medium text-dim transition-colors hover:text-muted"
          >
            <Icon as={ChevronDown} size={13} className={`transition-transform ${showDev ? "rotate-180" : ""}`} />
            Technical details
          </button>

          {showDev && (
            <div className="mt-2.5 space-y-2 text-[12.5px] leading-relaxed text-dim">
              {/* Unparaphrased, because these are the strings to search for or paste
                  into a support ticket. */}
              <div className="font-mono text-muted">code: {err.code || "(Privy gave no code)"}</div>
              {err.dev && <div className="whitespace-pre-line">{err.dev}</div>}
              {err.detail && <div className="font-mono">{err.detail}</div>}
              {err.structuralReasons?.length > 0 && (
                <div>
                  DOM probe found:{" "}
                  <span className="font-mono text-warn">{err.structuralReasons.join("; ")}</span>
                </div>
              )}
              <div className="border-t border-line-soft pt-2">
                Provider mount counts and iframe state are on{" "}
                <Link
                  to="/diagnose"
                  className="inline-flex items-center gap-1 font-mono text-muted underline decoration-dotted underline-offset-2 hover:text-text"
                >
                  /diagnose
                </Link>
                ; <span className="font-mono text-muted">npm run check:client</span> finds a stale
                file or a drifted SDK version.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
