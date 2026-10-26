// ---------------------------------------------------------------------------
// auth-errors — what a failed sign-in SAYS, and whether it failed at all.
//
// THE BUG THIS EXISTS TO FIX
//   Privy reports `exited_auth_flow` for two completely different events:
//     (a) the person opened the sign-in window and closed it themselves, and
//     (b) the flow was torn down by something broken in the page.
//   The UI treated both as (b). So a visitor who clicked the X — or pressed
//   Escape, or simply changed their mind — was shown a red "Sign-in failed"
//   alert, an error logged to the console, and instructions about iframe
//   handshakes, status pages and a repo script. Closing a popup is not an
//   incident, and reporting it as one teaches people to ignore the real ones.
//
//   The codebase already held the right principle: the watchdog in PrivyLayer
//   says an abandoned flow means "nothing actually went wrong". onError
//   disagreed with it. This module is the tie-breaker.
//
// THE OTHER HALF
//   Every hint in the old table was written for whoever maintains this repo —
//   VITE_PRIVY_APP_ID, frontend/.env, `npm run check:privy`, loginMethods in
//   src/lib/privy.js, "the allowlist". None of that is actionable for the person
//   staring at the screen, and much of it reads as blame. So each outcome now
//   carries TWO strings:
//
//     user — plain language, no product jargon, at most one thing to do, and it
//            never blames the reader. This is what the toast shows.
//     dev  — the technical detail, unchanged in substance. This goes behind a
//            "technical details" disclosure, for support and for us.
//
//   Hiding the dev text is not hiding the truth: it stays one click away, and the
//   raw code is always rendered, because that is what belongs in a bug report.
//
// PURE AND OFFLINE. No imports, no import.meta, no DOM access at module scope —
// so scripts/test-auth-errors.mjs can assert every branch without a browser. The
// structural-fault and secure-context facts are passed IN as arguments rather
// than read here, which is precisely what makes this testable.
// ---------------------------------------------------------------------------

/** What kind of outcome this was. Drives tone, persistence and console level. */
export const AUTH_OUTCOME = Object.freeze({
  /** The person closed the sign-in window. Nothing happened; nothing is wrong. */
  cancelled: "cancelled",
  /** Worth trying again; may succeed with nobody changing anything. */
  retryable: "retryable",
  /** This page or browser cannot host a wallet until something environmental changes. */
  environment: "environment",
  /** Misconfiguration on the operator's side. The visitor can do nothing about it. */
  blocked: "blocked",
  /** A structural fault in the page itself (double-mounted provider, second iframe). */
  broken: "broken",
  /** The wallet is on another chain and the switch did not go through. */
  network: "network",
  unknown: "unknown",
});

const LOCAL_URL = "http://localhost:5173";

/**
 * Technical detail per code. Substantively the old PRIVY_ERROR_HINTS table, which
 * was always accurate — it was just being shown to the wrong audience.
 */
const DEV = {
  exited_auth_flow_cancelled:
    "Privy reports exited_auth_flow both for a deliberate dismissal and for a flow " +
    "torn down mid-handshake. Classified here as a dismissal because the DOM probe " +
    "found a healthy provider: 1 mount, 0 unmounts, 1 Privy iframe. If that probe " +
    "were ever wrong this would become a silent failure, which is why " +
    "privyStructuralFault() is asserted by test-auth-errors.mjs rather than trusted.",
  exited_auth_flow_broken:
    "exited_auth_flow WITH a structural fault: the provider mounted more than once, " +
    "unmounted, or built a second iframe. Each mount owns an id-keyed cross-window " +
    "event queue, so a remount leaves the survivor waiting on an event the first " +
    "instance already consumed. Causes: <React.StrictMode> wrapping the app, or " +
    "createRoot() running twice on the same container. `npm run check:client` greps " +
    "src/main.jsx for both, and /diagnose shows the live counts.",
  invalid_origin:
    "This origin is not in the Privy dashboard's allowed_domains. Open " + LOCAL_URL +
    "/ exactly — a LAN IP such as http://192.168.1.x:5173 is a different origin, is " +
    "not allowlisted, and is not a secure context either. App settings → Domains " +
    "lists what is currently allowed. On a deployment, add the production domain " +
    "there as well as setting VITE_GATEWAY_URL.",
  missing_or_invalid_privy_app_id:
    "VITE_PRIVY_APP_ID is wrong or absent, or the origin is not allowlisted. Re-check " +
    "the App ID in frontend/.env, then restart the dev server — Vite reads .env only " +
    "at startup. `npm run check:privy` verifies the ID against Privy directly.",
  disallowed_login_method:
    "That login method is switched off in the dashboard while loginMethods in " +
    "src/lib/privy.js still requests it. Enable it under App settings → Login " +
    "methods, or remove it from loginMethods.",
  linked_to_another_user:
    "This identity is already tied to a different Privy user — usually an account " +
    "created with Google and now retried with passwordless email. Sign in with the " +
    "original method, or enable login-method transfer in the dashboard.",
  invalid_native_app_id:
    "A native (mobile) app identifier was sent from a web client. This app is " +
    "web-only; make sure no clientId/appClient override is configured.",
  failed_to_fetch_jwks_uri_document:
    "Privy could not reach a JWKS endpoint. Only relevant if custom JWT auth is " +
    "configured, which this app does not use — so treat it as transient.",
  wallet_proxy_not_initialized:
    "The embedded-wallet proxy never came up. Either the origin is not allowlisted, " +
    "or wallet work started before both readiness flags were true. This app waits " +
    "for usePrivy().ready AND useWallets().ready, so check the allowlist first. The " +
    "embedded wallet also needs WebCrypto, which browsers disable outside a secure " +
    "context.",
  insecure_context:
    "window.isSecureContext is false, so the browser has disabled WebCrypto " +
    "(crypto.randomUUID, crypto.subtle) and injected wallet APIs. Privy cannot " +
    "create an embedded wallet here at all. Serve over HTTPS, or open " + LOCAL_URL +
    "/ rather than a LAN IP.",
  unknown:
    "Privy reported a failure with no recognized code. Check https://status.privy.com " +
    "for an outage, then retry in an incognito window with extensions disabled — " +
    "wallet extensions inject scripts that can break the iframe handshake.",
  network:
    "The chain switch did not complete: ensureWalletChain() tried Privy's " +
    "switchChain for an embedded wallet, or EIP-3085 wallet_switchEthereumChain / " +
    "wallet_addEthereumChain for an injected one, and the provider refused or the " +
    "user declined. /diagnose reports the measured chainId.",
};

