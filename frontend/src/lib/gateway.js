// ---------------------------------------------------------------------------
// Gateway client.
//
// By default every call is RELATIVE ("/api/...") and the dev server proxies it to
// the gateway on 127.0.0.1. That matters twice over: the browser must never dial
// localhost directly when the app is served through a tunnel, and it must never
// see the agent private key. The key stays in the gateway process.
//
// DEPLOYED, there is no Vite proxy — Vercel serves a static bundle — so the same
// relative path has to resolve to somewhere. Two supported answers:
//
//   VITE_GATEWAY_URL      the browser calls the gateway's own origin directly.
//                         Set it to the Render URL. This is the primary route:
//                         it needs no hardcoded value committed to the repo, and
//                         the gateway's GATEWAY_ALLOWED_ORIGINS list decides who
//                         may call it. Baked in at BUILD time — Vite inlines
//                         import.meta.env, so a change means a redeploy.
//
//   a platform rewrite    leave VITE_GATEWAY_URL unset and let the host proxy
//                         /api and /paid to the gateway. Same-origin, so no CORS
//                         at all. frontend/vercel.json documents it; the catch is
//                         that vercel.json cannot interpolate an env var, so the
//                         gateway URL ends up committed in the repo.
//
// Whichever is used, the browser only ever sees PUBLIC information. The private
// key never leaves the gateway, and GATEWAY_ADMIN_TOKEN must not be set here as a
// way to make the pause button work — a build-time variable is in the bundle, and
// a published admin token is not a lock.
// ---------------------------------------------------------------------------

const RAW_BASE = (import.meta.env.VITE_GATEWAY_URL || "").trim();
/** Absolute gateway origin with no trailing slash, or "" for same-origin. */
export const GATEWAY_BASE = RAW_BASE ? RAW_BASE.replace(/\/+$/, "") : "";
/** True when the browser talks to the gateway on a different origin. */
export const CROSS_ORIGIN = Boolean(GATEWAY_BASE);

const api = (path) => `${GATEWAY_BASE}${path}`;

/**
 * Owner-command token, for a gateway deployed with GATEWAY_ADMIN_TOKEN.
 *
 * Empty by default, which is the correct state for almost every deployment: the
 * pause/unpause buttons then belong to whoever can reach the gateway at all, and
 * on a laptop behind loopback that is only this machine. Read the comment above
 * before setting it in a browser bundle.
 */
const ADMIN_HEADER = (import.meta.env.VITE_GATEWAY_ADMIN_TOKEN || "").trim();

function baseHeaders() {
  const h = { "Content-Type": "application/json" };
  if (ADMIN_HEADER) h["X-AgentFloat-Admin"] = ADMIN_HEADER;
  return h;
}

/**
 * Whether this bundle can present an admin token at all.
 *
 * Exported because a page has to tell two different situations apart, and they
 * need opposite UI: a gateway that is locked WHILE this bundle holds the token
 * should just work silently, and a gateway that is locked without one should say
 * so up front instead of letting the user click a button that can only 403.
 */
export const ADMIN_TOKEN_CONFIGURED = Boolean(ADMIN_HEADER);

/** True when a response is the gateway refusing an owner command for lack of a token. */
export const isAdminLocked = (r) => Boolean(r) && r.ok === false && r.error === "admin_locked";

