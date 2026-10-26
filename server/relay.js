// ---------------------------------------------------------------------------
// x402 relay — lets ANY user's own wallet pay ANY seller, CORS notwithstanding.
//
// THE PROBLEM THIS SOLVES
//   A browser fetch is subject to CORS. Most x402 sellers (Mezo's hosted demo
//   included) send no Access-Control-Allow-Origin, so a user paying with their
//   own Privy wallet got "Failed to fetch" — while the gateway's demo agent
//   worked, because Node has no CORS. That left exactly one working path, and it
//   was the one that required the operator's key. Not a product.
//
// THE SPLIT
//   Signing stays in the browser. Fetching moves to the gateway.
//
//     1. browser → POST /api/relay/probe      gateway fetches unpaid, returns
//                                             the 402 headers verbatim
//     2. browser                              x402HTTPClient.createPaymentPayload()
//                                             → the user's wallet signs (Privy
//                                             prompt) → encodePaymentSignatureHeader()
//     3. browser → POST /api/relay/execute    gateway re-fetches WITH that header
//                                             and returns the response
//
//   The gateway never sees a key and never signs. It sees one opaque header that
//   only the user's wallet could have produced, and it can DECODE that header to
//   learn the payer, amount, asset and network — which is what makes the policy
//   check and the ledger honest instead of trusting the request body.
//
// WHY THE URL GUARDS ARE HERE AND NOT OPTIONAL
//   This endpoint makes the operator's machine fetch a URL chosen by a stranger
//   on the internet. That is a textbook SSRF primitive: without guards it is a
//   proxy into the operator's LAN, their cloud metadata endpoint (169.254.169.254
//   → IAM credentials) and any internal admin panel. So every URL is checked
//   for scheme, literal private ranges, .local/.internal names, AND — because a
//   public hostname can resolve to a private address — every address it actually
//   resolves to. Redirects are not followed, since a redirect is a second URL
//   that was never checked.
// ---------------------------------------------------------------------------

import { lookup } from "node:dns/promises";
import { decodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";

export class RelayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
}

const MAX_BODY_BYTES = 512 * 1024; // a seller could stream forever; we will not
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The only headers worth forwarding. `payment-required` is what the browser's
 * x402 client needs to build a payload; `payment-response` carries the
 * settlement result back. Everything else is the seller's business and could
 * carry cookies or auth we have no reason to relay.
 */
const PASS_THROUGH = new Set([
  "payment-required",
  "x-payment-required",
  "payment-response",
  "x-payment-response",
  "content-type",
  "x402-version",
]);

/**
 * True when the host is an IP LITERAL rather than a name.
 *
 * The distinction is load-bearing: a literal can be judged as written, but a name
 * must be resolved first. Judging a name with the address rules refuses every
 * real seller on the internet (they are not IPs), and judging a literal with DNS
 * would trust whatever the name server says about 127.0.0.1.
 */
export function isIpLiteral(host) {
  if (!host || typeof host !== "string") return false;
  if (host.includes(":")) return true; // IPv6 (brackets already stripped)
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** True for loopback / private / link-local / reserved addresses, v4 and v6. */
export function isPrivateAddress(ip) {
  if (!ip || typeof ip !== "string") return true; // unknown ⇒ refuse
  let v = ip.trim().toLowerCase();

  // IPv4-mapped IPv6 (::ffff:127.0.0.1) — judge the mapped v4 address.
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) v = mapped[1];

  if (v.includes(":")) {
    if (v === "::1" || v === "::") return true;         // loopback / unspecified
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique-local
    if (v.startsWith("fe80")) return true;               // link-local
    return false;                                        // assume routable v6
  }

  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return true; // not an IP we understand ⇒ refuse
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||                       // this network
    a === 10 ||                      // 10/8
    a === 127 ||                     // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) ||      // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) ||      // 192.168/16
    a >= 224                         // multicast + reserved
  );
}

/**
 * Validate a URL this gateway is being asked to fetch.
 *
 * @param rawUrl     the URL from the request body
 * @param opts.selfOrigins Set of the gateway's own origins. Its built-in demo
 *   seller lives on loopback and is THIS process, so it is exempt — that is the
 *   one internal address that is genuinely safe to call.
 * @param opts.allowlist   optional endpoint prefixes; empty = any public https URL
 * @returns the normalized href
 * @throws RelayError with a code the UI can explain
 */