/**
 * Classify one sign-in outcome.
 *
 * @param codeOrMessage what Privy (or our own network code) reported
 * @param ctx.structuralFault true when the DOM probe found a double-mounted
 *                       provider or a second iframe. THIS is what separates a
 *                       deliberate dismissal from a broken flow, because Privy
 *                       uses one code for both.
 * @param ctx.secureContext  window.isSecureContext at the time of the failure
 * @returns {{ kind, tone, title, user, dev, code, log, autoDismissMs }}
 *
 * `log` is the console level to use: "info" for a cancellation, "error" for a real
 * failure. Logging someone's change of mind at error level trains everybody —
 * including whoever debugs this next — to skim past the console.
 */
export function classifyAuthError(codeOrMessage, ctx = {}) {
  const raw = String(codeOrMessage || "").trim();
  const code = raw || "unknown";
  const key = code.toLowerCase();
  const structuralFault = ctx.structuralFault === true;
  // Absent means "not measured", which must not be reported as an insecure
  // context: that would blame the reader's browser for a fact nobody checked.
  const secure = ctx.secureContext !== false;

  const find = (...needles) => needles.some((n) => key.includes(n));

  let kind, title, user, dev, tone;
  let log = "error";
  let autoDismissMs = 0;

  if (find("exited_auth_flow", "user_closed", "modal_closed", "closed_modal", "user_cancelled", "user_canceled")) {
    // ONE code, two meanings. The DOM probe decides which, and nothing else can.
    if (structuralFault) {
      kind = AUTH_OUTCOME.broken;
      tone = "bad";
      title = "Sign-in didn't complete";
      user =
        "Something on this page stopped the sign-in window from working. Please " +
        "reload the page and try once more. If it happens again, try a private " +
        "window — some browser add-ons interfere with sign-in popups.";
      dev = DEV.exited_auth_flow_broken;
    } else {
      kind = AUTH_OUTCOME.cancelled;
      tone = "neutral";
      title = "Sign-in closed";
      // The reassurance IS the content. Someone who cancels is left wondering
      // whether they just created an account, were charged, or broke something.
      user =
        "No problem — you closed the sign-in window, so nothing happened. No wallet " +
        "was created and nothing was charged. Choose Sign in again whenever you're " +
        "ready.";
      dev = DEV.exited_auth_flow_cancelled;
      log = "info";
      autoDismissMs = 7000;
    }
  } else if (find("invalid_origin")) {
    kind = AUTH_OUTCOME.blocked;
    tone = "warn";
    title = "This web address isn't approved for sign-in";
    user =
      "Sign-in isn't allowed from this address yet, so no wallet can be created " +
      "here. If you're running AgentFloat on your own computer, open " + LOCAL_URL +
      " exactly. Otherwise this needs a small settings change by whoever set the app " +
      "up — nothing is wrong with your browser.";
    dev = DEV.invalid_origin;
  } else if (find("missing_or_invalid_privy_app_id", "app_id")) {
    kind = AUTH_OUTCOME.blocked;
    tone = "warn";
    title = "Sign-in isn't set up on this site";
    user =
      "This copy of AgentFloat hasn't been connected to a sign-in service yet, so it " +
      "can't create a wallet for you. Whoever set the site up needs to add that " +
      "detail. Nothing is wrong with your browser or your account.";
    dev = DEV.missing_or_invalid_privy_app_id;
  } else if (find("disallowed_login_method")) {
    kind = AUTH_OUTCOME.blocked;
    tone = "warn";
    title = "That sign-in option is turned off";
    user =
      "That way of signing in has been switched off for this app. Please try Google " +
      "or email instead.";
    dev = DEV.disallowed_login_method;
  } else if (find("linked_to_another_user")) {
    kind = AUTH_OUTCOME.retryable;
    tone = "warn";
    title = "That account used a different sign-in option";
    user =
      "This account was first created with a different sign-in option. Please use the " +
      "same one you used originally — your wallet and its balance are still there, " +
      "they just sit behind that first login.";
    dev = DEV.linked_to_another_user;
  } else if (find("invalid_native_app_id")) {
    kind = AUTH_OUTCOME.blocked;
    tone = "warn";
    title = "Sign-in isn't configured correctly on this site";
    user =
      "This site sent the wrong kind of identifier while signing you in. Nothing is " +
      "wrong with your browser — please let whoever runs this app know.";
    dev = DEV.invalid_native_app_id;
  } else if (find("jwks")) {
    kind = AUTH_OUTCOME.retryable;
    tone = "warn";
    title = "The sign-in service couldn't be reached";
    user = "That looks temporary. Please wait a few seconds and try again.";
    dev = DEV.failed_to_fetch_jwks_uri_document;
  } else if (find("wallet proxy not initialized", "proxy not initialized", "wallet_proxy")) {
    kind = AUTH_OUTCOME.retryable;
    tone = "warn";
    title = "Your wallet couldn't be set up just now";
    user =
      "Please reload the page and try again. If you're running AgentFloat on your own " +
      "computer, make sure you opened " + LOCAL_URL + " — not a network address.";
    dev = DEV.wallet_proxy_not_initialized;
  } else if (find("network_", "switch_chain", "switchchain", "wrong_chain", "unsupported_chain")) {
    kind = AUTH_OUTCOME.network;
    tone = "warn";
    title = "Couldn't switch your wallet's network";
    user =
      "Your wallet is on a different network and the switch didn't go through. Please " +
      "try again — if your wallet app asked you to confirm the switch, approve it " +
      "there.";
    dev = DEV.network;
  } else {
    kind = AUTH_OUTCOME.unknown;
    tone = "bad";
    title = "Sign-in didn't complete";
    user =
      "Please try again in a moment. If it keeps happening, try a private window with " +
      "your browser add-ons turned off — some of them interfere with sign-in popups. " +
      "Your wallet and balance are unaffected either way.";
    dev = DEV.unknown;
  }

  // An insecure context defeats every wallet flow regardless of which code Privy
  // happened to report, so it REPLACES the classification rather than appending to
  // it: two explanations side by side invite the reader to act on the wrong one.
  // A cancellation is exempt — closing a popup on a LAN IP is still just closing a
  // popup, and escalating it to a red environmental error would revive the exact
  // false alarm this module exists to remove.
  if (!secure && kind !== AUTH_OUTCOME.cancelled) {
    kind = AUTH_OUTCOME.environment;
    tone = "bad";
    title = "This address can't create a wallet";
    user =
      "Browsers only allow wallet creation on a secure address, and this one isn't. " +
      "If you're running AgentFloat on your own computer, open " + LOCAL_URL +
      " exactly — not a network address like http://192.168.1.20:5173, and not a " +
      "plain-HTTP link.";
    dev = DEV.insecure_context + (dev ? `\n\nAlso reported: ${dev}` : "");
  }

  return { kind, tone, title, user, dev, code, log, autoDismissMs };
}

/**
 * The dev-layer sentence on its own, for callers that only want one string.
 *
 * Kept because `explainPrivyError` was already imported elsewhere; it now
 * delegates here so there is exactly one copy of this text in the repo. Reads
 * window.isSecureContext itself, since that is environmental and no caller has a
 * better answer.
 */
export function explainPrivyError(codeOrMessage, ctx = {}) {
  const secure =
    ctx.secureContext !== undefined
      ? ctx.secureContext
      : typeof window !== "undefined"
        ? Boolean(window.isSecureContext)
        : true;
  return classifyAuthError(codeOrMessage, { ...ctx, secureContext: secure }).dev;
}

/** True when this outcome is a person changing their mind, not a failure. */
export const isCancellation = (r) => r?.kind === AUTH_OUTCOME.cancelled;
