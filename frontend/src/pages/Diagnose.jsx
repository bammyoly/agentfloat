// ---------------------------------------------------------------------------
// /diagnose — read the live browser state that a terminal cannot see.
//
// WHY THIS PAGE EXISTS
//   "The Privy modal opens, loads, and disappears" has several causes that are
//   indistinguishable from each other in the source and in the console, but
//   trivially distinguishable in the DOM:
//
//     - PrivyProvider mounted more than once (React.StrictMode, or a second
//       createRoot). The remount strands the iframe's id-keyed event queue:
//         cannot dequeue privy:iframe:ready event: no event found for id id-N
//     - the page is not a secure context, so WebCrypto is disabled and Privy
//       cannot initialize the embedded-wallet proxy at all
//     - the origin is not in the dashboard's allowed domains
//     - the provider initialized but never created its iframe
//
//   None of those are visible from a terminal, and `npm run check:privy` cannot
//   see them either — it queries Privy's servers, not this browser. So this page
//   probes the DOM and the session, states a verdict, and produces a plain-text
//   report to paste back.
//
//   Public route: it must be reachable when sign-in is broken, which is the only
//   time it is interesting.
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge, Stethoscope } from "lucide-react";

import { Badge, Button, Card, Dot, Note, PageHeader } from "../components/ui.jsx";
import { useSession } from "../lib/session.jsx";
import { PRIVY_APP_ID, IS_PRIVY_CONFIGURED } from "../lib/privy.js";
import { scanDom, privyStructuralFault } from "../lib/privy-dom.js";

// The origins `npm run check:privy` last confirmed are in the dashboard's
// allowed_domains. Compared against window.location.origin below.
const KNOWN_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

// isPrivyish() and scanDom() live in lib/privy-dom.js, shared with PrivyLayer:
// the same measurements decide whether `exited_auth_flow` means "you closed it" or
// "the provider broke", so they must not exist twice.

/** Turn the probes into statements about what is wrong, most specific first. */
/**
 * Installed vs pinned SDK versions, injected by vite.config.js.
 *
 * `typeof` guard because the identifier only exists once Vite has replaced it; a
 * plain reference would throw in any context that does not run through the config
 * (a test import, for instance).
 */
const SDKS = typeof __AGENTFLOAT_SDKS__ !== "undefined" ? __AGENTFLOAT_SDKS__ : {};

/**
 * Every dependency whose installed version differs from what package.json pins,
 * or whose pin is loose enough to drift again on the next reinstall.
 */
function sdkDrift() {
  return Object.entries(SDKS)
    .map(([name, v]) => ({ name, ...v }))
    .filter((v) =>
      !v.installed ||
      (v.declared && v.declared !== v.installed) ||
      /^[\^~]/.test(v.declared || "")
    );
}