export async function assertRelayable(rawUrl, { selfOrigins = new Set(), allowlist = [] } = {}) {
  let u;
  try {
    u = new URL(String(rawUrl || "").trim());
  } catch {
    throw new RelayError("bad_url", "That is not a parseable URL.");
  }

  const isSelf = selfOrigins.has(u.origin);

  if (u.protocol !== "https:" && !(u.protocol === "http:" && isSelf)) {
    throw new RelayError(
      "bad_protocol",
      u.protocol === "http:"
        ? "Plain http is refused — the gateway only calls the built-in seller over http, everything else must be https."
        : `Refusing to relay ${u.protocol} URLs.`
    );
  }

  // Allowlist first: if the operator has named the services this gateway may
  // call, an unlisted host is refused without even resolving it.
  if (allowlist.length) {
    const ok = allowlist.some((p) => u.href.startsWith(p) || u.origin === p || u.origin.startsWith(p));
    if (!ok) throw new RelayError("not_allowlisted", `${u.origin} is not an approved service.`);
  }

  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!isSelf) {
    if (host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") {
      throw new RelayError("ssrf_blocked", `Refusing the internal name ${host}.`);
    }
    if (isIpLiteral(host)) {
      // Judged as written. No DNS involved, so no name server can lie about it.
      if (isPrivateAddress(host)) {
        throw new RelayError("ssrf_blocked", `Refusing to call the internal address ${host}.`);
      }
    } else {
      // A NAME must be resolved and every address judged, because a public
      // hostname pointing at 127.0.0.1 is the standard way around a
      // hostname-only blocklist (DNS rebinding).
      try {
        const records = await lookup(host, { all: true, verbatim: true });
        if (!records.length) throw new RelayError("dns_failed", `${host} did not resolve.`);
        for (const r of records) {
          if (isPrivateAddress(r.address)) {
            throw new RelayError(
              "ssrf_blocked",
              `${host} resolves to ${r.address}, which is an internal address. Refusing.`
            );
          }
        }
      } catch (e) {
        if (e instanceof RelayError) throw e;
        throw new RelayError("dns_failed", `${host} did not resolve (${e.code || e.message}).`);
      }
    }
  }

  return u.href;
}

/** Lowercased, filtered header map — enough for the browser to rebuild a 402. */
export function collectHeaders(res) {
  const out = {};
  for (const [k, v] of res.headers.entries()) {
    const key = k.toLowerCase();
    if (PASS_THROUGH.has(key)) out[key] = v;
  }
  return out;
}

/** Read a body with a hard cap, so one seller cannot exhaust gateway memory. */
export async function readBodyLimited(res, maxBytes = MAX_BODY_BYTES) {
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.byteLength > maxBytes;
    return { text: buf.subarray(0, maxBytes).toString("utf8"), bytes: buf.byteLength, truncated };
  } catch (e) {
    return { text: "", bytes: 0, truncated: false, error: e.message };
  }
}

/**
 * Fetch a URL through the gateway. Shared by the unpaid probe and the paid
 * execute, so both get the same timeout, redirect and size behaviour.
 *
 * `redirect: "manual"` on purpose: following a redirect means fetching a second
 * URL that assertRelayable never saw. The browser is told about the redirect and
 * can re-request it explicitly if the seller really needs one.
 */
async function relayFetch(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "agentfloat-relay/1.0", ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e?.message || String(e);
    if (/timeout|aborted/i.test(msg) || e?.name === "TimeoutError") {
      throw new RelayError("seller_timeout", `The seller did not answer within ${timeoutMs / 1000}s.`);
    }
    throw new RelayError("seller_unreachable", `Could not reach the seller: ${msg}`);
  }

  const body = await readBodyLimited(res);
  return {
    status: res.status,
    headers: collectHeaders(res),
    body: body.text,
    bodyBytes: body.bytes,
    truncated: body.truncated,
    redirected: res.status >= 300 && res.status < 400,
    location: res.status >= 300 && res.status < 400 ? res.headers.get("location") : null,
    ms: Date.now() - startedAt,
  };
}

/** Step 1: the unpaid probe. Nothing is signed, nothing is spent. */
export function probeSeller(url, opts) {
  return relayFetch(url, opts);
}

