// ---------------------------------------------------------------------------
// check-client — is the source this app runs from actually current on THIS machine?
//
//   npm run check:client
//
// WHY THIS EXISTS
//   This repo gets edited in one place and copied by hand to another. That means
//   "does my machine have the fix?" is normally a guessing game, and the failure
//   mode is brutal: a stale file produces a symptom that looks like a vendor bug.
//
//   The canonical example is the Privy login modal that opens, loads, and then
//   vanishes with nothing in the console. That is not Privy being broken — it is
//   a stale src/main.jsx that still wraps the app in <React.StrictMode>.
//   StrictMode mounts, unmounts and remounts every component in development;
//   PrivyProvider owns an iframe and an id-keyed cross-window event queue, so the
//   remount leaves the second instance waiting on an event the first already
//   consumed:
//     Uncaught Error: cannot dequeue privy:iframe:ready event: no event found
//   Same fingerprint, second cause: an entry module that calls createRoot()
//   twice, mounting two React trees and therefore two providers over one queue.
//
//   So this script greps the local source for every known-bad pattern this
//   project has already paid for, and says which file to recopy. It checks
//   patterns, not hashes — a file can be reorganised and still be correct, and a
//   hash would only tell you "different", not "wrong".
//
//   TWO SERVER FILES ARE CHECKED HERE ON PURPOSE (../server/gas.js,
//   ../server/agent-gateway.js). They are copied by hand alongside the frontend,
//   and what they break is a CLIENT behaviour: a stale gas.js answers the approval
//   popup's "send me gas" button with a BigInt serialisation error, and a stale
//   gateway still tells the user to run a repo script. Checking only src/ would
//   leave half of that fix unverifiable.
//
//   Exit code 1 if anything is stale. No network, no build, no .env needed.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Strip comments and keep strings intact.
 *
 * Non-negotiable here: the source explains these very bugs in prose, so the
 * literal text `<React.StrictMode>` and `createRoot()` appears in the comments of
 * a CORRECT main.jsx. Matching the raw file would flag the fixed version and pass
 * the broken one — the exact inversion of useful. Quote and template state are
 * tracked so a `//` inside a string survives.
 *
 * Known limitation: regex literals are not tokenised, so a `/` starting a regex
 * followed by `/` or `*` could be misread. None of the checked files do that.
 */