function buildFindings(dom, session, origin, secure) {
  const f = [];

  // BEFORE the `if (!dom) return f` guard, and before every DOM probe: a wrong
  // dependency version explains a broken login modal on its own, and no amount of
  // DOM inspection can see it. Reporting it last would mean the page's headline
  // finding is "no structural problem in this browser" — true, and misleading.
  for (const v of sdkDrift()) {
    f.push({
      tone: "bad",
      title: v.installed
        ? `${v.name}: installed ${v.installed}, package.json pins ${v.declared}`
        : `${v.name}@${v.declared || "?"} is not installed`,
      body: v.installed
        ? "The auth SDK on disk is not the one this app was written and verified " +
          "against. This is a known cause of a login modal that opens, spins, " +
          "closes itself and reports `exited_auth_flow` — and it is invisible to " +
          "every source-level check, because no source changed. Fix: " +
          "`npm --prefix frontend install " + v.name + "@" + v.declared + " --save-exact`, " +
          "then delete frontend\\node_modules\\.vite and restart the dev server."
        : "Run `npm --prefix frontend install`. A missing auth SDK cannot produce a " +
          "working login modal.",
    });
  }
  if (sdkDrift().some((v) => /^[\^~]/.test(v.declared || ""))) {
    f.push({
      tone: "warn",
      title: "An auth-critical dependency is pinned loosely",
      body:
        "A ^ or ~ in package.json means the next reinstall can move the SDK without " +
        "anyone editing a file — which is how 3.50.0 became 3.51.0. Pin it exactly; " +
        "`npm run check:client` fails on a loose spec so it cannot creep back.",
    });
  }

  if (!dom) return f;

  // ONE verdict from the shared probe, not a second copy of its thresholds.
  // These two blocks used to re-derive "is the provider double-mounted" from
  // dom.bridgeMounts / bridgeUnmounts / privyIframes directly — the same
  // comparisons privyStructuralFault() makes, and the same ones that decide whether
  // the sign-in toast says "you closed it" or "something is broken". Two copies of a
  // threshold is how this page ends up reporting a healthy browser while the toast
  // reports a broken one. Passing `dom` in keeps the verdict consistent with the
  // counts printed beside it.
  const fault = privyStructuralFault(dom);
  if (fault.fault) {
    f.push({
      tone: "bad",
      title: "The wallet provider cannot complete a sign-in from this state",
      body:
        fault.reasons.join("; ") + ". " +
        "This is what makes a login modal open, load, then vanish — and what makes " +
        "`exited_auth_flow` get reported when nobody closed anything. Each mount " +
        "builds an iframe and an id-keyed event queue; when one instance is torn " +
        "down mid-handshake the survivor waits on an event that was already " +
        "consumed. Healthy is exactly 1 mount, 0 unmounts, 1 Privy iframe and 1 " +
        "React root. Two causes: <React.StrictMode> wrapping the app, or " +
        "createRoot() running twice on the same container. Run `npm run " +
        "check:client` — it greps src/main.jsx for both.",
    });
  }
  if (dom.reactRoots > 1) {
    f.push({
      tone: "bad",
      title: `${dom.reactRoots} React roots (${dom.reactRootIds.join(", ")})`,
      body:
        "createRoot() has been called on more than one element. The entry module " +
        "was re-imported, which is what Fast Refresh does when it bails out on a " +
        "module mixing components with other exports.",
    });
  }
  if (!secure) {
    f.push({
      tone: "bad",
      title: "This page is NOT a secure context",
      body:
        "The browser disables WebCrypto here, so Privy cannot initialize the " +
        "embedded-wallet proxy and cannot create a wallet at all. localhost and " +
        "127.0.0.1 are treated as secure; a LAN IP over plain HTTP is not. Open " +
        "http://localhost:5173/ instead.",
    });
  }
  if (!KNOWN_ALLOWED_ORIGINS.includes(origin)) {
    f.push({
      tone: "bad",
      title: `Origin ${origin} is not in the dashboard's allowed domains`,
      body:
        "Privy answers with invalid_origin and the iframe handshake fails. The " +
        "confirmed allowlist is: " + KNOWN_ALLOWED_ORIGINS.join(", ") + ". Re-verify " +
        "with `npm run check:privy`.",
    });
  }
  if (IS_PRIVY_CONFIGURED && session.ready && dom.privyIframes === 0) {
    f.push({
      tone: "warn",
      title: "Provider reports ready but no Privy iframe exists",
      body:
        "Initialization completed without producing the embedded-wallet iframe. " +
        "Usually an extension blocking the frame, or third-party cookies/site data " +
        "blocked for auth.privy.io. Retry in an incognito window with extensions off.",
    });
  }
  if (IS_PRIVY_CONFIGURED && !session.ready) {
    f.push({
      tone: "warn",
      title: "Session never became ready",
      body:
        "usePrivy().ready and useWallets().ready must both be true. If this stays " +
        "false the provider is stuck initializing — check the console for a Privy " +
        "error and confirm the App ID with `npm run check:privy`.",
    });
  }
  if (!IS_PRIVY_CONFIGURED) {
    f.push({
      tone: "warn",
      title: "No VITE_PRIVY_APP_ID — the app is in operator-wallet mode",
      body:
        "The navbar shows a badge instead of a Sign in button, and no modal can " +
        "open. Set it in frontend/.env and restart the dev server; Vite reads .env " +
        "only at startup.",
    });
  }
  if (session.authError) {
    f.push({
      tone: "bad",
      title: `Privy reported: ${session.authError.code}`,
      body: session.authError.hint || "(no hint available)",
    });
  }
  if (!f.length) {
    f.push({
      tone: "ok",
      title: "No structural problem detected in this browser",
      body:
        "One provider, one iframe, secure context, allowlisted origin, and every " +
        "auth-critical dependency at its pinned version. If sign-in still fails the " +
        "cause is server-side or extension-side: check https://status.privy.com for " +
        "an outage, then retry in incognito with extensions disabled.",
    });
  }
  return f;
}