/**
 * The request header names a payment travels under.
 *
 * v1 uses `X-PAYMENT`. v2 — which is what Mezo's facilitator and its hosted demo
 * actually speak — uses `PAYMENT-SIGNATURE`. `encodePaymentSignatureHeader()`
 * returns whichever the negotiated version needs, so the relay has to forward the
 * name the CLIENT chose rather than assume one.
 *
 * This was not theoretical: sending only `X-PAYMENT` to a v2 seller is silently
 * ignored. The seller answers 402 again, no MUSD moves, and the failure reads as
 * "settlement rejected" rather than "we sent the header under a name nobody
 * reads". Nothing logs, because from the relay's point of view nothing went wrong
 * — it got an answer.
 */
export const PAYMENT_HEADER_NAMES = ["x-payment", "payment-signature"];

/**
 * Normalise whatever the browser sent into concrete request headers.
 *
 * Accepts the raw header value (string) or the map returned by
 * `encodePaymentSignatureHeader()`. A map is FILTERED to the known payment header
 * names, because the relay sets these on a request it makes on somebody else's
 * behalf: without a filter a client could smuggle `Host`, `Authorization` or
 * `X-Forwarded-For` through it.
 *
 * A bare string carries no version information, so it is decoded to pick the
 * right name; if it will not decode, it goes under both (each version reads its
 * own and ignores the other) and the execute path refuses it anyway.
 */
export function paymentHeadersFrom(payment) {
  if (!payment) return { ok: false, error: "empty payment header" };

  if (typeof payment === "string") {
    let version = null;
    try { version = decodePaymentSignatureHeader(payment)?.x402Version ?? null; } catch { version = null; }
    const name = version === 2 ? "PAYMENT-SIGNATURE" : version === 1 ? "X-PAYMENT" : null;
    return {
      ok: true,
      headers: name ? { [name]: payment } : { "X-PAYMENT": payment, "PAYMENT-SIGNATURE": payment },
      version,
    };
  }

  if (typeof payment === "object") {
    const headers = {};
    for (const [k, v] of Object.entries(payment)) {
      if (typeof v !== "string" || !v) continue;
      if (PAYMENT_HEADER_NAMES.includes(String(k).toLowerCase())) headers[String(k)] = v;
    }
    if (!Object.keys(headers).length) {
      return {
        ok: false,
        error: `the payment headers contained none of ${PAYMENT_HEADER_NAMES.join(" / ")}`,
      };
    }
    return { ok: true, headers };
  }

  return { ok: false, error: "payment must be a header value or a map of payment headers" };
}

/** Step 3: re-request with the browser's payment header attached. */
export function executeWithPayment(url, payment, opts) {
  const h = paymentHeadersFrom(payment);
  if (!h.ok) throw new RelayError("no_payment_header", h.error);
  return relayFetch(url, { ...opts, headers: { ...(opts?.headers || {}), ...h.headers } });
}

/**
 * Decode a seller's 402 from the relayed headers.
 *
 * The browser cannot read the seller's response (that is the whole CORS
 * problem), so the gateway relays the `payment-required` header verbatim and the
 * browser feeds it to its own x402 client. This helper is the server-side twin,
 * used to price the payment for the policy gate BEFORE anything is relayed.
 *
 * Returns the offer in the same shape /api/quote already uses, so one UI renders
 * both paths.
 */
export function decodeOffer(headers = {}, bodyText = "") {
  const raw =
    headers["payment-required"] ||
    headers["x-payment-required"] ||
    headers["PAYMENT-Required"] ||
    null;
  if (!raw) return { offer: null, raw: null };

  let decoded = null;
  try {
    decoded = decodePaymentRequiredHeader(raw);
  } catch {
    // v2 puts the requirements in the body when the header is absent/short.
    try {
      decoded = JSON.parse(bodyText);
    } catch {
      return { offer: null, raw, parseError: true };
    }
  }

  const r = decoded?.requirements?.[0] || decoded?.paymentRequirements?.[0] || decoded?.accepts?.[0] || null;
  return {
    raw: decoded,
    description: decoded?.resource?.description || decoded?.description || null,
    offer: r
      ? {
          scheme: r.scheme,
          network: r.network,
          asset: r.asset,
          amount: String(r.maxAmountRequired ?? r.amount ?? ""),
          payTo: r.payTo,
          maxTimeoutSeconds: r.maxTimeoutSeconds ?? null,
          extra: r.extra || r,
        }
      : null,
  };
}

