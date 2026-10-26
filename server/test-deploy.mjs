// ---------------------------------------------------------------------------
// test-deploy — does this gateway survive being on the internet?
//
//   npm run test:deploy        (from the repo root)
//
// WHY THIS IS ITS OWN SUITE
//   test-gateway.mjs is offline: it imports pure functions and never opens a
//   socket. Everything in here is the opposite — it boots the REAL gateway as a
//   child process, bound to 0.0.0.0 with an origin allowlist and an admin token,
//   and makes actual HTTP requests to it. That is the only way to test the things
//   that break on a PaaS and never break on a laptop:
//
//     • the origin matcher. Two bugs here were found by curl, not by reading:
//       `https://*.vercel.app` also matched the SHARED APEX `https://vercel.app`
//       (every Vercel deployment on earth could call a gateway holding a signing
//       key), and a rejected origin used to answer 200 with no headers instead of
//       refusing, because that is what the `cors` package does on `origin:false`.
//     • the admin lock on /api/pause. Unauthenticated on loopback for the whole
//       life of this project, and a one-line denial of service the moment the
//       gateway has a public URL.
//     • PORT/HOST handling. Render injects PORT and proxies to 0.0.0.0; a
//       service that ignores either never passes its health check and the deploy
//       looks like it "just failed".
//     • the x402 expose headers. Without them a browser payer settles on chain
//       and cannot read the receipt, which looks exactly like a broken payment.
//
//   Needs server/.env (the agent key) because it boots the real process. It makes
//   NO chain writes and spends nothing: every assertion is on config, headers and
//   status codes.
//
// Exits 1 on any failure, so it can gate a deploy.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY = path.join(HERE, "agent-gateway.js");
const HOST = "127.0.0.1";

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

const ALLOWED = "https://agentfloat.vercel.app,https://*.vercel.app";
const TOKEN = "test-admin-token";
const PORT = Number(process.env.TEST_DEPLOY_PORT || 4199);
const STATE_DIR = path.join(HERE, "..", "node_modules", ".tmp-deploy-state");

// ---------------------------------------------------------------------------
// boot the real gateway in "deployed" mode
// ---------------------------------------------------------------------------

/**
 * Boot the gateway as a child process.
 *
 * `host` is a parameter and NOT hardcoded to 0.0.0.0, because the point of the
 * second suite below is the loopback default — forcing 0.0.0.0 on it tested
 * public mode twice and "found" two failures that were this harness's bug, not
 * the gateway's. PORT is always overridden: the gateway prefers an injected PORT
 * over GATEWAY_PORT, which is what a PaaS does.
 */