function stripComments(src) {
  let out = "";
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const d = src[i + 1];
    if (quote) {
      if (c === "\\") { out += c + (d ?? ""); i++; continue; }
      if (c === quote) quote = null;
      out += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; continue; }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

// Each check: `bad` fires a failure, `good` fires a pass. A file with neither is
// reported as unchecked rather than silently passing — an unexpected rewrite
// should be visible, not assumed fine.
const CHECKS = [
  {
    file: "src/main.jsx",
    why: "app entry — bootstrap only",
    checks: [
      {
        name: "no <React.StrictMode>",
        bad: /<\s*(React\.)?StrictMode[\s>]/,
        fix:
          "StrictMode remounts PrivyProvider, which strands the iframe's event " +
          "queue — the login modal opens, spins, and vanishes. Copy the current " +
          "src/main.jsx, which renders <BrowserRouter><SessionLayer><App/></SessionLayer></BrowserRouter> " +
          "directly.",
      },
      {
        name: "createRoot() called at most once",
        bad: null,
        custom: (code) => {
          const n = (code.match(/createRoot\s*\(/g) || []).length;
          return n > 1
            ? `${n} createRoot() call sites — two React trees means two PrivyProviders sharing one iframe queue`
            : null;
        },
        fix:
          "Memoise the root on the container: `if (!container.__agentfloatRoot) " +
          "container.__agentfloatRoot = createRoot(container);`. Copy the current src/main.jsx.",
      },
      {
        name: "entry exports nothing (Fast Refresh)",
        bad: /^\s*export\s+(default\s+)?(function|const|class)/m,
        fix:
          "vite-plugin-react bails out of Fast Refresh on a module that mixes " +
          "components with other exports, and bailing out on the ENTRY re-imports " +
          "it — which is how a second createRoot() happened. Components belong in " +
          "src/lib/SessionLayer.jsx and src/lib/app-data.jsx.",
      },
    ],
  },
  {
    file: "src/lib/privy.js",
    why: "Privy provider config",
    checks: [
      {
        name: "createOnLogin nested under embeddedWallets.ethereum",
        good: /embeddedWallets:\s*\{[\s\S]{0,200}?ethereum:\s*\{[\s\S]{0,120}?createOnLogin:\s*["'](all-users|users-without-wallets)["']/,
        fix:
          "In @privy-io/react-auth 3.x the key is embeddedWallets.ethereum." +
          "createOnLogin. The un-nested spelling is not in the config type, so it " +
          "is silently dropped and defaults to \"off\": users sign in and get NO " +
          "agent wallet, with no error anywhere.",
      },
      {
        name: "walletChainType inside appearance",
        good: /appearance:\s*\{[\s\S]{0,400}?walletChainType:\s*["']ethereum-only["']/,
        fix:
          "walletChainType lives under `appearance`, not at the top level. " +
          "Misplaced it is ignored and Privy offers Solana wallets in an EVM-only product.",
      },
      {
        name: "smart wallets / gas sponsorship not requested",
        // Config keys only. walletKind() legitimately mentions
        // "privy_smart_wallet" to LABEL such a wallet as unusable, so matching
        // the bare identifier flags correct source. Require `name:`.
        bad: /\b(?:smartWallet|smartWallets|gasSponsor|gasSponsorship|privy_smart_wallet)\s*:/,
        fix:
          "x402 on Mezo authorizes with an EIP-712 permit2 signature, which only " +
          "an EOA can produce. Smart wallets and Privy gas sponsorship (EIP-7702 " +
          "delegation) give the address contract code and force ERC-1271 mode, " +
          "which the x402 client does not use.",
      },
    ],
  },
  {
    file: "src/lib/PrivyLayer.jsx",
    why: "the only module allowed to touch Privy hooks",
    checks: [
      {
        name: "login comes from useLogin(), not usePrivy()",
        // `login` is destructured BEFORE the call —
        //   const { ..., login, ... } = usePrivy();
        // so match the binding list, not text following the call. Looking the
        // other way round is a false negative on the exact bug this catches.
        bad: /\{[^}]*\blogin\b[^}]*\}\s*=\s*usePrivy\(\)/,
        good: /useLogin\s*\(\s*\{[\s\S]{0,400}?onError/,
        fix:
          "usePrivy().login returns void, so every failure is silent — the button " +
          "does nothing and the console says nothing. useLogin({ onError }) " +
          "receives a documented PrivyErrorCode, which turns a no-op into a named " +
          "reason. Copy the current src/lib/PrivyLayer.jsx.",
      },
      {
        name: "onError classifies the failure rather than trusting the code string",
        custom: (code) => {
          if (!/setAuthError\(makeAuthError\(error\)\)/.test(code)) {
            return "useLogin's onError does not route through makeAuthError()";
          }
          if (!/privyStructuralFault\(\)/.test(code)) return "the DOM probe is never consulted";
          if (!/classifyAuthError\(/.test(code)) return "classifyAuthError() is never called";
          // `exited_auth_flow` means BOTH "the person closed the popup" and "the
          // provider was torn down mid-handshake". Only the probe separates them.
          const def = code.indexOf("const makeAuthError");
          const use = code.indexOf("useLogin({");
          if (def === -1) return "makeAuthError is gone";
          if (use !== -1 && def > use) return "makeAuthError is defined AFTER the useLogin that calls it";
          return null;
        },
        fix:
          "Privy reports one code for a deliberate dismissal and for a broken flow. " +
          "makeAuthError() calls privyStructuralFault() (src/lib/privy-dom.js) and " +
          "classifyAuthError() (src/lib/auth-errors.js) to tell them apart, and must be " +
          "declared above useLogin. Without the probe, every cancel is reported as a " +
          "failure - or every real double-mount is waved through as a cancel.",
      },
      {
        name: "useWallets().ready is awaited",
        // The destructure reads `{ wallets, ready: walletsReady } = useWallets()`,
        // so the alias precedes the call. Matching the other order flags correct
        // source.
        good: /\{[^}]*ready\s*:\s*walletsReady[^}]*\}\s*=\s*useWallets\(\)/,
        fix:
          "useWallets() has its own readiness flag, separate from usePrivy()'s. " +
          "Privy's docs require waiting for both; reading only the first is the " +
          "documented cause of `Wallet proxy not initialized` and of a " +
          "\"creating wallet…\" spinner that never resolves.",
      },
      {
        name: "chain state is read from the wallet, not hardcoded",
        bad: /chainOk:\s*Boolean\(agentWallet\)|chainId:\s*MEZO_TESTNET_ID,/,
        fix:
          "PrivyLayer used to publish `chainId: MEZO_TESTNET_ID` and " +
          "`chainOk: Boolean(agentWallet)`. That made the navbar show " +
          "\"wrong network (31611) — switch to Mezo\" whenever the embedded wallet " +
          "was merely still provisioning, and an external wallet (the operator's " +
          "MetaMask) on mainnet was reported as fine. chainOk must be TRI-STATE: " +
          "true / false / null (nothing to ask yet). Copy the current " +
          "src/lib/PrivyLayer.jsx.",
      },
      {
        name: "fixNetwork actually switches the wallet",
        bad: /fixNetwork:\s*async\s*\(\)\s*=>\s*\(\{\s*wasOnChain:\s*true/,
        good: /ensureWalletChain\(/,
        fix:
          "The old fixNetwork resolved `{ wasOnChain: true }` without calling " +
          "anything — a button that always reported success and changed nothing, " +
          "which is indistinguishable from a broken button. It must call " +
          "ensureWalletChain() from src/lib/evm-network.js, which prefers Privy's " +
          "own wallet.switchChain() (the ONLY route for an embedded wallet: there " +
          "is no extension to prompt and the embedded provider does not implement " +
          "EIP-3085) and falls back to switch/add through the provider for " +
          "external wallets.",
      },
    ],
  },
  {
    file: "src/App.jsx",
    why: "routes and shell",
    checks: [
      {
        name: "/alerts route registered",
        good: /path="\/alerts"/,
        fix:
          "src/pages/Alerts.jsx exists but is not routed, so Telegram alerts — " +
          "which are bound from that page and from nowhere else — are unreachable, " +
          "and the navbar link 404s into the catch-all redirect. Add " +
          "`<Route path=\"/alerts\" element={<RequireSession><Alerts /></RequireSession>} />` " +
          "beside the other product routes.",
      },
      {
        name: "/diagnose route registered",
        good: /path="\/diagnose"/,
        fix:
          "src/pages/Diagnose.jsx exists but is not routed, so the live sign-in " +
          "diagnostics are unreachable. Add " +
          "`<Route path=\"/diagnose\" element={<Diagnose />} />` to App.jsx — " +
          "outside RequireSession, since it is only useful while sign-in is broken.",
      },
      {
        name: "no hook exports (Fast Refresh)",
        bad: /export\s+(function|const)\s+use[A-Z]/,
        fix:
          "App.jsx used to export useAppData alongside components, which made Fast " +
          "Refresh bail out and cascade into re-importing the entry. Shared state " +
          "lives in src/lib/app-data.jsx.",
      },
    ],
  },
  {
    file: "vite.config.js",
    why: "dev server",
    checks: [
      {
        name: "customLogger installed",
        good: /customLogger/,
        fix:
          "Without it, excluding Privy from pre-bundling prints ~300 " +
          "`Sourcemap … points to missing source files` warnings per cold start, " +
          "burying every real message. Patch BOTH logger.warn and logger.warnOnce " +
          "— warnOnce calls an internal output() closure and bypasses warn.",
      },
      {
        name: "optimizeDeps interop list present",
        good: /optimizeDeps[\s\S]{0,600}?include:\s*\[/,
        fix:
          "optimizeDeps.exclude strips CJS→ESM interop from a package's whole " +
          "subtree. Privy ships raw `module.exports` files whose .mjs siblings do " +
          "`import EventEmitter from './index.js'`, which dies in the browser with " +
          "\"does not provide an export named 'default'\". The include list is what " +
          "keeps those 26 files working.",
      },
      {
        name: "nested qrcode interop for WalletConnect",
        good: /@walletconnect\/ethereum-provider > qrcode/,
        fix:
          "WalletConnect's ethereum-provider nests its own copy of qrcode, which " +
          "is pure CommonJS. Without the three " +
          "`@walletconnect/ethereum-provider > qrcode…` entries in CJS_INTEROP " +
          "the Reown chunk dies in the browser with \"does not provide an " +
          "export named 'default'\" — the same crash as the original " +
          "eventemitter3 bug. Re-run `npm run check:deps` after adding any SDK.",
      },
      {
        name: "host defaults to loopback",
        good: /127\.0\.0\.1/,
        fix:
          "Binding 0.0.0.0 by default invites opening the LAN IP, which is not a " +
          "secure context: WebCrypto and injected wallets are disabled there, so " +
          "Privy cannot create an embedded wallet and login fails.",
      },
    ],
  },
  {
    file: "src/components/Navbar.jsx",
    why: "identity chip, user menu, network switch, error toast",
    checks: [
      {
        name: "the agent address is copyable from the navbar",
        good: /copyText\(/,
        fix:
          "The navbar showed a truncated agent address with no way to get the " +
          "full one. The identity chip opens a menu whose address row copies on " +
          "click and confirms. Copy the current src/components/Navbar.jsx.",
      },
      {
        name: "sign-out lives in the user menu",
        good: /function UserMenu\([\s\S]{0,4000}?aria-haspopup/,
        fix:
          "Sign out used to sit bare next to the address — the one destructive " +
          "action in the navbar, one misclick from the copy target. It belongs in " +
          "the menu the chip opens, with the address, the network and the " +
          "connected external wallet.",
      },
      {
        name: "AuthErrorToast renders in EVERY session state",
        custom: (code) => {
          const start = code.indexOf("export default function Navbar");
          if (start === -1) return "no default Navbar component";
          const end = code.indexOf("\nfunction ", start + 10);
          const body = code.slice(start, end === -1 ? undefined : end);
          return body.includes("<AuthErrorToast")
            ? null
            : "AuthErrorToast is not rendered by the Navbar component itself";
        },
        fix:
          "The toast used to be rendered only inside the signed-OUT branch, so a " +
          "failed NETWORK SWITCH — the one error a signed-in user can get — set " +
          "session.authError and displayed nothing. That is the other half of " +
          "\"the switch button doesn't work\": it worked, and its only feedback " +
          "channel was unreachable. Render <AuthErrorToast session={session} /> " +
          "once, at shell level, beside the <header>.",
      },
      {
        name: "the toast shows the user sentence, and folds the technical one away",
        custom: (code) => {
          // Both layers must be present, but the maintainer layer has to sit
          // INSIDE the disclosure. Rendering it unconditionally is the exact
          // regression this check exists to catch: the old toast put Privy's raw
          // code, an iframe-handshake explanation, /diagnose and a shell command
          // in front of someone who had clicked the X on the login popup.
          const toast = code.slice(code.indexOf("function AuthErrorToast"));
          if (toast.length < 200) return "AuthErrorToast is missing";
          if (!toast.includes("err.user")) return "the toast never renders err.user";
          const details = toast.indexOf("Technical details");
          if (details === -1) return "there is no 'Technical details' disclosure";
          for (const marker of ["{err.dev &&", "code: {err.code", 'to="/diagnose"', "npm run check:client"]) {
            const at = toast.indexOf(marker);
            if (at === -1) return `the disclosure no longer offers ${marker}`;
            if (at < details) return `"${marker}" renders BEFORE the disclosure, i.e. unconditionally`;
          }
          return null;
        },
        fix:
          "Sign-in copy has two audiences and they must not be merged. err.user is " +
          "the plain-language sentence for the person using the app; err.dev, the " +
          "raw code, /diagnose and `npm run check:client` are for whoever maintains " +
          "it and belong behind the 'Technical details' button. Nothing is deleted - " +
          "the detail stays one click away. Copy the current AuthErrorToast.",
      },
      {
        name: "the toast takes tone, title and persistence from the classifier",
        custom: (code) => {
          const toast = code.slice(code.indexOf("function AuthErrorToast"));
          // `!err.autoDismissMs` is required as well as `err.autoDismissMs`: the
          // timer must be GUARDED by the classifier's value. Asserting only that the
          // field is read is satisfied by the setTimeout argument alone, which lets
          // someone delete the guard and make every real failure disappear on a
          // timer — losing the message the person came back to read.
          const needed = [
            "TOAST_TONE[err.tone]", "err.title", "err.autoDismissMs",
            "!err.autoDismissMs", 'err.log === "info"',
          ];
          const missing = needed.filter((n) => !toast.includes(n));
          if (missing.length) return `ignores ${missing.join(", ")}`;
          // Re-deriving the presentation from the raw code is the old behaviour:
          // it is how `network_` got special-cased and every other code got red.
          if (/String\(err\.code[^)]*\)\.startsWith/.test(toast)) {
            return "re-derives the outcome from err.code instead of using err.kind/err.tone";
          }
          return null;
        },
        fix:
          "Colour, heading and whether the message clears itself all come from " +
          "classifyAuthError() in src/lib/auth-errors.js, carried on session.authError " +
          "as tone/title/kind/log/autoDismissMs. Hardcoding them per code here is how " +
          "a deliberate cancel ended up red: an unmapped tone falls back to the bad " +
          "styling. Copy the current AuthErrorToast.",
      },
      {
        name: "every hook in AuthErrorToast precedes its early return",
        custom: (code) => {
          const start = code.indexOf("function AuthErrorToast");
          const early = code.indexOf("if (!err) return null", start);
          if (start === -1 || early === -1) return "could not find the component or its early return";
          const hook = code.slice(early).match(/\buse(?:State|Effect|Callback|Memo|Ref)\s*\(/);
          return hook ? `a ${hook[0].trim()} call sits BELOW the early return` : null;
        },
        fix:
          "This navbar re-renders on the 6-second app-data poll, and the toast returns " +
          "null whenever there is no error. A hook below that return changes the hook " +
          "count between renders, which React rejects outright. Declare useState/useRef/" +
          "useEffect first, then return null.",
      },
      {
        name: "the switch button appears only on a MEASURED wrong chain",
        good: /chainOk !== false/,
        bad: /chainOk === false[\s\S]{0,80}wrong network[\s\S]{0,40}\(\)/,
        fix:
          "chainOk is tri-state now. `=== false` must gate the button, and " +
          "`null` (no wallet to ask yet, or the chain could not be read) must not " +
          "offer a switch that cannot do anything.",
      },
    ],
  },
  {
    file: "src/lib/auth-errors.js",
    why: "the two-layer sign-in copy: one sentence for the user, one for us",
    checks: [
      {
        name: "a dismissal and a structural failure are separate outcomes",
        custom: (code) => {
          for (const k of ["cancelled:", "broken:", "environment:"]) {
            if (!code.includes(k)) return `AUTH_OUTCOME is missing ${k}`;
          }
          if (!/if \(structuralFault\)/.test(code)) return "the dismissal branch ignores structuralFault";
          return null;
        },
        fix:
          "classifyAuthError() must return AUTH_OUTCOME.cancelled for exited_auth_flow " +
          "when the DOM probe is healthy, and AUTH_OUTCOME.broken when it is not. One " +
          "outcome for both is the original bug.",
      },
      {
        name: "no maintainer vocabulary in the user-facing branch",
        custom: (code) => {
          const start = code.indexOf("let kind, title, user, dev, tone;");
          const end = code.indexOf("return { kind, tone, title, user, dev, code, log, autoDismissMs };");
          if (start === -1 || end === -1) return "could not locate the classification body";
          const body = code.slice(start, end);
          // Strings and regexes, because one token needs an exception: our own
          // outcome is named AUTH_OUTCOME.environment, and a bare ".env" substring
          // match fires on it. A false positive here would be indistinguishable
          // from a real leak, which is how checks get ignored.
          const banned = [
            "npm run", "VITE_", "frontend/.env", "status.privy.com", "iframe",
            "incognito", "check:privy", "loginMethods", "allowlist", "App settings",
            "WebCrypto", "StrictMode", "Privy", "/diagnose",
            /\.env(?!ironment)/,
          ];
          const label = (w) => (w instanceof RegExp ? w.source : w);
          const hit = banned
            .filter((w) => (w instanceof RegExp ? w.test(body) : body.includes(w)))
            .map(label);
          return hit.length ? `user-facing copy mentions ${hit.join(", ")}` : null;
        },
        fix:
          "Everything between the `let kind, title, user, dev, tone` declaration and the " +
          "return is what becomes `title` and `user` - the only two strings the toast " +
          "shows without a click. Those are for the person using the app: plain " +
          "language, at most one action, no blame, no repo vocabulary. Technical detail " +
          "goes in the DEV table, which is rendered behind a disclosure.",
      },
      {
        name: "the technical layer survived the rewrite",
        custom: (code) => {
          const at = code.indexOf("const DEV = {");
          if (at === -1) return "the DEV table is gone";
          const body = code.slice(at, code.indexOf("\n};", at));
          const keys = body.match(/^ {2}\w+:/gm) || [];
          if (keys.length < 10) return `DEV has only ${keys.length} entries; it used to hold one per code`;
          for (const marker of ["VITE_PRIVY_APP_ID", "npm run check:privy", "status.privy.com", "loginMethods"]) {
            if (!body.includes(marker)) return `DEV no longer explains ${marker}`;
          }
          return null;
        },
        fix:
          "Making the app friendlier must not delete the diagnosis. The DEV table keeps " +
          "every technical explanation the old PRIVY_ERROR_HINTS carried, and the toast " +
          "renders it behind 'Technical details'. Do not trim it to shorten a message.",
      },
      {
        name: "the module stays importable in plain Node",
        custom: (code) => {
          if (/import\.meta/.test(code)) return "reads import.meta at module scope";
          if (/^\s*import\s/m.test(code)) return "imports something - it must stay dependency-free";
          // Facts about the environment are ARGUMENTS. Reading window here would make
          // the module untestable and unimportable outside a browser.
          if (!/ctx\.structuralFault/.test(code) || !/ctx\.secureContext/.test(code)) {
            return "reads the environment directly instead of taking it from ctx";
          }
          return null;
        },
        fix:
          "scripts/test-auth-errors.mjs imports this module in plain Node, with no " +
          "browser, no Vite and no .env - 274 assertions that the copy is right. That " +
          "only works because structuralFault and secureContext are passed IN. Keep it " +
          "dependency-free and free of import.meta.",
      },
    ],
  },
  {
    file: "src/lib/privy-dom.js",
    why: "the DOM probe that separates a dismissal from a broken provider",
    checks: [
      {
        name: "the probe exists exactly once, shared with /diagnose",
        custom: (code) => {
          for (const fn of ["export function scanDom", "export function privyStructuralFault", "export const isPrivyish"]) {
            if (!code.includes(fn)) return `${fn} is missing`;
          }
          return null;
        },
        fix:
          "scanDom() and isPrivyish() were originally private to src/pages/Diagnose.jsx. " +
          "PrivyLayer now needs the same measurements to decide whether exited_auth_flow " +
          "means 'you closed it' or 'it broke', so they live here and both import them. " +
          "Two copies would eventually disagree, and a disagreement means either false " +
          "alarms on every cancel or a real double-mount going unreported.",
      },
      {
        name: "an unreadable DOM is never reported as a fault",
        good: /if \(!dom\) return \{ fault: false, reasons: \[\], dom: null \};/,
        fix:
          "scanDom() returns null outside a browser. privyStructuralFault() must then " +
          "report NO fault: claiming one would turn every server-rendered or test " +
          "invocation into a structural error.",
      },
      {
        name: "the healthy thresholds are the documented ones",
        custom: (code) => {
          const wanted = ["dom.bridgeMounts > 1", "dom.bridgeUnmounts > 0", "dom.privyIframes > 1", "dom.reactRoots > 1"];
          const missing = wanted.filter((w) => !code.includes(w));
          return missing.length ? `no longer checks ${missing.join(", ")}` : null;
        },
        fix:
          "Healthy is 1 provider mount, 0 unmounts, 1 Privy iframe, 1 React root. Each " +
          "of those is a distinct way the handshake breaks, and dropping one silently " +
          "reclassifies a real failure as a dismissal.",
      },
      {
        name: "DOM access happens inside functions, never at module scope",
        custom: (code) => {
          const firstDoc = code.search(/\bdocument\./);
          const scan = code.indexOf("export function scanDom");
          if (firstDoc === -1) return "scanDom no longer reads the document";
          if (scan === -1) return "scanDom is missing";
          return firstDoc < scan ? "reads document at module scope" : null;
        },
        fix:
          "A module-scope `document` read throws the moment Node imports this file, " +
          "which takes test-auth-errors.mjs down with it. Every DOM read stays inside " +
          "scanDom().",
      },
    ],
  },
  {
    file: "src/pages/Diagnose.jsx",
    why: "the maintainer-only diagnostics page",
    checks: [
      {
        name: "it imports the shared probe instead of redefining it",
        custom: (code) => {
          if (/function scanDom/.test(code) || /const isPrivyish =/.test(code)) {
            return "redefines scanDom/isPrivyish locally";
          }
          if (!code.includes('from "../lib/privy-dom.js"')) return "does not import lib/privy-dom.js";
          // Importing the probe is not the same as using its VERDICT. This page used
          // to re-derive `dom.bridgeMounts > 1 || dom.bridgeUnmounts > 0` by hand —
          // a second copy of the thresholds that also decide what the sign-in toast
          // says, and therefore a way for the page to report a healthy browser while
          // the toast reports a broken one.
          if (!/privyStructuralFault\(dom\)/.test(code)) {
            return "imports the probe but never asks it for a verdict";
          }
          if (/dom\.bridgeMounts > 1 \|\| dom\.bridgeUnmounts > 0/.test(code)) {
            return "re-derives the double-mount thresholds instead of using the shared verdict";
          }
          return null;
        },
        fix:
          "The probe moved to src/lib/privy-dom.js so PrivyLayer can use the same " +
          "measurements to classify a sign-in outcome. Import it; do not paste it back.",
      },
    ],
  },
  {
    file: "src/components/ui.jsx",
    why: "shared primitives",
    checks: [
      {
        name: "Button merges an incoming className",
        good: /function Button\(\{[^}]*className/,
        bad: /className=\{`btn \$\{v\} \$\{s\}`\}\s*\{\.\.\.rest\}/,
        fix:
          "`<button className={\`btn …\`} {...rest}>` lets a caller's className " +
          "REPLACE the base classes, so `<Button className=\"w-full\">` rendered " +
          "an unstyled browser button. Destructure className out of rest and " +
          "append it.",
      },
      {
        name: "clipboard copy survives an insecure context",
        good: /export async function copyText[\s\S]{0,900}?execCommand/,
        bad: /navigator\.clipboard\?\.writeText\([^)]*\)\.catch\(\(\)\s*=>\s*\{\}\)/,
        fix:
          "navigator.clipboard is undefined outside a secure context, so on " +
          "http://192.168.1.195:5173 (LAN access from a phone) a naive copy " +
          "fails silently while the UI says \"copied ✓\". copyText() falls back " +
          "to a hidden textarea + execCommand and returns a boolean so callers " +
          "can tell the truth.",
      },
      {
        name: "Spinner turns a ring and keeps its label",
        good: /export function Spinner\([\s\S]{0,220}?<RingSpinner/,
        bad: /export function Spinner\([\s\S]{0,220}?pulse-dot/,
        fix:
          "A dot that fades in and out reads as decoration, so a slow load looked like " +
          "a hang. lib/RingSpinner.jsx is the one loading indicator; the label stays, " +
          "because it is what tells the user which button on the page is busy.",
      },
    ],
  },
  {
    file: "src/index.css",
    why: "Tailwind v4 design tokens",
    checks: [
      {
        name: "ink-dim token exists",
        good: /--color-ink-dim:/,
        fix:
          "The dashboard's inset surfaces (cap grid, skeletons, progress track) " +
          "use bg-ink-dim. Without the token Tailwind emits no class at all and " +
          "every one of those panels renders transparent — the layout looks " +
          "broken with nothing in the console.",
      },
      {
        name: "ring-spin keyframes exist",
        good: /@keyframes ring-spin/,
        fix:
          ".ring-spin drives every loading indicator, including the boot screen shown " +
          "while a wallet provider loads. Its own keyframes rather than Tailwind's " +
          "animate-spin so the reduced-motion block can name it explicitly.",
      },
      {
        name: "reduced motion stills the ring",
        good: /prefers-reduced-motion[\s\S]{0,400}?\.ring-spin/,
        fix:
          "The reduced-motion block lists every animation this app defines. A spinner " +
          "left out of it keeps turning for users who asked their OS to stop that.",
      },
      {
        name: "shimmer keyframes exist",
        good: /@keyframes shimmer/,
        fix:
          "The treasury budget meter uses .animate-shimmer. An arbitrary " +
          "animate-[shimmer_2s_infinite] compiles to an animation-name with no " +
          "matching @keyframes, i.e. no motion and no warning.",
      },
      {
        name: "buttons get cursor-pointer",
        good: /\.btn\s*\{[\s\S]{0,240}?cursor-pointer/,
        fix:
          "Tailwind v4's preflight dropped the v3 rule that gave every <button> " +
          "a pointer cursor, so buttons read as inert. It is set on .btn and " +
          ".nav-link.",
      },
    ],
  },
  {
    file: "src/pages/Dashboard.jsx",
    why: "the page a new user judges the product by",
    checks: [
      {
        name: "the user's own agent renders before shared protocol state",
        custom: (code) => {
          const mine = code.indexOf("<YourAgent");
          const shared = code.indexOf("<ProtocolSection");
          if (mine === -1 || shared === -1) {
            return "lost the <YourAgent /> / <ProtocolSection /> split";
          }
          return mine < shared
            ? null
            : "shared protocol state renders before the user's own agent";
        },
        fix:
          "Opening with the treasury and the gateway's demo agent is what made a " +
          "brand-new user think they already had a balance and a setup. Order is " +
          "the requirement here: <YourAgent /> (wallet + operations), then " +
          "<NextSteps />, then the labelled divider, then <ProtocolSection />.",
      },
      {
        name: "one shared agent-status fetch, not two polls",
        good: /useAgentStatus\(/,
        bad: /function useMyAgentStatus\(/,
        fix:
          "The hero, the onboarding rail, the Spend budget panel, the Operate caps " +
          "row and the Faucet readback all need the same agentStatus() numbers for " +
          "the same address. The hook now lives in src/lib/agent-status.jsx because " +
          "the subtle part is shared too: agentStatus() REVERTS for a wallet that " +
          "is not registered yet, and that revert means \"new user, no float\", not " +
          "failure. Five copies of that handling is five chances to get it wrong. " +
          "Copy the current src/lib/agent-status.jsx and src/pages/Dashboard.jsx.",
      },
      {
        name: "no hook is called below an early return",
        custom: (code) => {
          const start = code.indexOf("export default function Dashboard()");
          if (start === -1) return "no default Dashboard component";
          const end = code.indexOf("\nfunction ", start + 10);
          const body = code.slice(start, end === -1 ? undefined : end);
          const hook = body.indexOf("useAgentStatus(");
          const guard = body.indexOf("if (!deployed)");
          if (hook === -1) return "Dashboard does not read agent status";
          if (guard === -1) return null;
          return hook < guard
            ? null
            : "useAgentStatus() is called AFTER the `if (!deployed) return` guard";
        },
        fix:
          "A hook below an early return changes the hook count between renders the " +
          "moment the condition flips — here, when the deployment artifacts appear " +
          "while the page is mounted. React then throws \"Rendered more hooks than " +
          "during the previous render\" and unmounts the page. Read first, return " +
          "second.",
      },
      {
        name: "no animation classes that do not exist",
        bad: /animate-in\s+fade-in|animate-\[shimmer/,
        fix:
          "`animate-in fade-in` comes from tailwindcss-animate, which is not " +
          "installed, and `animate-[shimmer_…]` needs @keyframes Tailwind will " +
          "not generate for you. Both compile to nothing. Use the .animate-fade " +
          "and .animate-shimmer utilities defined in src/index.css — they are " +
          "also covered by the prefers-reduced-motion block.",
      },
      {
        name: "a loading balance is never shown as zero",
        bad: /animate-pulse">\s*0\.0000/,
        fix:
          "While the treasury read is in flight the hero shows a skeleton bar. A " +
          "pulsing 0.0000 is indistinguishable from \"your balance is gone\", " +
          "which is the exact misreading this page exists to prevent.",
      },
      {
        name: "the next-steps rail can enable payments without leaving the page",
        custom: (code) => {
          if (!/<ApprovalModal[\s\/]/.test(code)) return "the approval popup is not mounted";
          const early = code.indexOf("if (!deployed)");
          const hook = code.indexOf("refreshAllowance");
          if (hook === -1) return "the allowance is never read or refreshed";
          if (early !== -1 && hook > early) {
            return "the allowance hook sits AFTER the `if (!deployed)` early return";
          }
          return null;
        },
        fix:
          "The rail lists what a new user does next and one of those steps is " +
          "granting the Permit2 allowance. It must be a button that opens " +
          "<ApprovalModal />, not prose and not a link to a script. Keep the " +
          "allowance hooks ABOVE the `if (!deployed)` early return: a hook after a " +
          "conditional return breaks the rules of hooks and throws at render. " +
          "Copy the current src/pages/Dashboard.jsx.",
      },
    ],
  },
  {
    file: "src/pages/Operate.jsx",
    why: "self-service budget, then owner-only controls",
    checks: [
      {
        name: "a user can change their OWN caps without the owner wallet",
        good: /limitsChallenge\([\s\S]{0,1200}?session\.signMessage\(/,
        fix:
          "Every control on this page used to require the treasury-owner wallet, so " +
          "for anyone without that key the configuration looked disabled and the " +
          "product looked like it was not for them. setAgentLimits() stays " +
          "onlyOwner on purpose — an agent that can raise its own ceiling is not " +
          "budget-controlled — so the user AUTHORIZES a specific change with a " +
          "signature from their own agent wallet and the gateway applies it with " +
          "the owner key, inside a published ceiling. Copy the current " +
          "src/pages/Operate.jsx (and src/lib/gateway.js, which holds " +
          "limitsChallenge/limitsApply).",
      },
      {
        name: "the page does not present itself as owner-only",
        bad: /eyebrow="Owner only"/,
        fix:
          "The old header read \"Owner only\", which told an ordinary signed-in user " +
          "the whole page was not theirs. Zone one is their budget; the owner-only " +
          "machinery sits below a divider that says whose it is.",
      },
      {
        name: "your budget renders before the protocol controls",
        custom: (code) => {
          const mine = code.indexOf("<YourBudget");
          const shared = code.indexOf("<OwnerControls");
          if (mine === -1 || shared === -1) {
            return "lost the <YourBudget /> / <OwnerControls /> split";
          }
          return mine < shared ? null : "owner-only controls render before the user's own budget";
        },
        fix:
          "Order is the requirement: <YourBudget /> (available to every signed-in " +
          "user), then the labelled divider, then <OwnerControls />. A non-owner " +
          "sees an explanation there, not a wall of disabled buttons — disabled " +
          "controls with no reason read as a broken page.",
      },
    ],
  },
  {
    file: "src/pages/Spend.jsx",
    why: "buying an HTTP resource from a browser wallet",
    checks: [
      {
        name: "the gateway relay is the default fetch path",
        good: /relayProbe\(/,
        bad: /useState\(\s*"browser"\s*\)/,
        fix:
          "Sellers answer a paid request from a server, and almost none of them " +
          "send Access-Control-Allow-Origin, so a browser that fetches the 402 " +
          "itself dies with \"Failed to fetch\" — which reads as an app bug and is " +
          "not one. The relay keeps the SIGNATURE in the browser (Privy prompt, key " +
          "never leaves the enclave) and moves only the HTTP hop to the gateway, " +
          "which also enforces the caps and records the settlement. Make it the " +
          "default and keep \"direct from browser\" as the labelled alternative. " +
          "Copy the current src/pages/Spend.jsx.",
      },
      {
        name: "the browser signs a relayed 402 without fetching it",
        good: /makeRelaySigner\(/,
        fix:
          "src/lib/x402-browser.js exposes makeRelaySigner(wallet) → " +
          "{ signProbe(probe), parseResult(response) }. It exists because " +
          "wrapFetchWithPayment() signs AND fetches in one process, and here those " +
          "two halves must happen in different ones. Copy the current " +
          "src/lib/x402-browser.js.",
      },
      {
        // The automation must not grow its own payment path: two implementations
        // would mean the demo proves something the product does not do.
        name: "the loop and the Pay button share one purchase path",
        custom: (code) => {
          const calls = (code.match(/await purchase\(/g) || []).length;
          if (calls < 2) return `purchase() is called ${calls} time(s) — the Pay button and the loop must both use it`;
          return null;
        },
        fix:
          "purchase() does probe → sign → settle → verify and RETURNS the result; " +
          "onPay() renders it and runOnce() logs it. If a second payment " +
          "implementation appears for the loop, the automation is demonstrating " +
          "code the product never runs.",
      },
      {
        name: "the loop is armed from the log, not from a counter",
        bad: /useRef\(|setInterval\(/,
        fix:
          "A run counter in a ref is a second source of truth, and setInterval is " +
          "worse: this effect re-arms on every completed run via setTimeout, so a " +
          "schedule change takes effect on the next run instead of tearing the " +
          "timer down. Both patterns here mean the loop has been rewritten away " +
          "from shouldContinue().",
      },
      {
        name: "the projection is shown before the loop starts",
        good: /projection\.nextRefusal[\s\S]{0,1200}?projection\.capHitsOnRun/,
        fix:
          "The panel says which run the cap will refuse BEFORE anything is signed, " +
          "using the same on-chain numbers the gateway enforces. That prediction is " +
          "the difference between a demo of spending and a demo of a budget.",
      },
      {
        name: "automation needs a quote to repeat",
        good: /buyMode === "auto" && q/,
        fix:
          "The loop repeats THIS purchase at the seller's real price. Without a " +
          "quote there is no amount to project against and no offer to sign, so the " +
          "panel must not render and Start must stay disabled.",
      },
      {
        name: "own-wallet runs are honestly described as signed every time",
        good: /every run/,
        fix:
          "With the user's own wallet every run needs a signature. Say so, and offer " +
          "the demo agent for unattended runs - do not let the panel imply an agent " +
          "can spend repeatedly without the key holder.",
      },
      {
        name: "a missing Permit2 approval is fixable from this page",
        // Four separate facts, not one proximity match: the flag is derived near
        // the top of the component and the popup is mounted at the bottom, so any
        // "both within N chars" pattern would be wrong by construction.
        custom: (code) => {
          if (!/readAllowance/.test(code)) return "the MUSD-to-Permit2 allowance is never read";
          if (!/approvalNeeded/.test(code)) return "lost the derived `approvalNeeded` flag";
          if (!/<ApprovalModal[\s\/]/.test(code)) return "the approval popup is not mounted";
          if (!/onApproved/.test(code)) return "the popup's result is discarded instead of re-reading the allowance";
          return null;
        },
        fix:
          "Spend is where the refusal surfaces, so Spend is where the remedy must " +
          "be: read the MUSD-to-Permit2 allowance on mount, warn before the user " +
          "presses Pay, and open <ApprovalModal /> so they can grant it themselves " +
          "- for this payment only, or for all future ones. A page that can refuse " +
          "a payment but cannot enable one sends the user looking for a terminal. " +
          "Copy the current src/pages/Spend.jsx, src/components/ApprovalModal.jsx " +
          "and src/lib/permit2.js.",
      },
    ],
  },
  {
    file: "src/lib/x402-browser.js",
    why: "the browser half of an x402 payment",
    checks: [
      {
        name: "@x402 is imported dynamically, never statically",
        bad: /^\s*import\s[^;]*from\s*["']@x402/m,
        fix:
          "A top-level `import ... from \"@x402/fetch\"` pulls the whole SDK into the " +
          "initial graph. Vite's build then exhausts the sandbox's memory and hangs " +
          "rather than failing loudly. Every @x402 module here is loaded with " +
          "`await import(...)` inside the function that needs it.",
      },
      {
        name: "the scheme gets a signer whose signTypedData is bound to the wallet client",
        good: /signTypedData:\s*\(args\)\s*=>\s*walletClient\.signTypedData/,
        bad: /signer:\s*walletClient\.account\b/,
        fix:
          "createWalletClient({ account: ADDRESS }) yields a viem JSON-RPC account — " +
          "{ address, type }, data only. registerExactEvmScheme asks for " +
          "{ address, signTypedData }, so the quote succeeds, the wallet is connected, " +
          "and paying dies with `signer.signTypedData is not a function`. Bind the " +
          "methods on the CLIENT (see schemeSigner()); a privateKeyToAccount " +
          "LocalAccount already has them, which is why the gateway never hit this.",
      },
      {
        name: "signProbe hands back the header map the client named",
        good: /paymentHeaders/,
        fix:
          "encodePaymentSignatureHeader() returns a MAP, and the header NAME is part " +
          "of the protocol: v1 travels as X-PAYMENT, v2 as PAYMENT-SIGNATURE. Renaming " +
          "it to one hardcoded string means a v2 seller never sees the payment — it " +
          "answers 402 again, no MUSD moves, and it reads as a settlement failure. " +
          "Return the map alongside the raw value and let the relay forward it.",
      },
    ],
  },
  // Presence only — these are new enough that a stale checkout simply lacks them.
  {
    file: "src/lib/SessionLayer.jsx",
    why: "error boundary + lazy Privy",
    checks: [
      {
        // REVERSED ON PURPOSE. This pass used to REQUIRE a `hint` — copy explaining
        // what was loading. The decision changed: the pre-page indicator is the ring
        // and nothing else, because those words were guesses about which chunk was
        // slow. The information now lives on the pages that know what they await.
        name: "the pre-page boot state is the ring alone",
        good: /<BootScreen\s*\/>/,
        bad: /<BootScreen[\s\S]{0,200}?hint=|pulse-dot/,
        fix:
          "This fallback is the ONLY thing on screen while the wallet chunk loads, so " +
          "Render <BootScreen /> with no props: a centred ring carrying " +
          "role=status, aria-live and aria-label, so it is announced without " +
          "putting words on the screen. Copy the current src/lib/SessionLayer.jsx " +
          "and src/lib/RingSpinner.jsx.",
      },
    ],
  },
  { file: "src/lib/session.jsx", why: "SessionContext shape", checks: [] },
  { file: "src/lib/app-data.jsx", why: "AppDataProvider", checks: [] },
  { file: "src/lib/useReveal.jsx", why: "scroll-reveal utilities", checks: [] },
  { file: "src/pages/Diagnose.jsx", why: "live sign-in diagnostics at /diagnose", checks: [] },
  { file: "src/lib/evm-network.js", why: "wallet_switchEthereumChain / wallet_addEthereumChain state machine", checks: [] },
  { file: "src/lib/wallet-session.js", why: "shared SessionContext for external wallets", checks: [] },
  { file: "src/lib/wallet-choice.js", why: "provider precedence + VITE_WALLET_PROVIDER override", checks: [] },
  {
    file: "src/lib/WalletLayer.jsx",
    why: "lazy transport selection",
    checks: [
      {
        name: "its boot state is the shared BootScreen",
        good: /<BootScreen/,
        bad: /pulse-dot/,
        fix:
          "One loading indicator for the whole app: lib/RingSpinner.jsx. Two " +
          "hand-rolled fallbacks is how a pulsing dot survived in one of them.",
      },
    ],
  },
  {
    file: "src/lib/RingSpinner.jsx",
    why: "the one loading indicator (ring + boot screen)",
    checks: [
      {
        name: "the boot screen keeps an accessible name",
        good: /aria-label="Loading"/,
        fix:
          "Taking the words off the screen must not take the announcement with " +
          "them. role=status + aria-live + aria-label is what a screen reader gets " +
          "instead of silence — that is the only reason a text-free spinner is " +
          "acceptable.",
      },
      {
        name: "no copy renders inside the boot screen",
        bad: /BootScreen[\s\S]{0,400}?<p[\s>]/,
        fix:
          "The boot state is the ring, centred, and nothing else. If it needs to " +
          "say something it is the wrong component: put the words on the page that " +
          "knows what it is waiting for.",
      },
    ],
  },
  {
    file: "src/lib/agent-status.jsx",
    why: "shared useAgentStatus() + REASON_LABEL",
    checks: [
      {
        name: "the hook can be refreshed on demand",
        good: /refresh: read/,
        fix:
          "A payment changes these numbers NOW and a 10s poll notices later. The " +
          "automated-spending panel re-reads after every run, and a gauge that lags " +
          "the run it describes looks broken in a demo and misleads in production. " +
          "Lift the read out of the effect into a useCallback and return it. Copy " +
          "the current src/lib/agent-status.jsx.",
      },
    ],
  },
  {
    file: "src/lib/autopay.js",
    why: "the automated-spending state machine (pure, offline-tested)",
    checks: [
      {
        name: "the loop's stop rules live here, not in the page",
        good: /export function shouldContinue[\s\S]{0,2000}?halted_by_policy/,
        fix:
          "shouldContinue() decides from the RUN LOG whether to arm another timer, " +
          "and the same answer drives the Start/Stop button. Two sources of truth is " +
          "how a loop ends up running forever. Copy the current src/lib/autopay.js.",
      },
      {
        name: "the schedule is clamped, never trusted",
        good: /clampInt[\s\S]{0,400}?LIMITS/,
        fix:
          "An interval of 0 is a tight loop against a live seller and an unbounded " +
          "maxRuns is unbounded spend. Clamp on the way in and fall back to the " +
          "default on nonsense - never to zero.",
      },
      {
        name: "amounts stay BigInt wei",
        good: /movedWei: moved[\s\S]{0,80}?BigInt\(quoteWei\) : 0n/,
        bad: /movedWei: 0[,}\s]/,
        fix:
          "0.001 MUSD is 1000000000000000n. A Number here loses the exactness the " +
          "caps are enforced with, and a `0` instead of `0n` makes the log total " +
          "silently wrong rather than loudly broken.",
      },
      {
        name: "a refused run is not counted as spend",
        good: /outcome === OUTCOME.settled \|\| outcome === OUTCOME.charged/,
        fix:
          "movedWei is what actually left the wallet. Showing the attempted amount " +
          "as spent overstates the damage in exactly the situation where the user is " +
          "worried about damage - and hides the fact that a refusal costs nothing.",
      },
      {
        name: "the projection divides by nothing",
        good: /q > 0n && leftToday !== null \? leftToday \/ q : null/,
        fix:
          "Before a quote exists the amount is zero, and dividing by 0n throws a " +
          "BigInt division-by-zero that takes the whole Spend page down. Guard the " +
          "division and return null for 'nothing to project yet'.",
      },
      {
        // THE BUG THIS PINS. The contract's remainingToday is dailyCap - dayFunded:
        // funding headroom, not spending. Deriving spend from it produced a panel
        // that predicted a refusal on run 6 while eight live purchases went through
        // a five-purchase cap. Spend must arrive as an explicit argument.
        name: "spend is an input, never derived from the contract's funding field",
        good: /spentTodayWei !== null && spentTodayWei !== undefined/,
        bad: /spentToday = dailyCap > remainingToday|spentToday = BigInt\(status\.remainingToday\)/,
        fix:
          "budgetView() takes spentTodayWei from the gateway (which sums the " +
          "treasury's on-chain receipts) and reports status.remainingToday " +
          "separately as fundingHeadroomToday. Unknown spend must render as " +
          "'not read yet', never as zero.",
      },
      {
        name: "the contract's funding counter is exposed under its real name",
        good: /fundingHeadroomToday: BigInt\(status\.remainingToday/,
        fix:
          "The number is real and on-chain; only its label was wrong. Keep it " +
          "visible as funding headroom so no page shows it as money an agent may " +
          "still spend.",
      },
    ],
  },
  {
    file: "src/pages/Alerts.jsx",
    why: "Telegram alert binding at /alerts",
    checks: [
      {
        name: "the binding status is polled while a code is outstanding",
        good: /setInterval\(loadStatus/,
        fix:
          "The binding lands on the GATEWAY (its long-poll sees /start <code>), and " +
          "nothing tells this component. Without a poll the card keeps saying " +
          "\"not connected\" until the page is reloaded — after the user did exactly " +
          "what was asked of them.",
      },
      {
        name: "the poll stops when it lands or the code expires",
        good: /if \(!code\?\.code \|\| subscribed \|\| expired\) return;/,
        fix:
          "Poll only while there is something to wait for, and make the effect's " +
          "dependencies booleans that flip at most once — depending on `now` would " +
          "tear the interval down every second of the countdown and it would never " +
          "fire.",
      },
    ],
  },
  // ---- the approval path: the popup, its calldata, and the gas it needs ------
  {
    file: "src/lib/permit2.js",
    why: "the MUSD -> Permit2 approval a browser wallet signs",
    checks: [
      {
        name: "the approval goes out as a raw provider call",
        good: /eth_sendTransaction/,
        bad: /createWalletClient/,
        fix:
          "Do NOT build a viem wallet client to send this. viem runs " +
          "eth_getTransactionCount, eth_estimateGas and fee estimation first, and an " +
          "embedded provider that lacks any one of them fails BEFORE the user sees a " +
          "prompt - which reads as a broken button. Send { from, to, data } straight " +
          "to the EIP-1193 provider and let it fill in nonce and fees. Copy the " +
          "current src/lib/permit2.js.",
      },
      {
        name: "the tx carries no gas fields of its own",
        bad: /gasPrice|maxFeePerGas|maxPriorityFeePerGas|gasLimit|nonce:/,
        fix:
          "Same reason as above, from the other side: any fee or nonce value this " +
          "code supplies is one more RPC method the provider must support, and one " +
          "more way to fail before the prompt. The provider already knows the chain " +
          "it is on.",
      },
      {
        name: "the calldata is the ABI encoding of approve(spender, amount)",
        good: /encodeFunctionData\("approve"/,
        fix:
          "Hand-written calldata drifts silently. Encode it from the MUSD ABI so " +
          "the selector is whatever the compiler says it is.",
      },
      {
        name: "confirmation is polled, not awaited from tx.wait()",
        good: /function waitForAllowance/,
        bad: /waitForTransactionReceipt|\.wait\(/,
        fix:
          "On rpc.test.mezo.org a receipt can take minutes after the transaction has " +
          "confirmed - the approval popup would spin forever over a change that is " +
          "already on chain. Read the ALLOWANCE until it covers the amount, with a " +
          "bounded timeout.",
      },
      {
        name: "an unreadable allowance is not read as zero",
        good: /function readAllowance[\s\S]{0,600}?null/,
        fix:
          "readAllowance() returns null when the read fails and a BigInt when it " +
          "succeeds. Collapsing the two makes an RPC blip look like 'not approved' " +
          "and nags a wallet that is already fine.",
      },
    ],
  },
  {
    file: "src/components/ApprovalModal.jsx",
    why: "the popup that lets an ordinary user grant the allowance",
    checks: [
      {
        name: "every hook runs before the early return",
        custom: (code) => {
          const early = code.indexOf("if (!open) return null");
          if (early === -1) return "lost the `if (!open) return null` guard";
          const last = code.lastIndexOf("useState(");
          return last > early ? "a useState() runs after the early return" : null;
        },
        fix:
          "A modal that returns null while closed still has to call its hooks on " +
          "every render, in the same order. Any useState/useEffect below the early " +
          "return is a rules-of-hooks violation that throws the first time the " +
          "popup opens. Copy the current src/components/ApprovalModal.jsx.",
      },
      {
        name: "the user chooses between one payment and all future payments",
        good: /unlimited[\s\S]{0,2000}?amountWei/,
        fix:
          "Both scopes must be offered and explained in the user's own terms: " +
          "'this payment only' approves exactly the quoted amount, 'all future " +
          "payments' approves the maximum so no second popup is ever needed. " +
          "Neither is a default the user cannot change.",
      },
      {
        name: "the popup can get the gas the approval needs",
        good: /gasRequest\(/,
        fix:
          "A brand-new agent wallet holds MUSD and no native BTC, so approve() " +
          "fails on gas. The popup has to be able to request the capped drip " +
          "(server/gas.js) itself, or it is a button that fails with a Latin error.",
      },
      {
        name: "and it always shows the route that costs the operator nothing",
        good: /MEZO_BTC_FAUCET/,
        fix:
          "Mezo's own testnet BTC faucet is the alternative to the operator drip. " +
          "Show both: the drip is one click, the faucet keeps the operator's budget " +
          "intact.",
      },
      {
        name: "it never sends a user to a repo script",
        bad: /grant-permit2|node scripts\//,
        fix:
          "contract/scripts/grant-permit2.js needs a checkout and the wallet's " +
          "private key. No ordinary user has either. This component exists because " +
          "that advice was a dead end - do not reintroduce it, in prose or in a " +
          "button.",
      },
    ],
  },
  {
    file: "src/pages/Faucet.jsx",
    why: "the first thing a new user does",
    checks: [
      {
        name: "claiming MUSD leads into enabling payments",
        good: /<ApprovalModal[\s\/]/,
        fix:
          "After a successful claim the next step is the approval, then gas - both " +
          "handled in a popup, neither needing a terminal. Lead the success note " +
          "with 'Enable payments' rather than leaving the user to discover the " +
          "refusal on the Spend page. Copy the current src/pages/Faucet.jsx.",
      },
    ],
  },
  {
    file: "../server/gas.js",
    why: "the capped BTC drip the approval popup calls",
    checks: [
      {
        name: "no BigInt reaches res.json",
        good: /publicWallet/,
        bad: /\.\.\.wallet/,
        fix:
          "JSON.stringify THROWS on a BigInt, so spreading the wallet object into a " +
          "response 500s the endpoint with 'Do not know how to serialize a BigInt' - " +
          "the popup then cannot tell the user anything. Expose a serializable view " +
          "(publicWallet) and keep BigInts for internal maths. Copy the current " +
          "server/gas.js.",
      },
      {
        name: "'needs gas' is derived from the live cost, not guessed",
        good: /gasThreshold/,
        bad: /maxBalanceBtc/,
        fix:
          "A fixed threshold is a guess about a number the chain sets. At 146 " +
          "wei/gas an approval costs ~8.8e-12 BTC, so a hardcoded 0.0001 BTC " +
          "declared a wallet that had JUST been dripped 0.00005 BTC to still need " +
          "gas - the popup kept showing its red box after the drip landed. Derive it " +
          "as cost x safety factor, floored at an absolute minimum.",
      },
      {
        name: "only a registered agent wallet can ask for gas",
        good: /not_registered/,
        fix:
          "This spends the operator's BTC, so it is not an open faucet: the address " +
          "must already be a registered agent wallet. Everything else is capped too " +
          "- per-address cooldown, daily cap, total cap, and a reserve that keeps " +
          "the owner key able to pay for its own transactions.",
      },
      {
        name: "a drip is only sent to whoever signed for it",
        good: /verifyMessage/,
        fix:
          "The request carries a signature over a gateway-issued nonce and the " +
          "recovered address must equal the address being funded. Without that, " +
          "anyone could point the operator's BTC at any address.",
      },
    ],
  },
  {
    file: "../server/spend.js",
    why: "today's spend, summed from on-chain receipts",
    checks: [
      {
        name: "the day boundary is UTC, like the contract's",
        good: /86_400|86400/,
        fix:
          "The contract's _today() is block.timestamp / 1 days, i.e. UTC. A local " +
          "day boundary buckets receipts differently per timezone, so the same " +
          "daily cap would mean different things in Lagos and Berlin.",
      },
      {
        name: "an unreadable receipt window is never read as zero spend",
        good: /truncated/,
        fix:
          "If every receipt in the window is from today, the window was too small " +
          "and the sum is a LOWER BOUND. Say so: the gateway refuses rather than " +
          "pretend the budget is intact.",
      },
      {
        name: "the scan stops at yesterday only when the list is newest-first",
        good: /newestFirst/,
        fix:
          "paymentsByAgent() returns newest first, so breaking at the first old " +
          "receipt is correct and cheap. If a caller ever passes the other order, " +
          "breaking early silently under-counts spend - detect the order first.",
      },
    ],
  },
  {
    file: "../server/agent-gateway.js",
    why: "the policy engine and what it tells a user to do",
    checks: [
      {
        name: "the approval refusal carries a machine-readable action",
        good: /action: "approve_permit2"/,
        fix:
          "The UI branches on this to offer the popup. A refusal with only prose " +
          "cannot be acted on by the thing the user is looking at.",
      },
      {
        // The daily cap used to be compared against the contract's funding counter,
        // which nothing in the payment path ever moves: eight live purchases of
        // 0.001 MUSD went through a 0.005 MUSD cap without one refusal.
        name: "the daily cap is judged against spend, not against funding",
        good: /judgeDailySpend\(/,
        bad: /amount > BigInt\(s\.remainingToday\)/,
        fix:
          "remainingToday is dailyCap - dayFunded: how much more FLOAT the treasury " +
          "may release today. Spend comes from spentTodayWei(), which sums the " +
          "treasury's own payment receipts. Copy the current server/spend.js and " +
          "server/agent-gateway.js.",
      },
      {
        name: "an unreadable spend figure fails closed",
        good: /spend_read_failed/,
        fix:
          "If the receipts cannot be read, the cap cannot be checked. 'Could not " +
          "read the budget' must never be treated as 'no budget'.",
      },
      {
        name: "and its first advice is inside the app",
        good: /Enable payments/,
        fix:
          "The old text was 'fix with: cd contract && node scripts/grant-permit2.js' " +
          "- a developer command. Tell the user what to click first; mention the " +
          "operator script only as a last resort for someone who holds the key.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // THE DESIGN SYSTEM (lucide icons, the type scale, the charts).
  //
  // These are not cosmetic checks dressed up as tests. Each one pins a decision
  // that is invisible when it is present and obvious when it regresses — and
  // every one of them was a real defect in an earlier revision of these files:
  //
  //   • a white border flashing around the boot spinner (an unstyled <html>
  //     before the stylesheet arrives)
  //   • 12px body copy, and #616c7e "muted" text that measured ~3.4:1 against
  //     the panel background — below WCAG AA for normal text
  //   • an AddressLink that was a single <a target=_blank>, so clicking it
  //     navigated away AND copied to the clipboard invisibly
  //   • two side-by-side aria-pressed buttons where a radiogroup belonged, so
  //     arrow keys did nothing and a screen reader announced "2 of 2 buttons"
  //   • a chart that drew a flat zero line for "no data yet", which on a fresh
  //     deployment reads as "this protocol is dead"
  // -------------------------------------------------------------------------
  {
    file: "index.html",
    why:
      "The pre-hydration shell. A white flash around the spinner is the first " +
      "thing a visitor sees, and it happens before any React code runs, so it can " +
      "only be fixed here.",
    checks: [
      {
        name: "the document is dark before any stylesheet loads",
        // Inline on BOTH elements: <html> paints first, and <body> covers the
        // case where a UA applies its own background to the body box.
        good: /<html[^>]*style="[^"]*background-color:#080a10[\s\S]*?<body[^>]*style="[^"]*background-color:#080a10/,
        fix:
          "Recopy frontend/index.html. Without an inline background the browser " +
          "paints white around the boot spinner until index.css arrives — the " +
          "flash at the top, left and right of the page.",
      },
      {
        name: "the boot spinner is a ring and carries no text",
        good: /af-spin/,
        // Standing instruction: the pre-page indicator shows ONLY the ring. Any
        // copy here ("Loading…", "Starting gateway…") reverts that decision.
        bad: /id="boot-caption"|Loading AgentFloat|Starting gateway/,
        fix:
          "The boot indicator must be the ring alone — no words. Recopy " +
          "frontend/index.html; boot-screen copy was removed deliberately.",
      },
      {
        name: "the flash fix respects reduced-motion",
        good: /prefers-reduced-motion/,
        fix:
          "The keyframes in index.html need a prefers-reduced-motion override, or " +
          "the spinner spins for users who asked the OS not to animate. Recopy " +
          "frontend/index.html.",
      },
    ],
  },
  {
    file: "src/index.css",
    why:
      "The type scale and the contrast tokens. Every page inherits these, so a " +
      "stale stylesheet is a whole-app regression that no single page check sees.",
    checks: [
      {
        name: "body copy is 15px, not the old 12–13px",
        good: /font-size:\s*15px/,
        fix:
          "Recopy frontend/src/index.css. The scale was raised so body copy is " +
          "15px; anything at 12px is a caption, not prose.",
      },
      {
        name: "the muted/dim/faint contrast ramp exists",
        good: /--color-faint:/,
        fix:
          "Recopy frontend/src/index.css. --color-muted was lifted to ~9.4:1 and " +
          "--color-dim to ~7.7:1 against the panel, and --color-faint was added " +
          "for rules and de-emphasised labels only. A stale sheet ships text " +
          "below WCAG AA.",
      },
      {
        name: "the ring spinner keyframes are still defined",
        // \b: /.ring-spin/ also matches .ring-spinX, so renaming the class away
        // looked like a pass.
        good: /\.ring-spin\b/,
        fix:
          "Recopy frontend/src/index.css. .ring-spin is used by Navbar, Spend, " +
          "Operate and ApprovalModal; losing it leaves a static icon where a " +
          "busy state should be.",
      },
      {
        name: "animations are disabled under reduced-motion",
        good: /prefers-reduced-motion/,
        fix:
          "Recopy frontend/src/index.css. The reduced-motion block must name " +
          "ring-spin and the draw/grow/shimmer animations.",
      },
      {
        name: "a visible focus ring is defined globally",
        good: /:focus-visible\b/,
        fix:
          "Recopy frontend/src/index.css. Keyboard users need the 2px ring; " +
          "without it the new Segmented control is unusable without a mouse.",
      },
    ],
  },
  {
    file: "src/components/ui.jsx",
    why:
      "The shared primitives. Every page renders through these, so a regression " +
      "here is a regression everywhere — and two of them were genuine " +
      "accessibility bugs, not styling choices.",
    checks: [
      {
        name: "Segmented is a real radiogroup",
        good: /role="radiogroup"[\s\S]{0,2000}?role="radio"/,
        fix:
          "Recopy frontend/src/components/ui.jsx. Segmented replaced two " +
          "aria-pressed buttons: it needs role=radiogroup, one role=radio per " +
          "option and aria-checked. Keyboard handling is asserted separately " +
          "below — a radiogroup that ignores arrow keys announces correctly and " +
          "still cannot be used without a mouse.",
      },
      {
        // Asserted on its own because the role check above passed with the
        // keyboard handler deleted: correct semantics, unusable control.
        name: "Segmented can be driven by the keyboard",
        good: /onKeyDown[\s\S]{0,900}?ArrowRight\b[\s\S]{0,300}?ArrowLeft\b|ArrowLeft\b[\s\S]{0,900}?ArrowRight\b/,
        fix:
          "Recopy frontend/src/components/ui.jsx. Segmented must handle " +
          "ArrowLeft/ArrowRight (and Home/End) on its radiogroup. Without that the " +
          "control is mouse-only, and the roles asserted by the check above then " +
          "promise keyboard support the component does not deliver.",
      },
      {
        name: "AddressLink copies AND links, as two separate controls",
        // The old version was one <a target=_blank> whose onClick also copied:
        // the user got navigated to the explorer and never saw the confirmation.
        bad: /function AddressLink[\s\S]{0,900}?<a[^>]*target="_blank"[^>]*onClick=\{[^}]*copyText/,
        fix:
          "Recopy frontend/src/components/ui.jsx. AddressLink must be a copy " +
          "<button> plus a separate explorer <a>; one element doing both " +
          "navigates away and swallows the copy confirmation.",
      },
      {
        name: "Meter exposes its value to assistive tech",
        // ONE regex requiring both, not two alternatives joined by `|`: with an
        // OR, dropping the role still passes on the strength of aria-valuenow,
        // and the check silently stops checking the thing that was removed.
        good: /function Meter[\s\S]{0,1400}?role="(meter|progressbar)"[\s\S]{0,400}?aria-valuenow/,
        fix:
          "Recopy frontend/src/components/ui.jsx. Meter is a value, so it needs " +
          "a meter/progressbar role and aria-valuenow — a coloured div alone is " +
          "invisible to a screen reader.",
      },
    ],
  },
  {
    file: "src/lib/charts-data.js",
    why:
      "The arithmetic behind every chart, and the module that must agree with " +
      "server/spend.js about which day a receipt belongs to.",
    checks: [
      {
        name: "buckets are UTC days, matching the daily cap's boundary",
        // Both halves, because either alone is satisfiable by the wrong code: a
        // DAY constant with no flooring is a label, and a floor with a
        // local-midnight size is a local-time bucket that looks identical.
        // The `;` matters: without it the pattern is a prefix match, so
        // `const DAY = 86400 + getTimezoneOffset()*60` — a genuine local-time
        // bucket — still satisfies it.
        good: /const DAY = 86400;[\s\S]{0,2000}?Math\.floor\(t \/ size\) \* size/,
        fix:
          "Recopy frontend/src/lib/charts-data.js. The day boundary must be " +
          "floor(t/86400)*86400 — identical to dayStartSec() in server/spend.js, " +
          "which is what the daily cap is enforced on. A local-time bucket makes " +
          "the chart contradict the refusal.",
      },
      {
        name: "amounts are accumulated as BigInt, never as Numbers",
        // Assert the accumulation itself. A bare /BigInt/ good-pattern is
        // satisfied by any BigInt anywhere in the file, and a bad-pattern naming
        // `amountWei` missed the real loop, whose variable is called `raw`.
        good: /\+= BigInt\(/,
        bad: /\+= Number\(|\+= parseFloat\(/,
        fix:
          "Recopy frontend/src/lib/charts-data.js. 18-decimal wei values lose " +
          "precision as Numbers; bucketSeries must accumulate BigInt.",
      },
      {
        name: "empty buckets are kept, not compacted away",
        good: /contiguous|for \(let t = start/i,
        fix:
          "Recopy frontend/src/lib/charts-data.js. Dropping empty buckets draws a " +
          "three-day gap as two adjacent bars, claiming activity was continuous " +
          "when it was not.",
      },
    ],
  },
  {
    file: "src/components/charts.jsx",
    why:
      "The renderers. One rule matters more than the styling: never draw a chart " +
      "that implies data which does not exist.",
    checks: [
      {
        // Split from one OR'd check: `/minPoints|ChartEmpty/` still passed after
        // either was deleted, because the other half matched. Two guarantees, two
        // checks, two different failure messages.
        name: "a series is only drawn as a line from two points up",
        good: /minPoints\b/,
        fix:
          "Recopy frontend/src/components/charts.jsx. Sparkline needs its " +
          "minPoints guard: with 0 or 1 buckets the path is a flat zero line, " +
          "which on a fresh deployment reads as 'this protocol is dead'.",
      },
      {
        name: "an empty series renders words, not an empty axis",
        good: /ChartEmpty\b/,
        fix:
          "Recopy frontend/src/components/charts.jsx. ChartEmpty is the component " +
          "that says 'no payments recorded yet' / 'one data point so far' instead " +
          "of drawing an axis with nothing on it.",
      },
      {
        name: "the axes are labelled UTC",
        good: /UTC/,
        fix:
          "Recopy frontend/src/components/charts.jsx. Buckets are UTC; a label " +
          "that omits it invites the reader to assume their own timezone.",
      },
      {
        name: "SVG strokes scale with the container, not with the viewBox",
        // Both halves in one match: the attribute alone is satisfiable with any
        // value, and the value alone could sit on an unrelated element.
        good: /vector-effect[\s\S]{0,40}?non-scaling-stroke/,
        fix:
          "Recopy frontend/src/components/charts.jsx. preserveAspectRatio=none " +
          "stretches the path, so without non-scaling-stroke the line thickness " +
          "varies with the panel width.",
      },
    ],
  },
  {
    file: "src/components/Analytics.jsx",
    why:
      "The dashboard's analytics. It renders twice — once for the signed-in " +
      "wallet, once for the whole protocol — from one component.",
    checks: [
      {
        name: "one panel serves both scopes",
        good: /scope\s*===\s*"you"|scope = "you"|scope === 'you'/,
        fix:
          "Recopy frontend/src/components/Analytics.jsx. 'Your activity' and " +
          "'Protocol activity' must be the same component with different inputs; " +
          "two hand-written versions drift until they contradict each other.",
      },
      {
        name: "every figure comes from activitySummary, never from JSX maths",
        good: /activitySummary\(/,
        fix:
          "Recopy frontend/src/components/Analytics.jsx. The KPIs must come from " +
          "activitySummary() in lib/charts-data.js, which npm run test:charts " +
          "covers. Computing them in JSX puts untested arithmetic on the page a " +
          "judge opens first.",
      },
      {
        name: "the record window is stated, not implied to be all history",
        // \b, because /windowNote/ also matches windowNoteGone: an identifier
        // pattern without a boundary passes when the thing is merely renamed,
        // which is exactly how a check stops checking.
        good: /windowNote\b/,
        fix:
          "Recopy frontend/src/components/Analytics.jsx. /api/chain-records is " +
          "capped at 100, so the panel must say how many receipts it read. A " +
          "truncated series that looks complete is a lie with a gradient on it.",
      },
    ],
  },
  {
    file: "src/lib/gateway.js",
    why:
      "A gateway deployed with GATEWAY_ADMIN_TOKEN refuses owner commands, and " +
      "the client has to explain that instead of showing a raw 403.",
    checks: [
      {
        name: "the client can tell a locked gateway from a broken one",
        good: /isAdminLocked[\s\S]{0,400}?admin_locked/,
        fix:
          "Recopy frontend/src/lib/gateway.js. It must export isAdminLocked() and " +
          "ADMIN_TOKEN_CONFIGURED so Operate can predict the 403 from /api/health " +
          "rather than discovering it on click.",
      },
      {
        name: "a cross-origin failure names the allowlist variable",
        good: /GATEWAY_ALLOWED_ORIGINS/,
        fix:
          "Recopy frontend/src/lib/gateway.js. When the frontend is on Vercel and " +
          "the gateway on Render, a blocked preflight surfaces as 'Failed to " +
          "fetch'. The message has to name GATEWAY_ALLOWED_ORIGINS or the " +
          "operator hunts through Render logs.",
      },
    ],
  },
  {
    file: "src/pages/Operate.jsx",
    why:
      "The owner controls. On a deployed gateway the pause button cannot work " +
      "from a browser, and saying so up front beats a dead click.",
    checks: [
      {
        name: "a locked gateway is surfaced, not swallowed as a generic failure",
        // Must be DERIVED FROM HEALTH. `admin_locked` alone also matches the
        // explanation prose, so a page that only reacts after a failed click
        // would pass — and reacting after the click is the dead-button bug.
        good: /deployment\?\.adminLocked|deployment\.adminLocked/,
        fix:
          "Recopy frontend/src/pages/Operate.jsx. When /api/health reports " +
          "deployment.adminLocked, the gateway pause must be disabled with an " +
          "explanation and must point at the on-chain pause instead.",
      },
      {
        name: "the locked case still points at the on-chain remedy",
        good: /ADMIN_LOCKED_DETAIL/,
        fix:
          "Recopy frontend/src/pages/Operate.jsx. The explanation has to say that " +
          "VITE_GATEWAY_ADMIN_TOKEN ships in the bundle and so is not a lock, and " +
          "offer the treasury's pause() as the authority that survives a restart.",
      },
    ],
  },
  {
    file: "../server/agent-gateway.js",
    why:
      "The deployed gateway. Two of these are security boundaries that a " +
      "hand-copied stale file silently removes.",
    checks: [
      {
        name: "a wildcard origin matches a SUBDOMAIN, never the shared apex",
        // `*.` compiles to (?:[a-z0-9-]+\.)+ — one-or-more labels. With `*` it
        // also matched https://vercel.app itself, i.e. every stranger's Vercel
        // deploy could call a gateway holding a signing key.
        // A custom check, not a regex: the source literal is "(?:[a-z0-9-]+\\.)+",
        // i.e. it contains escaped backslashes, and a regex for that is four
        // levels of escaping deep — unreadable and easy to get subtly wrong (this
        // one was). Plain string matching says the same thing clearly.
        //
        // What distinguishes safe from unsafe is the quantifier on the label
        // group: `)+` requires at least one label before the apex, `)*` also
        // matches the bare apex itself.
        custom: (code) => {
          const i = code.indexOf("function compileOrigin");
          if (i < 0) return "compileOrigin() is missing entirely";
          const fn = code.slice(i, i + 900);
          if (!fn.includes("[a-z0-9-]+")) return "the label character class changed";
          if (fn.includes(')*"')) return "the label group repeats ZERO-or-more times, which also matches the bare apex";
          if (!fn.includes(')+"')) return "the label group is not repeated one-or-more times";
          return null;
        },
        fix:
          "Recopy server/agent-gateway.js. In compileOrigin(), `*.` must compile " +
          "to (?:[a-z0-9-]+\\.)+ — a PLUS. With `*` it also accepts the bare " +
          "apex (https://vercel.app), so any stranger's deploy on that domain can " +
          "call a gateway that holds a signing key. Pinned by npm run test:deploy.",
      },
      {
        // Attached to BOTH routes, not merely defined: a guard that exists but is
        // not in the handler chain is the same as no guard, and grepping for the
        // name alone cannot tell those apart.
        name: "/api/pause is behind the admin guard",
        good: /app\.post\(\s*"\/api\/pause",\s*requireAdmin/,
        fix:
          "Recopy server/agent-gateway.js. requireAdmin must be in the handler " +
          "chain for /api/pause, or a publicly bound gateway can be paused by " +
          "anyone who can reach it — a one-line denial of service.",
      },
      {
        name: "/api/unpause is behind the admin guard",
        good: /app\.post\(\s*"\/api\/unpause",\s*requireAdmin/,
        fix:
          "Recopy server/agent-gateway.js. requireAdmin must guard /api/unpause " +
          "too: an attacker who can resume a paused gateway can also resume one " +
          "they paused, and hide the outage.",
      },
    ],
  },
];

let failures = 0;
let warnings = 0;
let passed = 0;
const bad = (m) => { failures++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const warn = (m) => { warnings++; console.log(`  \x1b[33m!\x1b[0m ${m}`); };

console.log(`\n== source integrity ==============================================`);
console.log(`  checking ${ROOT}\n`);

// ---------------------------------------------------------------------------
// PRE-PASS: does every module still parse?
//
// This runs BEFORE the pattern checks, and not as a courtesy. Every check below
// greps source text, and grep over a file with a syntax error produces answers
// that look authoritative and are not: a truncated brace can make a "good"
// pattern match text that could never execute, so the suite reports ✓ on a file
// that will not build. Parse first, pattern-check second.
//
// It is also the cheapest possible build gate. `npm run build` is deliberately
// never run here (it has OOM-killed the sandbox), and the dev server only
// surfaces an error for a module once something imports it — which is after you
// have started a gateway, opened a browser and clicked through to the page. This
// catches it in ~200ms with no server running at all.
//
// esbuild is Vite's own transformer, so this reports exactly what the dev server
// would. It is a transitive dependency, so the import is guarded: if it is ever
// unavailable the pass warns and steps aside rather than failing a suite whose
// real job is checking patterns.
// ---------------------------------------------------------------------------
{
  let transformSync = null;
  try {
    ({ transformSync } = await import("esbuild"));
  } catch {
    warn("esbuild unavailable — skipping the parse pre-pass (run `npm --prefix frontend install`)");
  }

  if (transformSync) {
    const srcDir = path.join(ROOT, "src");
    const queue = [srcDir];
    const files = [];
    while (queue.length) {
      const dir = queue.pop();
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) queue.push(abs);
        else if (/\.(jsx?|mjs)$/.test(ent.name)) files.push(abs);
      }
    }

    const broken = [];
    for (const abs of files) {
      const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
      try {
        transformSync(fs.readFileSync(abs, "utf8"), { loader: abs.endsWith(".jsx") ? "jsx" : "js" });
      } catch (e) {
        broken.push({ rel, errors: (e.errors || []).slice(0, 3) });
      }
    }

    if (!broken.length) {
      ok(`all ${files.length} src modules parse cleanly (esbuild, same transformer as Vite)`);
    } else {
      for (const b of broken) {
        bad(`${b.rel} — DOES NOT PARSE`);
        for (const err of b.errors) {
          const loc = err.location ? `line ${err.location.line}:${err.location.column}` : "";
          console.log(`      ${err.text}${loc ? ` (${loc})` : ""}`);
          if (err.location?.lineText) console.log(`      \x1b[90m${err.location.lineText.trim().slice(0, 110)}\x1b[0m`);
        }
        console.log(`      A module that does not parse renders nothing. The usual cause here is a`);
        console.log(`      {/* comment */} placed inside a prop's {…} expression — that container is`);
        console.log(`      JavaScript, and JSX comment syntax is only valid between elements.`);
      }
    }
  }
}


// Merge entries that target the same file before reporting.
//
// Four files had two entries each (the design-system checks were added later than
// the originals), and the loop printed two separate "✓ file — all N checks" lines
// for each. For a tool whose whole job is telling someone which file to recopy,
// ambiguous output about what was checked is worse than no output: a reader
// scanning for "src/components/ui.jsx" sees two lines and cannot tell whether
// that is two files, two passes, or one pass reported twice.
//
// Merging here rather than in the data also means a future duplicate cannot
// reintroduce the ambiguity.
const MERGED = [];
const BY_FILE = new Map();
for (const entry of CHECKS) {
  const prev = BY_FILE.get(entry.file);
  if (prev) {
    prev.checks.push(...entry.checks);
    if (entry.why && !prev.why.includes(entry.why)) prev.why = `${prev.why} ${entry.why}`;
    continue;
  }
  const clone = { ...entry, checks: [...entry.checks] };
  BY_FILE.set(entry.file, clone);
  MERGED.push(clone);
}
if (MERGED.length !== CHECKS.length) {
  console.log(`  \x1b[90m(${CHECKS.length} check groups merged into ${MERGED.length} files)\x1b[0m\n`);
}

// ---------------------------------------------------------------------------
// PRE-PASS 2: is the INSTALLED dependency the DECLARED one?
//
// This exists because of a specific, expensive failure. @privy-io/react-auth was
// declared as "^3.50.0". Someone deleted node_modules AND package-lock.json and
// reinstalled — a completely reasonable thing to do when a login modal misbehaves
// — and npm resolved 3.51.0. The app then failed with `exited_auth_flow`: Privy's
// modal opened, spun, closed itself, and left the page blurred. Nothing in this
// repository had changed. The dependency had.
//
// Every other check in this file greps source, and source was correct, so all of
// them passed while sign-in was broken. A stale-file checker that cannot see the
// dependency tree cannot catch the one stale thing that matters most.
//
// Two assertions, because there are two ways to drift:
//   • declared spec carries a caret/tilde → the next reinstall can move it again
//   • installed version != declared version → it already moved
//
// Offline. Reads package.json and node_modules only; no registry, no network.
// ---------------------------------------------------------------------------
{
  // Auth- and routing-critical: a silent minor bump in any of these changes
  // observable behaviour. Icon and utility libraries are deliberately absent —
  // pinning everything would make this check noisy about things that cannot
  // break sign-in.
  const CRITICAL = [
    "@privy-io/react-auth",
    "@reown/appkit",
    "@reown/appkit-adapter-ethers",
    "react",
    "react-dom",
    "react-router-dom",
    "viem",
  ];

  let declared = {};
  try {
    declared = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).dependencies || {};
  } catch (e) {
    bad(`frontend/package.json could not be read (${e.message})`);
  }

  let drift = 0;
  let loose = 0;
  for (const name of CRITICAL) {
    const spec = declared[name];
    if (!spec) {
      bad(`${name} is not declared in frontend/package.json`);
      console.log(`      It is auth- or routing-critical; a missing declaration means npm resolves it`);
      console.log(`      from a transitive parent, which is not a version anyone chose.`);
      drift++;
      continue;
    }
    if (/^[\^~]/.test(spec)) {
      bad(`${name} is declared loosely as "${spec}"`);
      console.log(`      Pin it exactly (no ^ or ~). A caret let a lockfile deletion move`);
      console.log(`      @privy-io/react-auth 3.50.0 -> 3.51.0, which broke the login modal with`);
      console.log(`      exited_auth_flow while nothing in this repo had changed.`);
      loose++;
      continue;
    }

    let installed = null;
    try {
      installed = JSON.parse(
        fs.readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8")
      ).version;
    } catch {
      installed = null;
    }

    if (installed === null) {
      warn(`${name}@${spec} is not installed`);
      console.log(`      Run: npm --prefix frontend install`);
    } else if (installed !== spec) {
      bad(`${name}: installed ${installed}, package.json pins ${spec}`);
      console.log(`      This is the failure that produces a login modal which opens, spins, closes`);
      console.log(`      itself and reports exited_auth_flow. Reinstall the pinned version:`);
      console.log(`        npm --prefix frontend install ${name}@${spec} --save-exact`);
      console.log(`      then clear the prebundle and restart:`);
      console.log(`        rmdir /s /q frontend\\node_modules\\.vite`);
      drift++;
    }
  }

  if (!drift && !loose) {
    const n = CRITICAL.filter((c) => declared[c]).length;
    ok(`${n} auth-critical dependencies are pinned exactly and match what is installed`);
  }
}

for (const entry of MERGED) {
  const abs = path.join(ROOT, entry.file);
  let raw;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch {
    bad(`${entry.file} — MISSING (${entry.why})`);
    console.log(`      Recopy this file. Everything that imports it will fail to resolve.`);
    continue;
  }

  const code = stripComments(raw);
  const results = [];

  for (const chk of entry.checks) {
    let failure = null;
    if (chk.custom) failure = chk.custom(code);
    else if (chk.bad && chk.bad.test(code)) failure = "pattern found";
    else if (chk.good && !chk.good.test(code)) failure = "expected pattern absent";

    if (failure) {
      bad(`${entry.file} — ${chk.name}`);
      console.log(`      \x1b[90m${failure}\x1b[0m`);
      console.log(`      ${chk.fix}`);
    } else {
      results.push(chk.name);
    }
  }

  if (entry.checks.length === 0) {
    ok(`${entry.file} present`);
  } else if (results.length === entry.checks.length) {
    ok(`${entry.file} — all ${results.length} checks`);
  } else if (results.length) {
    warn(`${entry.file} — ${results.length}/${entry.checks.length} checks passed`);
  }
}

console.log(
  `\n${failures ? `❌ ${failures} stale file pattern(s)` : "✅ frontend source is current"}` +
    `${warnings ? `, ${warnings} partial` : ""}, ${passed} passed\n`
);
if (failures) {
  console.log(`  Every failure above names the file to recopy. After copying, clear`);
  console.log(`  frontend\\node_modules\\.vite and restart the dev server.\n`);
}
process.exit(failures ? 1 : 0);