/**
 * Decode a payment header without settling it.
 *
 * This is what turns the relay from "trust the browser" into "verify the
 * browser": the payer, amount, asset and network come out of the SIGNED payload
 * itself, so the policy gate and the ledger are keyed to what the wallet actually
 * authorized rather than to what the request body claimed.
 *
 * Field positions differ by protocol version AND by transfer method, so every
 * read is defensive:
 *
 *   v1 wrapper  { x402Version: 1, scheme, network, payload: <inner> }
 *   v2 wrapper  { x402Version: 2, payload: <inner>, resource, accepted: <requirement> }
 *   inner, permit2  { signature, permit2Authorization: { from, permitted: { token,
 *                     amount }, spender, deadline, witness: { to, validAfter } } }
 *   inner, eip3009  { signature, authorization: { from, to, value, validAfter,
 *                     validBefore, nonce } }
 *
 * FAILING CLOSED IS THE CALLER'S JOB, AND IT IS NOT OPTIONAL. `payer: null` or
 * `amount: null` means "this gateway cannot attribute or price that payment", so
 * the caller must refuse to forward it. Reading `amount` as 0 and running the
 * policy gate on 0 is how a relay ends up forwarding a payment of any size while
 * reporting that it checked the caps — and writing `0 MUSD` into an append-only
 * ledger that cannot be corrected.
 */
export function inspectPaymentHeader(value) {
  // Accept the raw value or the header map the client produced. Either way what
  // gets inspected is the payment itself, not the request body around it.
  let raw = value;
  if (raw && typeof raw === "object") {
    const h = paymentHeadersFrom(raw);
    raw = h.ok ? Object.values(h.headers)[0] : null;
  }
  if (!raw || typeof raw !== "string") {
    return { ok: false, error: "empty payment header" };
  }
  let decoded;
  try {
    decoded = decodePaymentSignatureHeader(raw);
  } catch (e) {
    return { ok: false, error: `payment header did not decode: ${e.message}` };
  }

  const inner = decoded?.payload || {};

  // EVM "exact" scheme, both versions: permit2 carries the payer in
  // permit2Authorization.from, eip3009 in authorization.from.
  const p2 = inner.permit2Authorization && typeof inner.permit2Authorization === "object"
    ? inner.permit2Authorization
    : null;
  const a3009 = inner.authorization && inner.authorization.from ? inner.authorization : null;

  // v2 keeps the negotiated requirement beside the payload; v1 keeps an ARRAY of
  // them — read as an object, every field comes back undefined, which is how this
  // function managed to return nulls for a well-formed v1 header too.
  const accepted = decoded?.accepted || null;
  const reqs = firstRequirement(decoded?.paymentRequirements) || firstRequirement(inner.paymentRequirements);

  const payer = p2?.from || a3009?.from || inner.payer || decoded?.payer || inner.authorization?.payer || null;
  const amount =
    accepted?.amount ?? p2?.permitted?.amount ?? a3009?.value ??
    reqs?.maxAmountRequired ?? reqs?.amount ?? null;

  return {
    ok: true,
    version: decoded?.x402Version ?? null,
    scheme: accepted?.scheme || decoded?.scheme || reqs?.scheme || null,
    network: accepted?.network || decoded?.network || reqs?.network || null,
    payer: payer ? String(payer) : null,
    payerFound: Boolean(payer),
    amount: amount === null || amount === undefined ? null : String(amount),
    asset: accepted?.asset || p2?.permitted?.token || reqs?.asset || null,
    payTo: accepted?.payTo || p2?.witness?.to || a3009?.to || reqs?.payTo || null,
    spender: p2?.spender || null,
    maxTimeoutSeconds: accepted?.maxTimeoutSeconds ?? reqs?.maxTimeoutSeconds ?? null,
    transferMethod:
      accepted?.extra?.assetTransferMethod || reqs?.extra?.assetTransferMethod ||
      (p2 ? "permit2" : a3009 ? "eip3009" : null),
  };
}

/** v1 carries an array of requirements; v2 carries one `accepted` object. */
function firstRequirement(v) {
  if (Array.isArray(v)) return v[0] || null;
  return v && typeof v === "object" ? v : null;
}