function boot(env, port, host = "0.0.0.0") {
  const child = spawn(process.execPath, [GATEWAY], {
    cwd: HERE,
    env: { ...process.env, PORT: String(port), GATEWAY_HOST: host, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return { child, log: () => out };
}

/** Resolve once /api/health answers, or reject after `ms`. */
async function waitForHealth(port, ms = 25_000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://${HOST}:${port}/api/health`);
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`gateway on :${port} never became healthy (${last})`);
}

/** One request, returning the status, the JSON body, and the header map. */
async function probe(port, p, { method = "GET", origin, headers = {}, body } = {}) {
  const h = { ...headers };
  if (origin !== undefined) h.Origin = origin;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(`http://${HOST}:${port}${p}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data, headers: res.headers };
}

const kill = (child) => new Promise((r) => {
  if (!child || child.exitCode !== null) return r();
  child.once("exit", r);
  child.kill("SIGKILL");
});

// ---------------------------------------------------------------------------

console.log(`\n== deployment behaviour ==========================================`);
console.log(`  booting the real gateway on 0.0.0.0:${PORT}\n`);

const deployed = boot({ GATEWAY_ALLOWED_ORIGINS: ALLOWED, GATEWAY_ADMIN_TOKEN: TOKEN, STATE_DIR }, PORT);

try {
  await waitForHealth(PORT);
  ok("gateway boots with GATEWAY_HOST=0.0.0.0 and an injected PORT", `:${PORT}`);

  // --- the platform's PORT wins over GATEWAY_PORT -------------------------
  {
    const r = await probe(PORT, "/api/health");
    eq("PORT (not GATEWAY_PORT) is the port it bound", r.data?.deployment?.port, PORT);
    eq("it knows it is public", r.data?.deployment?.public, true);
    eq("the admin lock is reported, not leaked", r.data?.deployment?.adminLocked, true);
    eq("the allowlist is echoed for debugging", (r.data?.deployment?.allowedOrigins || []).length, 2);
    eq("STATE_DIR was honoured", r.data?.deployment?.stateDir, STATE_DIR);
    eq("and reported as persistent", r.data?.deployment?.persistentState, true);
    if (r.data?.deployment && "adminToken" in r.data.deployment) {
      bad("health must never expose the admin token itself");
    } else {
      ok("health exposes adminLocked, not the token");
    }
  }

  // --- the browser-facing seller URL ---------------------------------------
  {
    const r = await probe(PORT, "/api/health");
    const { selfUrl, browserUrl } = r.data?.seller || {};
    eq("the gateway's own seller URL is loopback", selfUrl?.startsWith("http://127.0.0.1:"), true);
    eq("the BROWSER seller URL is a relative path", browserUrl, "/paid/insight");
    if (browserUrl && /127\.0\.0\.1|localhost/.test(browserUrl)) {
      bad("browserUrl must never contain loopback", "a deployed frontend would send the user to their own machine");
    }
  }

  // --- CORS: the matrix that has to hold on a public URL --------------------
  const allow = [
    ["the exact allowlisted origin", "https://agentfloat.vercel.app"],
    ["a wildcard subdomain", "https://abc123.vercel.app"],
    ["a deep subdomain", "https://a.b.vercel.app"],
    ["loopback (always allowed)", "http://localhost:5173"],
    ["loopback preview server", "http://127.0.0.1:4173"],
  ];
  const refuse = [
    // THE BUG THIS PINS. `*.` used to compile to `(?:[a-z0-9-]+\.)*` — zero or
    // more — so the pattern matched the apex too. vercel.app is a SHARED apex,
    // which meant any stranger's Vercel deployment could call this gateway.
    ["the SHARED APEX of a wildcard entry", "https://vercel.app"],
    ["an unrelated origin", "https://evil.example"],
    ["a subdomain-spoof suffix", "https://agentfloat.vercel.app.evil.com"],
    ["a path-spoof prefix", "https://evil.com/https://agentfloat.vercel.app"],
    ["a sandboxed-iframe null origin", "null"],
    ["a scheme downgrade", "http://agentfloat.vercel.app"],
  ];

  for (const [label, origin] of allow) {
    const r = await probe(PORT, "/api/health", { origin });
    const acao = r.headers.get("access-control-allow-origin");
    r.status === 200 && acao === origin
      ? ok(`cors allows ${label}`, origin)
      : bad(`cors allows ${label}`, `${origin} -> HTTP ${r.status}, ACAO ${acao}`);
  }
  for (const [label, origin] of refuse) {
    const r = await probe(PORT, "/api/health", { origin });
    const acao = r.headers.get("access-control-allow-origin");
    r.status === 403 && !acao && r.data?.error === "origin_not_allowed"
      ? ok(`cors refuses ${label}`, origin)
      : bad(`cors refuses ${label}`, `${origin} -> HTTP ${r.status}, ACAO ${acao}, error ${r.data?.error}`);
  }

  // A refusal has to say which origin was rejected and what to set, or the
  // operator is reading Render logs to find out why their frontend is deaf.
  {
    const r = await probe(PORT, "/api/health", { origin: "https://evil.example" });
    eq("the refusal names the rejected origin", r.data?.origin, "https://evil.example");
    eq("and the allowlist to fix", Array.isArray(r.data?.allowedOrigins), true);
    eq("and says what to do", /GATEWAY_ALLOWED_ORIGINS/.test(r.data?.detail || ""), true);
  }

  // No Origin header = not a browser. The relay, curl and the health check all
  // arrive this way and must not be blocked by a rule meant for browsers.
  {
    const r = await probe(PORT, "/api/health");
    eq("a request with no Origin still passes", r.status, 200);
  }

  // --- preflight ------------------------------------------------------------
  {
    const good = await probe(PORT, "/api/quote", {
      method: "OPTIONS",
      origin: "https://agentfloat.vercel.app",
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    eq("preflight from an allowed origin is 204", good.status, 204);
    // Without these a browser payer settles on chain and cannot read the
    // receipt — the direct-from-browser path looks broken while the money moved.
    const expose = good.headers.get("access-control-expose-headers") || "";
    for (const h of ["PAYMENT-RESPONSE", "X-PAYMENT", "PAYMENT-SIGNATURE"]) {
      expose.toUpperCase().includes(h)
        ? ok(`preflight exposes ${h} to the browser`)
        : bad(`preflight exposes ${h} to the browser`, `got "${expose}"`);
    }
    eq("preflight allows the admin header", (good.headers.get("access-control-allow-headers") || "").includes("X-AgentFloat-Admin"), true);
    eq("preflight is Vary: Origin (never a cached wildcard)", good.headers.get("vary"), "Origin");
    if (good.headers.get("access-control-allow-credentials")) {
      bad("credentials must never be allowed", "echoing an arbitrary origin with credentials is the classic CORS hole");
    } else {
      ok("no Access-Control-Allow-Credentials");
    }

    const evil = await probe(PORT, "/api/quote", {
      method: "OPTIONS",
      origin: "https://evil.example",
      headers: { "Access-Control-Request-Method": "POST" },
    });
    // Used to fall through to the 404 catch-all and answer "no route OPTIONS
    // /api/quote" — a confusing thing to read while diagnosing a deploy.
    eq("preflight from a refused origin is 403, not 404", evil.status, 403);
  }

  // --- the admin lock -------------------------------------------------------
  {
    const open = await probe(PORT, "/api/pause", { method: "POST", body: { reason: "test" } });
    eq("pause without the token is refused", open.status, 403);
    eq("and says why", open.data?.error, "admin_locked");

    const wrong = await probe(PORT, "/api/pause", {
      method: "POST",
      headers: { "X-AgentFloat-Admin": "not-the-token" },
      body: { reason: "test" },
    });
    eq("pause with a wrong token is refused", wrong.status, 403);

    const good = await probe(PORT, "/api/pause", {
      method: "POST",
      headers: { "X-AgentFloat-Admin": TOKEN },
      body: { reason: "test-deploy" },
    });
    eq("pause with the token works", good.status, 200);
    eq("and it actually paused", good.data?.paused, true);

    const back = await probe(PORT, "/api/unpause", {
      method: "POST",
      headers: { "X-AgentFloat-Admin": TOKEN },
    });
    eq("unpause with the token works", back.status, 200);
    eq("and it actually resumed", back.data?.paused, false);

    // The chain-level pause is the authority that survives a restart, and it
    // must stay reachable by the owner wallet regardless of the HTTP lock.
    const health = await probe(PORT, "/api/health");
    eq("the gateway is serving again after the round trip", health.data?.paused, false);
  }

  // --- startup log ------------------------------------------------------------
  {
    const l = deployed.log();
    /PUBLIC bind/.test(l) ? ok("a public bind announces itself in the log") : bad("a public bind announces itself in the log");
    /cors\s+https:\/\/agentfloat\.vercel\.app/.test(l) ? ok("and prints the allowlist") : bad("and prints the allowlist");
    /GATEWAY_ADMIN_TOKEN set/.test(l) ? ok("and prints the admin-lock state") : bad("and prints the admin-lock state");
    /refused GET \/api\/health from https:\/\/evil\.example/.test(l)
      ? ok("every cors refusal is logged with its origin")
      : bad("every cors refusal is logged with its origin");
    if (!/AGENT_PRIVATE_KEY/.test(l)) ok("it still found its agent key in server/.env");
    else bad("it did not find the agent key", "server/.env must exist for this suite");
  }
} catch (e) {
  bad("deployed gateway suite", e.stack || String(e));
  console.log(deployed.log().split("\n").slice(-25).join("\n"));
} finally {
  await kill(deployed.child);
}

// ---------------------------------------------------------------------------
// Loopback mode: the local default must stay frictionless. No allowlist, no
// token — `npm run dev` has to keep working with nothing configured.
// ---------------------------------------------------------------------------

console.log(`\n  booting the same gateway on loopback, unconfigured\n`);
const local = boot({ GATEWAY_ALLOWED_ORIGINS: "", GATEWAY_ADMIN_TOKEN: "" }, PORT + 1, "127.0.0.1");
try {
  await waitForHealth(PORT + 1);
  {
    const r = await probe(PORT + 1, "/api/health");
    eq("loopback mode reports itself as not public", r.data?.deployment?.public, false);
    eq("and not admin-locked", r.data?.deployment?.adminLocked, false);
    eq("state stays beside the code when STATE_DIR is unset", r.data?.deployment?.stateDir, HERE);
    eq("and is reported as NOT persistent", r.data?.deployment?.persistentState, false);
  }
  {
    // An arbitrary origin is accepted on loopback: this is the mode where the
    // gateway is only reachable from the same machine, and refusing here would
    // break every LAN and tunnel workflow this repo documents.
    const r = await probe(PORT + 1, "/api/health", { origin: "https://anything.example" });
    eq("loopback does not enforce the allowlist", r.status, 200);
  }
  {
    const r = await probe(PORT + 1, "/api/pause", { method: "POST", body: { reason: "local test" } });
    eq("loopback leaves pause open, as it always has", r.status, 200);
    await probe(PORT + 1, "/api/unpause", { method: "POST" });
  }
  {
    const r = await probe(PORT + 1, "/api/limits/config");
    eq("the rest of the API is untouched by the deploy changes", r.status, 200);
  }
} catch (e) {
  bad("loopback gateway suite", e.stack || String(e));
  console.log(local.log().split("\n").slice(-25).join("\n"));
} finally {
  await kill(local.child);
}

// ---------------------------------------------------------------------------
// The existing guard, still true and worth pinning: two gateways cannot share a
// port, and the second one must EXIT rather than serve half a state.
// ---------------------------------------------------------------------------

console.log(`\n  port collision\n`);
const a = boot({ GATEWAY_ALLOWED_ORIGINS: "", GATEWAY_ADMIN_TOKEN: "" }, PORT + 2);
try {
  await waitForHealth(PORT + 2);
  const b = boot({ GATEWAY_ALLOWED_ORIGINS: "", GATEWAY_ADMIN_TOKEN: "" }, PORT + 2);
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 20_000);
    b.child.once("exit", (c) => { clearTimeout(t); resolve(c); });
  });
  eq("a second gateway on a taken port exits non-zero instead of serving", Boolean(code), true);
  /EADDRINUSE|in use|taken/.test(b.log())
    ? ok("and says the port is taken", b.log().split("\n").find((l) => /EADDRINUSE|in use|taken/.test(l))?.trim())
    : bad("and says the port is taken", b.log().slice(-400));
  await kill(b.child);
} catch (e) {
  bad("port collision suite", e.stack || String(e));
} finally {
  await kill(a.child);
}

console.log(
  `\n${failed ? `❌ ${failed} failed` : "✅ deployment behaviour holds"}, ${passed} passed\n`
);
process.exit(failed ? 1 : 0);
