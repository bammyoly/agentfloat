// ---------------------------------------------------------------------------
// test-auth-errors — the words a failed sign-in shows, and whether it failed.
//
//   npm run test:auth        (from the repo root)
//
// WHY COPY GETS A TEST SUITE
//   Because this particular copy was wrong in a way no unit test of logic would
//   have caught, and it was wrong in production. Closing the Privy popup produced
//   a red "Sign-in failed" alert, a console.error, Privy's raw code, and a
//   paragraph about iframe handshakes, status pages and `npm run check:client`.
//   Every sentence was factually true. All of it was addressed to whoever
//   maintains this repo, and all of it was shown to someone who had clicked the X.
//
//   Prose is not exempt from correctness just because it is prose. These are the
//   invariants that were violated, asserted so they cannot be violated again by a
//   well-meaning edit that adds one helpful technical sentence to a `user` string:
//
//     1. A dismissal is NOT a failure — neutral tone, info log, auto-dismisses.
//     2. A dismissal is only a dismissal when the DOM probe says the provider is
//        healthy; with a structural fault the same code must escalate.
//     3. No developer vocabulary ever reaches `title` or `user`, for ANY code.
//     4. The developer vocabulary was MOVED, not deleted — it is all still in
//        `dev`, which the toast renders behind a disclosure.
//     5. Every tone the classifier can emit is one the toast knows how to render.
//        An unmapped tone silently falls back to the red styling, which would
//        reintroduce bug (1) with no failing test anywhere else.
//     6. Real failures never auto-dismiss. Information that vanishes on a timer is
//        information the person did not get to read.
//
// (5) reads Navbar.jsx from disk rather than duplicating its key list, because a
// duplicated list is precisely how the two drift.
//
// Offline. No browser, no chain, no network, no .env — auth-errors.js is pure and
// privy-dom.js touches the DOM only inside its functions.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AUTH_OUTCOME, classifyAuthError, explainPrivyError, isCancellation,
} from "../src/lib/auth-errors.js";
import { scanDom, privyStructuralFault, isPrivyish } from "../src/lib/privy-dom.js";

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const ok = (name, extra = "") => {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? ` \x1b[90m${extra}\x1b[0m` : ""}`);
};
const bad = (name, extra = "") => {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? `\n      ${extra}` : ""}`);
};
const eq = (name, got, want) =>
  got === want ? ok(name, `= ${JSON.stringify(got)}`) : bad(name, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const truthy = (name, cond, extra = "") => (cond ? ok(name, extra) : bad(name, extra || "expected true"));
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Every code the classifier claims to recognise, plus one it must not. */
const KNOWN_CODES = [
  "exited_auth_flow",
  "user_closed",
  "modal_closed",
  "closed_modal",
  "user_cancelled",
  "user_canceled",
  "invalid_origin",
  "missing_or_invalid_privy_app_id",
  "app_id",
  "disallowed_login_method",
  "linked_to_another_user",
  "invalid_native_app_id",
  "failed_to_fetch_jwks_uri_document",
  "wallet proxy not initialized",
  "wallet_proxy",
  "network_switch_chain_failed",
  "wrong_chain",
  "unsupported_chain",
];
const UNKNOWN_CODE = "something_nobody_has_ever_seen";

/** Dismissal spellings Privy and our own layers have used. */
const CANCELLATIONS = KNOWN_CODES.slice(0, 6);

const HEALTHY = { structuralFault: false, secureContext: true };

/**
 * Vocabulary that belongs to a maintainer, never to the person using the app.
 *
 * Each entry was in the OLD user-visible text. This is the regression list: the
 * test fails the moment one of them is put back into a `title` or `user` string,
 * which is the exact edit that caused the complaint.
 */
const DEV_ONLY_VOCABULARY = [
  "npm run", "npm i", "npm --prefix",
  "VITE_", ".env", "frontend/", "src/lib", "src/main",
  "check:privy", "check:client", "check:deps",
  "status.privy.com", "loginMethods", "allowlist", "allowlisted", "allowed_domains",
  "App settings", "dashboard", "iframe", "handshake", "incognito", "extensions",
  "WebCrypto", "StrictMode", "createRoot", "React.", "console.", "/diagnose",
  "Privy", "provider", "JWKS", "clientId", "EIP-", "repo",
];

// ---------------------------------------------------------------------------
section("1 · a deliberate close is not a failure");
// ---------------------------------------------------------------------------
{
  const r = classifyAuthError("exited_auth_flow", HEALTHY);

  eq("kind is cancelled", r.kind, AUTH_OUTCOME.cancelled);
  eq("tone is neutral, not bad", r.tone, "neutral");
  eq("console level is info, not error", r.log, "info");
  eq("it clears itself", r.autoDismissMs, 7000);
  eq("the heading does not say 'failed'", r.title, "Sign-in closed");
  truthy("isCancellation() agrees", isCancellation(r));

  // The reassurance is the substance. Someone who cancels is left wondering
  // whether they just created an account, were charged, or broke something.
  truthy("it says nothing happened", /nothing happened/i.test(r.user), r.user.slice(0, 60));
  truthy("it rules out a wallet being created", /no wallet/i.test(r.user));
  truthy("it rules out a charge", /nothing was charged/i.test(r.user));
  truthy("it offers exactly one next step", /sign in again/i.test(r.user));
  truthy("it opens without alarm", /^no problem/i.test(r.user), r.user.slice(0, 24));

  // Every other spelling of "the person gave up" must land in the same place, or
  // the behaviour depends on whichPrivy version happened to emit which string.
  for (const code of CANCELLATIONS) {
    eq(`"${code}" is also a dismissal`, classifyAuthError(code, HEALTHY).kind, AUTH_OUTCOME.cancelled);
  }
}

// ---------------------------------------------------------------------------
section("2 · the same code escalates when the DOM probe finds a fault");
// ---------------------------------------------------------------------------
{
  const broken = classifyAuthError("exited_auth_flow", { structuralFault: true, secureContext: true });

  eq("kind becomes broken", broken.kind, AUTH_OUTCOME.broken);
  eq("tone becomes bad", broken.tone, "bad");
  eq("console level becomes error", broken.log, "error");
  eq("it does NOT auto-dismiss", broken.autoDismissMs, 0);
  truthy("isCancellation() now says no", !isCancellation(broken));
  truthy("the user is told to reload", /reload/i.test(broken.user));

  // THE WHOLE POINT OF PASSING structuralFault IN RATHER THAN READING THE DOM
  // HERE: one code string, two opposite outcomes, decided by evidence. If these
  // two classifications were identical, the module would be decoration.
  truthy(
    "the fault verdict actually changes the outcome",
    classifyAuthError("exited_auth_flow", HEALTHY).kind !== broken.kind
  );

  // A cancellation code is the ONLY one the probe can rescue. Every other code is
  // a real failure whether or not the DOM is healthy, so structuralFault must not
  // silently turn, say, invalid_origin into a dismissal.
  for (const code of KNOWN_CODES.slice(6)) {
    const withFault = classifyAuthError(code, { structuralFault: true, secureContext: true });
    truthy(`"${code}" stays a failure with a fault`, !isCancellation(withFault));
    const withoutFault = classifyAuthError(code, HEALTHY);
    eq(`"${code}" is unaffected by a healthy probe`, withFault.kind, withoutFault.kind);
  }
}

// ---------------------------------------------------------------------------
section("3 · no developer vocabulary reaches the person using the app");
// ---------------------------------------------------------------------------
{
  const all = [...KNOWN_CODES, UNKNOWN_CODE];
  const offenders = [];

  for (const code of all) {
    for (const secureContext of [true, false]) {
      const r = classifyAuthError(code, { structuralFault: false, secureContext });
      // title and user are the ONLY two strings the toast shows outside a
      // disclosure. Everything else is maintainer-facing by design.
      const surface = `${r.title}\n${r.user}`;
      for (const word of DEV_ONLY_VOCABULARY) {
        if (surface.toLowerCase().includes(word.toLowerCase())) {
          offenders.push(`${code} (secure=${secureContext}) → "${word}"`);
        }
      }
    }
  }
  eq(
    "zero developer terms across every code, secure or not",
    offenders.length, 0
  );
  if (offenders.length) console.log(`      ${offenders.slice(0, 8).join("\n      ")}`);

  // Blame is its own category. These phrasings put the failure on the reader.
  for (const code of all) {
    const surface = `${classifyAuthError(code, HEALTHY).title} ${classifyAuthError(code, HEALTHY).user}`.toLowerCase();
    truthy(`"${code}" does not blame the reader`, !/(you failed|your fault|you broke|invalid input|incorrect)/.test(surface));
  }

  // The raw code is rendered separately, in the disclosure, unparaphrased. It must
  // not also be woven into the sentence — that is what made the old copy read like
  // a stack trace.
  for (const code of all.filter((c) => c.includes("_") || c.includes(" "))) {
    truthy(`"${code}" is not echoed into the user sentence`, !classifyAuthError(code, HEALTHY).user.includes(code));
  }

  // "Sign-in failed" is the exact heading that was complained about.
  for (const code of all) {
    truthy(`"${code}" never headlines "Sign-in failed"`, classifyAuthError(code, HEALTHY).title !== "Sign-in failed");
  }
}

// ---------------------------------------------------------------------------
section("4 · the technical detail was moved behind a disclosure, not deleted");
// ---------------------------------------------------------------------------
{
  // Every dev string the module can produce, not just the ones a healthy page
  // yields. `npm run check:client` and the StrictMode note exist ONLY in the
  // structural-fault branch, so sampling one branch would report them as deleted
  // when they are merely unreachable from that branch.
  const allDev = [...KNOWN_CODES, UNKNOWN_CODE]
    .flatMap((c) =>
      [false, true].flatMap((structuralFault) =>
        [true, false].map((secureContext) =>
          classifyAuthError(c, { structuralFault, secureContext }).dev
        )
      )
    )
    .join("\n");

  // Each of these was in the OLD user-visible hint text. If the rewrite had simply
  // dropped them, a maintainer would lose the diagnosis that took hours to build.
  for (const marker of [
    "VITE_PRIVY_APP_ID", "npm run check:privy", "npm run check:client",
    "status.privy.com", "loginMethods", "allowed_domains", "App settings",
    "iframe", "incognito", "WebCrypto", "StrictMode", "/diagnose",
  ]) {
    truthy(`dev layer still carries "${marker}"`, allDev.includes(marker));
  }

  // Every outcome must HAVE a dev layer, or the disclosure renders empty and the
  // information is unreachable — which fails the "not deleted" requirement as
  // surely as deleting it would.
  for (const code of [...KNOWN_CODES, UNKNOWN_CODE]) {
    const r = classifyAuthError(code, HEALTHY);
    truthy(`"${code}" has a dev explanation`, typeof r.dev === "string" && r.dev.length > 40, `${r.dev?.length ?? 0} chars`);
  }

  // explainPrivyError is the old single-string API. It must still work, and still
  // return the DEV layer — callers that show it are maintainer surfaces.
  eq("explainPrivyError returns the dev layer", explainPrivyError("invalid_origin", { secureContext: true }), classifyAuthError("invalid_origin", HEALTHY).dev);
}

// ---------------------------------------------------------------------------
section("5 · every tone the classifier emits is one the toast can render");
// ---------------------------------------------------------------------------
{
  // Read the real map out of Navbar.jsx. Duplicating the key list here would let
  // the two drift, and an unmapped tone falls back to the RED styling — quietly
  // reintroducing the bug this whole module exists to remove.
  const navbar = readFileSync(join(HERE, "../src/components/Navbar.jsx"), "utf8");
  const block = navbar.slice(navbar.indexOf("const TOAST_TONE = {"));
  const body = block.slice(0, block.indexOf("\n};"));
  const tones = [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);

  truthy("found the toast's tone map", tones.length >= 3, tones.join(", "));

  const emitted = new Set();
  for (const code of [...KNOWN_CODES, UNKNOWN_CODE]) {
    for (const structuralFault of [false, true]) {
      for (const secureContext of [true, false]) {
        emitted.add(classifyAuthError(code, { structuralFault, secureContext }).tone);
      }
    }
  }
  for (const tone of emitted) {
    truthy(`the toast can render tone "${tone}"`, tones.includes(tone));
  }

  // The toast must also have somewhere to put a neutral one. If TOAST_TONE only
  // had warn/bad, a cancellation would render as an alert again.
  truthy("the toast has a neutral (non-alarming) style", tones.includes("neutral"));
  truthy("…and it is what a cancellation gets", classifyAuthError("exited_auth_flow", HEALTHY).tone === "neutral");
}

// ---------------------------------------------------------------------------
section("6 · the shape the toast reads, and the timer rules");
// ---------------------------------------------------------------------------
{
  // Navbar reads all eight. A missing one renders the string "undefined" on
  // screen, which is a worse user-facing bug than the one being fixed.
  const REQUIRED = ["kind", "tone", "title", "user", "dev", "code", "log", "autoDismissMs"];
  for (const code of [...KNOWN_CODES, UNKNOWN_CODE]) {
    const r = classifyAuthError(code, HEALTHY);
    const missing = REQUIRED.filter((k) => r[k] === undefined);
    eq(`"${code}" returns every field the toast reads`, missing.length, 0);
  }

  // A real failure must still be on screen when the person comes back from dealing
  // with it. Only a dismissal is allowed to disappear by itself.
  for (const code of [...KNOWN_CODES, UNKNOWN_CODE]) {
    const r = classifyAuthError(code, HEALTHY);
    if (r.kind === AUTH_OUTCOME.cancelled) {
      truthy(`"${code}" (a dismissal) auto-dismisses`, r.autoDismissMs > 0);
    } else {
      eq(`"${code}" (a real failure) stays put`, r.autoDismissMs, 0);
    }
  }

  // Console level: only a dismissal is info. Everything else is an error, because
  // that is what it is.
  for (const code of [...KNOWN_CODES, UNKNOWN_CODE]) {
    const r = classifyAuthError(code, HEALTHY);
    eq(`"${code}" logs at ${r.kind === AUTH_OUTCOME.cancelled ? "info" : "error"}`, r.log, r.kind === AUTH_OUTCOME.cancelled ? "info" : "error");
  }

  // `code` is echoed back unparaphrased — it is the string that goes in a bug
  // report or a support ticket, so it must survive classification untouched.
  eq("the raw code is preserved", classifyAuthError("exited_auth_flow", HEALTHY).code, "exited_auth_flow");
  eq("an empty code becomes 'unknown', not ''", classifyAuthError("", HEALTHY).code, "unknown");
}

// ---------------------------------------------------------------------------
section("7 · an insecure context replaces the diagnosis, except for a dismissal");
// ---------------------------------------------------------------------------
{
  // Over a LAN IP on plain HTTP the browser has disabled WebCrypto, so NO wallet
  // flow can work regardless of which code Privy emitted. Appending that to the
  // real explanation would give the reader two things to act on and no way to
  // know which; replacing it gives one.
  const r = classifyAuthError("invalid_origin", { structuralFault: false, secureContext: false });
  eq("kind becomes environment", r.kind, AUTH_OUTCOME.environment);
  truthy("the reader is told which address to open", /localhost:5173/.test(r.user));
  truthy("the original detail is still preserved in dev", /Also reported/i.test(r.dev));

  // THE EXEMPTION IS THE IMPORTANT HALF. This is the exact regression the fix is
  // for: closing a popup while running on 192.168.1.x must not turn into a red
  // "this address can't create a wallet" alert.
  const cancelledInsecure = classifyAuthError("exited_auth_flow", { structuralFault: false, secureContext: false });
  eq("a dismissal stays a dismissal over HTTP", cancelledInsecure.kind, AUTH_OUTCOME.cancelled);
  eq("…with a neutral tone", cancelledInsecure.tone, "neutral");
  eq("…and an info log", cancelledInsecure.log, "info");

  // Absent means "not measured", which must NOT be reported as insecure — that
  // would blame the reader's browser for a fact nobody checked.
  eq("omitting secureContext assumes secure", classifyAuthError("invalid_origin", { structuralFault: false }).kind, AUTH_OUTCOME.blocked);
  eq("omitting structuralFault assumes healthy", classifyAuthError("exited_auth_flow", { secureContext: true }).kind, AUTH_OUTCOME.cancelled);
}

// ---------------------------------------------------------------------------
section("8 · classifyAuthError never throws, whatever it is handed");
// ---------------------------------------------------------------------------
{
  const garbage = [
    null, undefined, "", "   ", 0, 123, NaN, {}, [], true, false,
    new Error("boom"), new TypeError("nope"),
    "EXITED_AUTH_FLOW",                       // case must not matter
    "Error: exited_auth_flow at foo.js:1",    // a whole stack, not a bare code
    "x".repeat(5000),                         // a pathologically long message
    "line1\nline2 exited_auth_flow",          // embedded newlines
  ];
  for (const g of garbage) {
    let r;
    try {
      r = classifyAuthError(g, HEALTHY);
      truthy(`survives ${typeof g === "object" ? g?.constructor?.name || "object" : JSON.stringify(String(g).slice(0, 20))}`, typeof r.title === "string" && r.title.length > 0);
    } catch (e) {
      bad(`survives ${String(g).slice(0, 24)}`, `threw ${e.message}`);
    }
  }

  // Matching is on substrings, so a code wrapped in a real message still lands in
  // the right branch. Privy does hand back more than a bare token sometimes.
  eq("a code inside a longer message still classifies", classifyAuthError("Error: exited_auth_flow at foo.js:1", HEALTHY).kind, AUTH_OUTCOME.cancelled);
  eq("matching is case-insensitive", classifyAuthError("EXITED_AUTH_FLOW", HEALTHY).kind, AUTH_OUTCOME.cancelled);
  eq("an unknown code is unknown, not cancelled", classifyAuthError(UNKNOWN_CODE, HEALTHY).kind, AUTH_OUTCOME.unknown);
  eq("…and still gets a tone the toast can render", classifyAuthError(UNKNOWN_CODE, HEALTHY).tone, "bad");

  // explainPrivyError is called from paths that may hand it anything.
  for (const g of [null, undefined, "", {}, new Error("x")]) {
    try {
      truthy(`explainPrivyError survives ${g === null ? "null" : typeof g}`, typeof explainPrivyError(g, { secureContext: true }) === "string");
    } catch (e) {
      bad(`explainPrivyError survives ${String(g)}`, `threw ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
section("9 · privy-dom is safe outside a browser");
// ---------------------------------------------------------------------------
{
  // This runs in Node. If scanDom() or privyStructuralFault() touched the DOM at
  // module scope, importing them above would already have thrown — but asserting
  // the RETURN VALUE matters too, because PrivyLayer feeds this verdict straight
  // into classifyAuthError.
  eq("scanDom() returns null with no document", scanDom(), null);

  const r = privyStructuralFault();
  eq("no DOM means no fault claimed", r.fault, false);
  eq("…and no reasons invented", r.reasons.length, 0);
  eq("…and dom is null, not {}", r.dom, null);

  // Being wrong in THIS direction is the cheap failure: it reports a friendly
  // "please try again" instead of a precise structural diagnosis. The expensive
  // direction — claiming a fault that isn't there — is what section 2 guards.
  truthy("isPrivyish is a pure predicate", typeof isPrivyish === "function");
  truthy("it recognises a Privy iframe", isPrivyish({ id: "", className: "", src: "https://auth.privy.io/embed/x", getAttribute: () => "" }));
  truthy("it ignores an unrelated one", !isPrivyish({ id: "chart", className: "w-full", src: "", getAttribute: () => "" }));
  truthy("it survives a missing getAttribute", !isPrivyish({ id: "", className: "", src: "" }));
}

// ---------------------------------------------------------------------------
section("10 · privy-dom actually detects the double mount it exists to detect");
// ---------------------------------------------------------------------------
{
  // A minimal fake DOM, because the whole cancellation/broken split rests on these
  // counters being right. Trusting an untested probe would make the friendlier
  // toast a silent failure whenever the page really IS broken.
  const el = (props = {}) => ({
    id: props.id || "",
    name: "",
    className: props.className || "",
    src: props.src || "",
    tagName: props.tagName || "DIV",
    getAttribute: () => "",
    ...(props.reactRoot ? { __reactContainer$xyz: {} } : {}),
  });

  const withDom = ({ iframes = [], dialogs = [], roots = [], mounts = 1, unmounts = 0 }) => {
    const f = iframes.map((p) => el({ ...p, tagName: "IFRAME" }));
    const d = dialogs.map((p) => el({ ...p, tagName: "DIALOG" }));
    const r = roots.map((p) => el({ ...p, reactRoot: true }));
    globalThis.document = {
      querySelectorAll: (sel) => (sel === "iframe" ? f : sel === "dialog" ? d : [...f, ...d, ...r]),
    };
    globalThis.window = { __agentfloatBridgeMounts: mounts, __agentfloatBridgeUnmounts: unmounts };
  };

  const PRIVY_IFRAME = { src: "https://auth.privy.io/embed/1.5.0" };

  try {
    withDom({ iframes: [PRIVY_IFRAME], roots: [{ id: "root" }], mounts: 1, unmounts: 0 });
    let r = privyStructuralFault();
    eq("a healthy page reports no fault", r.fault, false);
    eq("…and counts the Privy iframe", r.dom.privyIframes, 1);
    eq("healthy is 1 mount", r.dom.bridgeMounts, 1);

    withDom({ iframes: [PRIVY_IFRAME], roots: [{ id: "root" }], mounts: 2, unmounts: 0 });
    r = privyStructuralFault();
    eq("a provider that mounted twice IS a fault", r.fault, true);
    truthy("…and says so in words a human can act on", /mounted 2/.test(r.reasons.join(" ")), r.reasons[0]);

    withDom({ iframes: [PRIVY_IFRAME], roots: [{ id: "root" }], mounts: 1, unmounts: 1 });
    r = privyStructuralFault();
    eq("an unmount mid-session IS a fault", r.fault, true);

    withDom({ iframes: [PRIVY_IFRAME, PRIVY_IFRAME], roots: [{ id: "root" }], mounts: 1, unmounts: 0 });
    r = privyStructuralFault();
    eq("two sign-in iframes IS a fault", r.fault, true);

    withDom({ iframes: [PRIVY_IFRAME], roots: [{ id: "root" }, { id: "legacy" }], mounts: 1, unmounts: 0 });
    r = privyStructuralFault();
    eq("two React roots IS a fault", r.fault, true);
    truthy("…and names them", /root/.test(r.reasons.join(" ")));

    // The end-to-end claim: with a real double mount, `exited_auth_flow` must NOT
    // be reported as a dismissal. This is the assertion that ties the two modules
    // together the way PrivyLayer does at runtime.
    withDom({ iframes: [PRIVY_IFRAME], roots: [{ id: "root" }], mounts: 2, unmounts: 0 });
    const verdict = classifyAuthError("exited_auth_flow", {
      structuralFault: privyStructuralFault().fault,
      secureContext: true,
    });
    eq("double mount + exited_auth_flow = a real failure", verdict.kind, AUTH_OUTCOME.broken);

    withDom({ iframes: [PRIVY_IFRAME], roots: [{ id: "root" }], mounts: 1, unmounts: 0 });
    const verdict2 = classifyAuthError("exited_auth_flow", {
      structuralFault: privyStructuralFault().fault,
      secureContext: true,
    });
    eq("healthy page + exited_auth_flow = a dismissal", verdict2.kind, AUTH_OUTCOME.cancelled);

    // A page with no Privy iframe at all is not a structural fault on these terms —
    // it just means the flow never got far enough to build one. Reporting that as
    // broken would blame the page for the person closing it instantly.
    withDom({ iframes: [], roots: [{ id: "root" }], mounts: 1, unmounts: 0 });
    eq("no iframe yet is not a fault", privyStructuralFault().fault, false);
  } finally {
    // MUST clean up: explainPrivyError reads window.isSecureContext when the caller
    // does not supply one, so a leaked fake window would silently make every later
    // test in this file think it is on an insecure origin.
    delete globalThis.document;
    delete globalThis.window;
  }

  // A caller may hand in a snapshot it already took. /diagnose does: it holds `dom`
  // in state and re-reads it every 700ms, and the verdict printed on screen has to
  // be computed from the very numbers printed beside it. Note these run with NO
  // document at all, which is the proof that the snapshot path is independent of a
  // live DOM.
  const snap = (over = {}) => ({
    iframes: 1, privyIframes: 1, privyIframeSrcs: ["https://auth.privy.io/embed/x"],
    dialogs: 0, privyDialogs: 0, reactRoots: 1, reactRootIds: ["root"],
    bridgeMounts: 1, bridgeUnmounts: 0, ...over,
  });
  eq("a healthy snapshot reports no fault with no DOM present", privyStructuralFault(snap()).fault, false);
  eq("a snapshot with 2 mounts reports a fault", privyStructuralFault(snap({ bridgeMounts: 2 })).fault, true);
  eq("a snapshot with an unmount reports a fault", privyStructuralFault(snap({ bridgeUnmounts: 1 })).fault, true);
  eq("a snapshot with 2 iframes reports a fault", privyStructuralFault(snap({ privyIframes: 2 })).fault, true);
  eq("a snapshot with 2 React roots reports a fault", privyStructuralFault(snap({ reactRoots: 2, reactRootIds: ["root", "legacy"] })).fault, true);
  truthy(
    "the snapshot is echoed back, not a fresh scan",
    privyStructuralFault(snap({ bridgeMounts: 3 })).dom.bridgeMounts === 3
  );
  truthy(
    "reasons are worded for a human, not a code",
    /mounted 3/.test(privyStructuralFault(snap({ bridgeMounts: 3 })).reasons.join(" "))
  );
  // A snapshot with a missing field must not throw or silently pass.
  eq("a partial snapshot is still readable", privyStructuralFault({ bridgeMounts: 2 }).fault, true);

  eq("globals cleaned up", typeof globalThis.document, "undefined");
  eq("so explainPrivyError assumes secure again", classifyAuthError("invalid_origin", { structuralFault: false }).kind, AUTH_OUTCOME.blocked);
}

// ---------------------------------------------------------------------------
section("11 · the classifier is the single source of this copy");
// ---------------------------------------------------------------------------
{
  // The old PRIVY_ERROR_HINTS table was deleted from privy.js and privy.js now
  // re-exports from here. If someone re-adds a second table, the toast and
  // /diagnose will eventually disagree about the same code.
  const privy = readFileSync(join(HERE, "../src/lib/privy.js"), "utf8");
  eq("privy.js no longer defines its own hint table", privy.includes("const PRIVY_ERROR_HINTS"), false);
  truthy("privy.js re-exports the classifier", /export \{[^}]*classifyAuthError[^}]*\} from "\.\/auth-errors\.js"/.test(privy));

  // The DOM probe must also exist once. It used to live inside Diagnose.jsx.
  const diagnose = readFileSync(join(HERE, "../src/pages/Diagnose.jsx"), "utf8");
  eq("Diagnose.jsx no longer defines scanDom locally", diagnose.includes("function scanDom"), false);
  truthy("Diagnose.jsx imports the shared probe", /from "\.\.\/lib\/privy-dom\.js"/.test(diagnose));

  // And PrivyLayer must consult it rather than guessing from the code string.
  const layer = readFileSync(join(HERE, "../src/lib/PrivyLayer.jsx"), "utf8");
  truthy("PrivyLayer classifies through auth-errors.js", /classifyAuthError/.test(layer));
  truthy("PrivyLayer asks the DOM probe", /privyStructuralFault\(\)/.test(layer));
  eq("PrivyLayer no longer builds error copy by hand", layer.includes("hint: explainPrivyError"), false);
}

console.log(
  `\n${failed ? `❌ ${failed} failed` : "✅ sign-in copy is user-facing and correct"}, ${passed} passed\n`
);
process.exit(failed ? 1 : 0);