async function req(path, opts = {}) {
  let res;
  try {
    res = await fetch(api(path), {
      ...opts,
      // Merged AFTER the caller's own headers, so a page can add one without
      // losing Content-Type (and vice versa: opts.headers wins on a collision).
      headers: { ...baseHeaders(), ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    // A cross-origin refusal arrives here as a TypeError, because the browser
    // hides a CORS failure from JS. Naming the likely cause is the difference
    // between "gateway unreachable" and a five-minute hunt through Render logs.
    const hint = CROSS_ORIGIN
      ? `gateway unreachable (${e.message}). The frontend is calling ${GATEWAY_BASE} ` +
        `cross-origin, so also check that this site's origin is in the gateway's ` +
        `GATEWAY_ALLOWED_ORIGINS and that the service is awake.`
      : `gateway unreachable (${e.message})`;
    return { ok: false, unreachable: true, error: hint };
  }
  let data = null;
  try { data = await res.json(); } catch { data = { raw: await res.text().catch(() => "") }; }
  return { ok: res.ok, status: res.status, ...(data || {}) };
}

export const getHealth = () => req("/api/health");
export const getPolicy = () => req("/api/policy");
export const getReceipts = () => req("/api/receipts");
export const getChainRecords = (limit = 25) => req(`/api/chain-records?limit=${limit}`);

/** Ask what a URL would cost WITHOUT paying. Surfaces the policy verdict too. */
export const quote = (url) => req("/api/quote", { method: "POST", body: { url } });

/** Buy a resource: probe -> policy gate -> sign x402 payment -> return receipt. */
export const pay = (url) => req("/api/pay", { method: "POST", body: { url } });

/**
 * Owner-style commands. A gateway deployed with GATEWAY_ADMIN_TOKEN answers 403
 * `admin_locked` unless the token is presented; both callers surface that as a
 * reason rather than a generic failure, because "the button does nothing" is the
 * complaint it would otherwise produce.
 */
export const pauseGateway = (reason) =>
  req("/api/pause", { method: "POST", body: { reason } });
export const unpauseGateway = () => req("/api/unpause", { method: "POST" });

// --- faucet ----------------------------------------------------------------
// The faucet airdrops MUSD from the OPERATOR wallet to a signed-in user's own
// agent wallet. Two calls: status (can I claim yet?) and request (claim).
//
// `request` needs a signature over the claim message. That is what stops anyone
// from POSTing an arbitrary address and draining the operator wallet — the
// server recovers the signer and refuses if it does not match.

/** Cooldown state + remaining budget for one address. `address` may be omitted. */
export const faucetStatus = (address) =>
  req(`/api/faucet/status${address ? `?address=${encodeURIComponent(address)}` : ""}`);

/** The exact string a wallet must sign to claim. Both sides must agree on it. */
export const faucetChallenge = (address) =>
  req(`/api/faucet/challenge?address=${encodeURIComponent(address)}`);

/** Submit a signed claim. `signature` is over the challenge text. */
export const faucetRequest = ({ address, signature, message }) =>
  req("/api/faucet/request", { method: "POST", body: { address, signature, message } });

// --- gas drip ---------------------------------------------------------------
// A new agent wallet has MUSD but no native BTC, and `MUSD.approve(Permit2, …)` —
// the one transaction every x402 payment depends on — needs gas. These three
// calls are the self-service replacement for `contract/scripts/grant-permit2.js`,
// which a user cannot run: it is a developer command that needs a private key.
//
// `gasStatus` is the one call the approval popup needs: it reports the wallet's
// BTC, its MUSD→Permit2 allowance, what an approval would cost, and whether a
// drip is available right now. Same auth shape as the faucet — the server authors
// the message, the wallet signs it, the server recovers and refuses on mismatch.

/** Everything the popup needs about one wallet: gas, allowance, drip eligibility. */
export const gasStatus = (address) =>
  req(`/api/gas/status?address=${encodeURIComponent(address)}`);

/** Drip config + how much of the operator's gas budget is left. */
export const gasConfig = () => req("/api/gas/config");

/** The exact string a wallet must sign to request gas. */
export const gasChallenge = (address) =>
  req(`/api/gas/challenge?address=${encodeURIComponent(address)}`);

/** Submit a signed gas request. */
export const gasRequest = ({ address, signature, message }) =>
  req("/api/gas/request", { method: "POST", body: { address, signature, message } });

// --- user agents -----------------------------------------------------------
// Each Privy user has their own agent wallet, registered in the treasury by the
// gateway (which holds the owner key). These read that per-user state.

/** On-chain status for an arbitrary agent wallet (a signed-in user's own). */
export const agentStatus = (address) =>
  req(`/api/agent/${encodeURIComponent(address)}`);

/**
 * Ask the gateway to record a payment that the BROWSER settled.
 *
 * The gateway does not take our word for it: it reads the transaction receipt,
 * confirms a MUSD transfer actually left `agent` in that tx, and only then calls
 * recordPayment with the verified amount and payee. A client that lies about a
 * settlement gets `verified: false` and nothing is written to the ledger.
 */
export const recordSettlement = ({ agent, settlementTx, endpoint }) =>
  req("/api/record-settlement", { method: "POST", body: { agent, settlementTx, endpoint } });

// --- x402 relay --------------------------------------------------------------
// Signing stays in the browser; only the HTTP fetch is relayed. That is what
// lets a user pay a seller that sends no Access-Control-Allow-Origin — the
// failure that used to read "Failed to fetch" and push everyone onto the
// operator's demo agent. The gateway never sees a key: it forwards one opaque
// header that only the user's wallet could have produced.

/** Unpaid probe through the gateway. Returns the 402 headers, the offer, and the
 *  policy verdict for THIS agent's on-chain caps. */
export const relayProbe = (url, agent) =>
  req("/api/relay/probe", { method: "POST", body: { url, agent } });

/**
 * Re-request the seller with a browser-signed payment attached.
 *
 * `paymentHeaders` is the map `encodePaymentSignatureHeader()` returned, and it is
 * what the gateway forwards: the header NAME differs between x402 v1
 * (`X-PAYMENT`) and v2 (`PAYMENT-SIGNATURE`), and only the client knows which it
 * produced. `payment` (the bare value) is kept as a fallback.
 */
export const relayExecute = ({ url, agent, payment, paymentHeaders }) =>
  req("/api/relay/execute", { method: "POST", body: { url, agent, payment, paymentHeaders } });

// --- self-service budget -----------------------------------------------------
// A user changes their OWN agent's caps. The wallet cannot call setAgentLimits
// (onlyOwner, deliberately — an agent that can raise its own ceiling is not
// budget-controlled), so the user signs an authorization and the gateway applies
// it with the owner key, inside a published ceiling.
//
// The server writes the message and the client signs it verbatim, so there is no
// format to drift and nothing in the second request is trusted but the signature.

/** The ceiling the gateway will apply, and whether the owner key is present. */
export const limitsConfig = () => req("/api/limits/config");

/** Ask for the exact string to sign for a budget change (or a freeze). */
export const limitsChallenge = ({ address, action = "limits", perCallMax, dailyCap }) => {
  const q = new URLSearchParams({ address, action });
  if (action === "limits") {
    q.set("perCallMax", String(perCallMax));
    q.set("dailyCap", String(dailyCap));
  }
  return req(`/api/limits/challenge?${q.toString()}`);
};

/** Submit the signature. The values applied are the ones the signature covers. */
export const limitsApply = ({ nonce, signature }) =>
  req("/api/limits/apply", { method: "POST", body: { nonce, signature } });

/** Audit trail of self-service changes for one address. */
export const limitsHistory = (address) =>
  req(`/api/limits/history?address=${encodeURIComponent(address)}`);

// --- telegram alerts ---------------------------------------------------------
// Binding a chat to an agent address is signature-authorized, like everything
// else here that changes state: otherwise anyone who knows an address could
// receive, or silence, somebody else's spending alerts.

export const telegramConfig = () => req("/api/telegram/config");

export const telegramChallenge = (address, action = "subscribe") =>
  req(`/api/telegram/challenge?address=${encodeURIComponent(address)}&action=${action}`);

export const telegramSubscribe = ({ nonce, signature }) =>
  req("/api/telegram/subscribe", { method: "POST", body: { nonce, signature } });

export const telegramUnsubscribe = ({ nonce, signature }) =>
  req("/api/telegram/unsubscribe", { method: "POST", body: { nonce, signature } });

export const telegramTest = ({ nonce, signature }) =>
  req("/api/telegram/test", { method: "POST", body: { nonce, signature } });

export const telegramStatus = (address) =>
  req(`/api/telegram/status?address=${encodeURIComponent(address)}`);