export default function Diagnose() {
  const session = useSession() || {};
  const [dom, setDom] = useState(() => scanDom());
  const [copied, setCopied] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "(ssr)";
  const secure = typeof window !== "undefined" ? Boolean(window.isSecureContext) : false;

  // Re-scan while the page is open. The interesting transition happens when the
  // user clicks Sign in and the modal opens and closes, and the iframe count and
  // mount counters only change at that moment.
  useEffect(() => {
    const t = setInterval(() => setDom(scanDom()), 700);
    return () => clearInterval(t);
  }, []);

  const findings = useMemo(() => buildFindings(dom, session, origin, secure), [dom, session, origin, secure]);

  const report = useMemo(() => {
    const line = (k, v) => `${k.padEnd(26)} ${v}`;
    const out = ["AgentFloat /diagnose report", "=".repeat(46), "", "-- environment --"];
    out.push(line("origin", origin));
    out.push(line("secure context", secure));
    out.push(line("href", typeof window !== "undefined" ? window.location.href : ""));
    out.push(line("user agent", typeof navigator !== "undefined" ? navigator.userAgent : ""));
    out.push("", "-- privy --");
    out.push(line("app id", PRIVY_APP_ID ? `${PRIVY_APP_ID.slice(0, 12)}…` : "(not set)"));
    out.push(line("configured", IS_PRIVY_CONFIGURED));
    out.push(line("session.ready", session.ready));
    out.push(line("authenticated", Boolean(session.user)));
    out.push(line("agent address", session.agentAddress || "(none)"));
    out.push(line("canSignX402", session.canSignX402));
    // "Copy report" exists to be pasted into a bug report, so it carries the DEV
    // layer. `hint` now holds the friendly sentence the toast shows, which is the
    // right thing for a user and the wrong thing for whoever has to fix it.
    if (session.authError) {
      const e = session.authError;
      out.push(line("authError.code", e.code || "(none)"));
      out.push(line("authError.kind", e.kind || "(unclassified — stale copy?)"));
      out.push(line("authError.user", e.user || e.hint || ""));
      out.push(line("authError.dev", e.dev || ""));
      if (e.structuralReasons && e.structuralReasons.length) {
        out.push(line("authError.domProbe", e.structuralReasons.join("; ")));
      }
    } else {
      out.push(line("authError", "(none)"));
    }
    out.push("", "-- dom --");
    if (dom) {
      out.push(line("provider mounts", dom.bridgeMounts));
      out.push(line("provider unmounts", dom.bridgeUnmounts));
      out.push(line("react roots", `${dom.reactRoots} (${dom.reactRootIds.join(", ")})`));
      out.push(line("iframes total", dom.iframes));
      out.push(line("privy iframes", dom.privyIframes));
      out.push(line("privy iframe srcs", dom.privyIframeSrcs.join(" | ") || "(none)"));
      out.push(line("dialogs total", dom.dialogs));
      out.push(line("privy dialogs", dom.privyDialogs));
    }
    out.push("", "-- findings --");
    findings.forEach((f, i) => out.push(`${i + 1}. [${f.tone}] ${f.title}`));
    return out.join("\n");
  }, [dom, session, findings, origin, secure]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API needs a secure context and a user gesture; fall back to
      // selecting the textarea so a manual copy still works.
      const ta = document.getElementById("diagnose-report");
      if (ta) { ta.focus(); ta.select(); }
    }
  }, [report]);

  return (
    <div className="animate-fade mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <PageHeader
        icon={Stethoscope}
        eyebrow="diagnostics"
        title="Sign-in diagnostics"
        sub="Live probes of this browser: how many times the wallet provider mounted, whether its iframe exists, and whether this origin can host it at all."
        aside={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setDom(scanDom())}>Re-scan</Button>
            <Button size="sm" variant="primary" onClick={copy}>{copied ? "Copied ✓" : "Copy report"}</Button>
          </div>
        }
      />

      <div className="mt-6 space-y-3">
        {findings.map((f, i) => (
          <div
            key={i}
            className={`border p-4 ${
              f.tone === "bad" ? "border-bad/40 bg-bad-dim" : f.tone === "warn" ? "border-warn/35 bg-warn-dim" : "border-ok/30 bg-ok-dim"
            }`}
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-1.5">
                <Dot tone={f.tone === "ok" ? "ok" : f.tone === "warn" ? "warn" : "bad"} pulse={f.tone === "bad"} />
              </span>
              <div>
                <div className={`text-[13.5px] font-semibold ${f.tone === "bad" ? "text-bad" : f.tone === "warn" ? "text-warn" : "text-ok"}`}>
                  {f.title}
                </div>
                <div className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{f.body}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card title="Provider lifecycle">
          <Row k="mounts" v={dom?.bridgeMounts ?? "—"} bad={(dom?.bridgeMounts ?? 0) > 1} />
          <Row k="unmounts" v={dom?.bridgeUnmounts ?? "—"} bad={(dom?.bridgeUnmounts ?? 0) > 0} />
          <Row k="React roots" v={dom?.reactRoots ?? "—"} bad={(dom?.reactRoots ?? 0) > 1} />
          <div className="mt-3 text-[13.5px] leading-relaxed text-dim">
            Healthy is <span className="font-mono text-muted">1 / 0 / 1</span>. StrictMode in dev
            produces <span className="font-mono text-muted">2 / 1</span>; a re-imported entry
            produces two React roots.
          </div>
        </Card>

        <Card title="Privy in the DOM">
          <Row k="Privy iframes" v={dom?.privyIframes ?? "—"} bad={(dom?.privyIframes ?? 0) > 1} />
          <Row k="iframes total" v={dom?.iframes ?? "—"} />
          <Row k="dialogs total" v={dom?.dialogs ?? "—"} />
          <Row k="Privy dialogs" v={dom?.privyDialogs ?? "—"} />
          <div className="mt-2 truncate font-mono text-[12.5px] text-dim" title={dom?.privyIframeSrcs?.join(" | ")}>
            {dom?.privyIframeSrcs?.join(" | ") || "(no privy iframe src)"}
          </div>
        </Card>

        <Card title="Environment">
          <Row k="origin" v={origin} bad={!KNOWN_ALLOWED_ORIGINS.includes(origin)} />
          <Row k="secure context" v={String(secure)} bad={!secure} />
          <Row k="App ID set" v={String(IS_PRIVY_CONFIGURED)} bad={!IS_PRIVY_CONFIGURED} />
          <Row k="session.ready" v={String(Boolean(session.ready))} bad={IS_PRIVY_CONFIGURED && !session.ready} />
        </Card>

        <Card title="Installed SDK versions" icon={Gauge}>
          {/* Read from node_modules at config time, not from package.json: this is
              the version actually running, which is the only one that matters. */}
          {Object.entries(SDKS).length === 0 ? (
            <Row k="versions" v="unavailable — served without the Vite config" bad />
          ) : (
            Object.entries(SDKS).map(([name, v]) => {
              const loose = /^[\^~]/.test(v.declared || "");
              const mismatch = Boolean(v.declared && v.installed && v.declared !== v.installed);
              return (
                <Row
                  key={name}
                  k={name}
                  v={!v.installed
                    ? "not installed"
                    : mismatch
                      ? `${v.installed}  (pinned ${v.declared})`
                      : loose
                        ? `${v.installed}  (loose spec ${v.declared})`
                        : v.installed}
                  bad={!v.installed || mismatch || loose}
                />
              );
            })
          )}
        </Card>

        <Card title="Session">
          <Row k="authenticated" v={String(Boolean(session.user))} />
          <Row k="agent address" v={session.agentAddress ? `${session.agentAddress.slice(0, 10)}…` : "(none)"} />
          <Row k="can sign x402" v={String(Boolean(session.canSignX402))} />
          <Row k="operator" v={String(Boolean(session.isOperator))} />
          <Row k="auth error" v={session.authError?.code || "(none)"} bad={Boolean(session.authError)} />
        </Card>
      </div>

      <Note tone="" className="mt-6">
        <strong>How to use this page.</strong> Leave it open, click <em>Sign in</em> in the navbar,
        and watch <span className="font-mono">Provider lifecycle</span>. If <em>mounts</em> climbs
        past 1 or <em>unmounts</em> becomes non-zero while the modal is open, the provider is being
        remounted — that is the whole bug, and it lives in{" "}
        <span className="font-mono">src/main.jsx</span>, not in Privy.
      </Note>

      <div className="mt-6">
        <div className="mb-2 text-[12.5px] uppercase tracking-[0.14em] text-dim">raw report</div>
        <textarea
          id="diagnose-report"
          readOnly
          value={report}
          rows={16}
          className="w-full resize-y border border-line-soft bg-panel p-3 font-mono text-[12.5px] leading-relaxed text-muted outline-none focus:border-btc/50"
        />
      </div>
    </div>
  );
}

function Row({ k, v, bad }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-soft/60 py-1.5 last:border-0">
      <span className="text-[13.5px] text-dim">{k}</span>
      <span className={`truncate font-mono text-[13.5px] ${bad ? "text-bad" : "text-text"}`} title={String(v)}>
        {String(v)}
        {bad && <Badge tone="bad">check</Badge>}
      </span>
    </div>
  );
}
