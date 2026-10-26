// ---------------------------------------------------------------------------
// check-privy-config — verify the Privy app itself is configured for AgentFloat
//
//   npm run check:privy
//   npm run check:privy -- --app-id cmxxxxxxxxxxxxxxxxxxxxxxx
//
// WHY THIS EXISTS
//   Almost everything that goes wrong with Privy here is invisible in the code:
//   the App ID can be perfectly valid while the *app behind it* refuses to create
//   wallets or offer the login method you asked for. The client SDK reports none
//   of it — the modal just opens, spins, and closes.
//
//   Privy exposes the effective configuration at
//     GET https://auth.privy.io/api/v1/apps/{appId}
//   with the app id in a `privy-app-id` header. This script reads it and asserts
//   the four things AgentFloat depends on, so a broken sign-in is diagnosed in
//   one command instead of by reading a console.
//
//   It needs no browser and no user interaction. Exit code is 1 if anything
//   required is wrong.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(HERE, "..", ".env");
const API = "https://auth.privy.io/api/v1/apps";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

function readAppId() {
  const explicit = flag("app-id");
  if (explicit) return explicit.trim();
  const fromEnv = process.env.VITE_PRIVY_APP_ID;
  if (fromEnv) return fromEnv.trim();
  try {
    const m = fs.readFileSync(ENV_FILE, "utf8").match(/^VITE_PRIVY_APP_ID=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim();
  } catch {
    /* no .env */
  }
  return null;
}

let failures = 0;
let warnings = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };
const warn = (m) => { warnings++; console.log(`  \x1b[33m!\x1b[0m ${m}`); };
const info = (m) => console.log(`  \x1b[90m·\x1b[0m ${m}`);

const appId = readAppId();
if (!appId) {
  console.error("\n❌ No App ID. Put VITE_PRIVY_APP_ID in frontend/.env or pass --app-id.\n");
  process.exit(1);
}

console.log(`\n== Privy app config ============================================`);
console.log(`  app id   ${appId}`);

let cfg;
try {
  const res = await fetch(`${API}/${appId}`, {
    headers: { "privy-app-id": appId, "User-Agent": "agentfloat-check/1.0" },
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`\n❌ Privy rejected the App ID (HTTP ${res.status}):`);
    console.error(`   ${body.slice(0, 300)}`);
    console.error(`   A 400 with code missing_or_invalid_privy_app_id means the id is wrong.\n`);
    process.exit(1);
  }
  cfg = JSON.parse(body);
} catch (e) {
  console.error(`\n❌ Could not reach ${API}: ${e.message}\n`);
  process.exit(1);
}

console.log(`  name     ${cfg.name || "(unnamed)"}\n`);

// --- 1. embedded wallets must be created on login -------------------------
// Without this a user signs in successfully and gets NO agent wallet, which is
// the entire product.
//
// IMPORTANT: this is a CLIENT-side setting, not a dashboard one. Per Privy's
// docs it lives at config.embeddedWallets.ethereum.createOnLogin and defaults to
// "off". The value the app-config API returns is therefore just that default —
// it is not an override and it does NOT reflect what the SDK will do at runtime.
// Treating the API value as authoritative here would be a false alarm, so the
// real check is against our own source file.
//
// The un-nested spelling `embeddedWallets.createOnLogin` is not in the SDK 3.x
// config type at all, so it is silently dropped and falls back to "off" — that
// was an actual bug in this repo.
const CLIENT_CFG = path.resolve(HERE, "..", "src", "lib", "privy.js");
const apiCreateOnLogin = cfg.embedded_wallet_config?.ethereum?.create_on_login
  ?? cfg.embedded_wallet_config?.create_on_login;

