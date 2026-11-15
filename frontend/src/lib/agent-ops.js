// frontend/src/lib/agent-ops.js
//
// Calls the gateway's session protected agent endpoints.
//
// ASSUMPTION worth checking: this reads the token through whatever getter
// session-token.js exports (getSessionToken or getToken) and sends it as a
// Bearer header. If your requireSession reads the token from somewhere else,
// the headers block below is the only place to change.

import * as tokenStore from "./session-token.js";

function readToken() {
  const getter = tokenStore.getSessionToken || tokenStore.getToken;
  return typeof getter === "function" ? getter() : null;
}

/**
 * Move MUSD from the agent wallet back to the connected wallet.
 * Only an amount is sent. The gateway decides the destination from the session.
 */
export async function retrieveFromAgent(amount) {
  const token = readToken();
  if (!token) throw new Error("No gateway session found. Sign out and sign in again.");

  const res = await fetch("/api/agent/retrieve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Session-Token": token,
    },
    body: JSON.stringify({ amount: String(amount) }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const base = data.error || `Retrieve failed (HTTP ${res.status})`;
    throw new Error(data.hint ? `${base}. ${data.hint}` : base);
  }
  return data;
}

/**
 * Pay for a paid endpoint with the signed in user's own agent wallet.
 * The gateway signs server side, so the session token is what authorizes this.
 *
 * Never throws for an HTTP error: the Spend page renders the gateway's own
 * refusal fields (blockedByPolicy, reasons, error) straight from the body.
 */
export async function payWithAgent(url) {
  const token = readToken();
  if (!token) {
    return { ok: false, paid: false, error: "No gateway session found. Sign out and sign in again." };
  }

  let res;
  try {
    res = await fetch("/api/pay", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Session-Token": token,
      },
      body: JSON.stringify({ url }),
    });
  } catch {
    return { ok: false, unreachable: true };
  }

  const data = await res.json().catch(() => ({}));
  return {
    ...data,
    ok: Boolean(data.ok),
    transportStatus: res.status,
    error: data.error || (res.ok ? undefined : `HTTP ${res.status}`),
  };
}