try {
  const src = fs.readFileSync(CLIENT_CFG, "utf8");
  const at = src.indexOf("embeddedWallets");
  const block = at >= 0 ? src.slice(at, at + 700) : "";
  const nested = /ethereum:\s*\{[^}]*?createOnLogin:\s*["'](all-users|users-without-wallets)["']/s.exec(block);

  if (nested) {
    ok(`embeddedWallets.ethereum.createOnLogin = "${nested[1]}" (src/lib/privy.js)`);
  } else if (/createOnLogin:\s*["'](all-users|users-without-wallets)["']/.test(block)) {
    bad(`createOnLogin is set but NOT nested under embeddedWallets.ethereum.`);
    console.log(`      SDK 3.x ignores the un-nested spelling and falls back to "off", so users`);
    console.log(`      sign in and receive no agent wallet. Move it to:`);
    console.log(`        embeddedWallets: { ethereum: { createOnLogin: "all-users" } }`);
  } else {
    bad(`no usable embeddedWallets.ethereum.createOnLogin found in src/lib/privy.js.`);
    console.log(`      Users would sign in and get NO agent wallet. Set it to "all-users".`);
  }
} catch {
  warn(`could not read ${CLIENT_CFG} to verify createOnLogin.`);
}
info(`API reports create_on_login = "${apiCreateOnLogin}" — that is the default, not an override.`);

// --- 2. smart wallets must be OFF ----------------------------------------
// x402 on Mezo authorizes with an EIP-712 permit2 signature. Only an EOA can
// produce one. Smart wallets (and Privy gas sponsorship, which delegates the
// wallet via EIP-7702) give the address contract code and force ERC-1271 mode,
// which the x402 client does not use — every payment would fail.
if (cfg.smart_wallet_config?.enabled === false) {
  ok("smart wallets disabled (required — agent wallets must stay EOAs for permit2)");
} else {
  bad("smart wallets are ENABLED — EIP-7702 delegation breaks x402 permit2 signing.");
  console.log(`      Turn them off in the Privy dashboard. Do the same for gas sponsorship.`);
}

// --- 3. login methods -----------------------------------------------------
const methods = [];
if (cfg.email_auth) methods.push("email");
if (cfg.google_oauth) methods.push("google");
if (cfg.wallet_auth) methods.push("wallet");
if (cfg.sms_auth) methods.push("sms");
if (cfg.passkey_auth) methods.push("passkey");

if (cfg.google_oauth) ok("Google OAuth enabled");
else bad("Google OAuth is DISABLED — the modal will not offer it, though the app requests it.");

if (cfg.email_auth) ok("Email (OTP) login enabled");
else warn("Email login disabled — Google becomes the only web2 method.");

if (cfg.wallet_auth) ok("External wallet login enabled (the treasury operator needs this)");
else warn("External wallet login disabled — the operator cannot connect MetaMask to reach owner controls.");

if (!methods.length) bad("No login methods enabled at all — Privy requires at least one.");
info(`effective login methods: ${methods.join(", ") || "none"}`);

// --- 4. allowed domains ---------------------------------------------------
// An empty list is Privy's permissive default (any origin). Once populated, the
// served iframe enforces frame-ancestors against it, so a missing origin makes
// the modal fail to load.
const domains = cfg.allowed_domains || [];
const wanted = ["http://localhost:5173", "http://127.0.0.1:5173"];
if (domains.length === 0) {
  warn("allowed_domains is empty — permissive default, any origin is accepted.");
  console.log(`      Fine for development. Set it before deploying publicly.`);
} else {
  const missing = wanted.filter((w) => !domains.includes(w));
  if (missing.length === 0) ok(`allowed_domains covers local dev: ${domains.join(", ")}`);
  else warn(`allowed_domains is set but missing ${missing.join(", ")} — sign-in will fail from those origins.`);
  info(`allowed_domains: ${domains.join(", ")}`);
}

// --- informational --------------------------------------------------------
if (cfg.enforce_wallet_uis) {
  info("enforce_wallet_uis = true: Privy shows its own confirmation modal for each");
  info("  signature, overriding the app's showWalletUIs:false. Expected for a demo;");
  info("  turn off 'Add confirmation modals' in the dashboard for unattended signing.");
}
if (cfg.embedded_wallet_config?.mode) info(`embedded wallet mode: ${cfg.embedded_wallet_config.mode}`);

console.log(`\n${failures ? `❌ ${failures} problem(s)` : "✅ Privy app config is correct"}${warnings ? `, ${warnings} warning(s)` : ""}\n`);
process.exit(failures ? 1 : 0);
